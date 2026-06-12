import * as vscode from 'vscode';
import { assignmentPath, loadAssignment } from './assignment/assignmentLoader';
import { decryptAnswerKey, normalizeOutput, verifyProof } from './assignment/crypto';
import { AssignmentTextDocumentProvider } from './assignment/assignmentDocument';
import { createAssignmentScaffold } from './assignment/scaffold';
import type { Assignment, AssignmentCaseResult, AssignmentReportState } from './assignment/types';
import { ProcessingCompiler } from './compiler/processingCompiler';
import {
	compileCommand, controlsViewType, createAssignmentCommand, defaultOpenStateKey, editAssignmentCommand, exportWebsiteCommand, openApcsaReferenceCommand,
	openReferenceCommand, openReferenceSheetCommand, openTestReportCommand, runAssignmentTestsCommand, runCommand, stopCommand
} from './core/constants';
import type { BuildArtifact, BuildOutputKind, ExtensionController, ExtensionState, ProcessingOutputTarget } from './core/types';
import { WebsiteExporter } from './export/websiteExporter';
import { ProcessingLanguageService } from './java-lsp/processingLsp';
import { JavaRunner } from './runner/javaRunner';
import { ProcessingRuntimePanel, type RuntimeMessage } from './runner/processingRuntimePanel';
import {
	buildArtifactFileName, buildArtifactFileUri, collectSources, countLines,
	formatDuration, getWorkspaceFolder, hasSources, identifyEntrypoint,
	isBuildArtifactOutdated, isTempBuildArtifactOutdated, sourceVersions,
	statOrUndefined, stripExtension, type SourceKind
} from './utils';
import { ExtensionControlsProvider } from './views/controlsView';
import { AssignmentEditorPanel } from './views/assignmentEditor';
import { ProcessingReferencePanel } from './views/referencePanel';
import { AssignmentReportPanel } from './views/testReportView';

declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number): unknown;

export function activate(context: vscode.ExtensionContext): void {
	const extension = new Extension(context);
	context.subscriptions.push(extension);
}

class Extension implements vscode.Disposable, ExtensionController {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly output = vscode.window.createOutputChannel('Processing');
	private readonly compiler: ProcessingCompiler;
	private readonly controlsProvider: ExtensionControlsProvider;
	private readonly assignmentDocuments = new AssignmentTextDocumentProvider();
	private readonly websiteExporter: WebsiteExporter;
	private readonly javaRunner: JavaRunner;
	private readonly languageService: ProcessingLanguageService;
	private runtimePanel: ProcessingRuntimePanel | undefined;
	private referencePanel: ProcessingReferencePanel | undefined;
	private assignmentEditorPanel: AssignmentEditorPanel | undefined;
	private assignmentReportPanel: AssignmentReportPanel | undefined;
	private assignment: Assignment | undefined;
	private assignmentReport: AssignmentReportState = emptyAssignmentReport();
	private openedAssignmentScope: string | undefined;
	private mode: SourceKind = 'processing';
	private buildArtifact: BuildArtifact | undefined;
	private compiling = false;
	private running = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.compiler = new ProcessingCompiler(context.extensionUri, message => this.log(message));
		this.controlsProvider = new ExtensionControlsProvider(context.extensionUri, this);
		this.websiteExporter = new WebsiteExporter(context.extensionUri, this.compiler, extensionVersion(context), message => this.log(message));
		this.javaRunner = new JavaRunner(
			context.extensionUri,
			() => this.compiler.assetImportUri('compiler.wasm-runtime.js'),
			message => this.log(message),
			message => this.appendOutput(message),
			() => this.showOutput(),
			running => this.setRunning(running),
			() => this.refreshState()
		);
		this.languageService = new ProcessingLanguageService(context);

		this.disposables.push(this.output);
		this.disposables.push(this.languageService);
		this.disposables.push(this.javaRunner);
		this.disposables.push(vscode.workspace.registerTextDocumentContentProvider('webprocessing-assignment', this.assignmentDocuments));
		this.disposables.push(vscode.window.registerWebviewViewProvider(controlsViewType, this.controlsProvider, {
			webviewOptions: { retainContextWhenHidden: true }
		}));
		this.registerCommands();
		this.registerWorkspaceListeners();
		void this.refreshState();
		void this.openControlView();
	}

	dispose(): void {
		this.stop();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.runtimePanel?.dispose();
		this.referencePanel?.dispose();
		this.assignmentEditorPanel?.dispose();
		this.assignmentReportPanel?.dispose();
	}

	getState(): ExtensionState {
		return {
			mode: this.mode,
			processingOutput: this.getProcessingOutputTarget(),
			assignment_mode: !!this.assignment,
			hasSources: !!this.assignment || hasSources(this.mode),
			hasCompiled: !!this.buildArtifact,
			isCompiling: this.compiling,
			isRunning: this.running,
			isOutdated: !!this.buildArtifact?.outdated
		};
	}

	setMode(mode: SourceKind): void {
		if (this.assignment || this.mode === mode || this.compiling || this.running) {
			return;
		}
		this.mode = mode;
		this.buildArtifact = undefined;
		void this.refreshState();
	}

	async setProcessingOutput(output: ProcessingOutputTarget): Promise<void> {
		if (this.compiling || this.running) {
			return;
		}
		const normalized = output === 'wasm-gc' || output === 'js' ? output : 'auto';
		if (this.getProcessingOutputTarget() === normalized) {
			return;
		}
		const target = getWorkspaceFolder() ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
		await vscode.workspace.getConfiguration('webprocessing').update('processingOutput', normalized, target);
		await this.refreshState();
	}

	async compile(): Promise<void> {
		if (this.compiling || this.running) {
			return;
		}
		this.setCompiling(true);
		const startedAt = Date.now();

		this.showOutput();
		this.output.clear();
		this.log('\n==== BEGIN COMPILATION ====\n');
		this.log(`[compiler] Mode: ${this.mode}`);
		const processingOutput = this.getProcessingOutputTarget();
		this.log(`[compiler] Target configuration: ${this.mode === 'processing' ? this.describeProcessingOutputTarget(processingOutput) : 'WebAssembly (Wasm-GC)'}, fast global analysis enabled`);

		try {
			const artifact = await this.compileCurrentSources();
			this.buildArtifact = artifact;
			this.log(`\n==== BUILD SUCCEEDED in ${formatDuration(Date.now() - startedAt)} ====\n`);
			await this.refreshState();
		} catch (error) {
			this.logCompileError(error);
			this.log(`\n==== BUILD FAILED in ${formatDuration(Date.now() - startedAt)} ====\n`);
			void vscode.window.showErrorMessage(vscode.l10n.t('Processing compile failed. See the Processing output channel.'));
			await this.refreshState();
		} finally {
			this.setCompiling(false);
		}
	}

	async run(): Promise<void> {
		if (this.compiling || this.running) {
			return;
		}
		if (this.assignment) {
			return this.runAssignmentTests();
		}

		await this.refreshState();
		let artifact = this.buildArtifact;
		if (!artifact || artifact.mode !== this.mode) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Compile before running.'));
			await this.refreshState();
			return;
		}

		if (artifact.outdated) {
			await this.compile();
			await this.refreshState();
			artifact = this.buildArtifact;
			if (!artifact || artifact.mode !== this.mode || artifact.outdated) {
				return;
			}
		}

		if (this.mode === 'java') {
			return this.javaRunner.run(artifact);
		}

		await this.runProcessing(artifact);
	}

	stop(): void {
		this.runtimePanel?.stop();
		this.javaRunner.stop();
		this.setRunning(false);
	}

	async runAssignmentTests(): Promise<void> {
		if (this.compiling || this.running || !this.assignment) {
			return;
		}
		await this.refreshState();
		if (!this.assignment) {
			return;
		}
		this.assignmentReport = {
			assignment_mode: true,
			title: 'Test Case Report',
			running: true,
			unlocked: false,
			results: [],
			message: 'Running assignment tests...'
		};
		this.assignmentReportPanel?.update();
		this.showOutput();
		this.log('\n==== BEGIN ASSIGNMENT TESTS ====\n');

		try {
			let artifact = this.buildArtifact;
			if (!artifact || artifact.mode !== 'java' || artifact.outdated) {
				await this.compile();
				artifact = this.buildArtifact;
			}
			if (!artifact || artifact.mode !== 'java') {
				throw new Error('Assignment Java build artifact was not created.');
			}

			this.setRunning(true);
			const results: AssignmentCaseResult[] = [];
			const outputs = new Map<string, string>();
			for (const test of this.assignment.config.tests) {
				this.log(`[assignment] Running ${test.id}...`);
				const run = await this.javaRunner.runForOutput(artifact, test.input);
				const actual = run.stdout;
				outputs.set(test.id, actual);
				const expected = test.visibility === 'visible' ? test.expected_output : undefined;
				const passed = run.error
					? false
					: test.visibility === 'visible'
						? normalizeOutput(actual) === normalizeOutput(expected ?? '')
						: test.proof ? await verifyProof(actual, test.proof) : false;
				results.push({
					id: test.id,
					visibility: test.visibility,
					input: test.visibility === 'visible' || test.show_input ? test.input : undefined,
					expected_output: expected,
					actual_output: actual,
					passed,
					error: run.error || run.stderr || undefined,
					diff_available: typeof expected === 'string'
				});
			}

			const answerPayload = this.assignment.config.answer_key
				? await decryptAnswerKey(this.assignment.config.answer_key, this.assignment.config.tests, outputs)
				: undefined;
			const unlockedResults = answerPayload?.tests
				? results.map(result => {
					const expected_output = result.expected_output ?? answerPayload.tests?.[result.id]?.expected_output;
					return {
						...result,
						expected_output,
						diff_available: typeof expected_output === 'string'
					};
				})
				: results;
			const passedCount = unlockedResults.filter(result => result.passed).length;
			this.assignmentReport = {
				assignment_mode: true,
				title: 'Test Case Report',
				running: false,
				unlocked: !!answerPayload,
				results: unlockedResults,
				message: `${passedCount}/${unlockedResults.length} tests passed${answerPayload ? '; answer key unlocked.' : '.'}`
			};
			this.log(`\n==== ASSIGNMENT TESTS COMPLETE: ${passedCount}/${unlockedResults.length} passed ====\n`);
		} catch (error) {
			this.assignmentReport = {
				assignment_mode: true,
				title: 'Test Case Report',
				running: false,
				unlocked: false,
				results: [],
				message: `Assignment tests failed: ${error}`
			};
			this.log(`[assignment] ${error}`);
			void vscode.window.showErrorMessage(vscode.l10n.t('Assignment tests failed. See the Processing output channel.'));
		} finally {
			this.setRunning(false);
			this.assignmentReportPanel?.update();
			await this.refreshState();
		}
	}

	async openTestReport(): Promise<void> {
		if (!this.assignmentReportPanel) {
			this.assignmentReportPanel = new AssignmentReportPanel(this.context.extensionUri, this, () => {
				this.assignmentReportPanel = undefined;
			});
			return;
		}
		this.assignmentReportPanel.reveal();
	}

	async createAssignment(): Promise<void> {
		const workspaceFolder = getWorkspaceFolder();
		if (!workspaceFolder) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Open a folder before creating an assignment.'));
			return;
		}
		await createAssignmentScaffold(workspaceFolder);
		await this.refreshState();
		await this.openAssignmentWorkspace();
	}

	async editAssignment(): Promise<void> {
		if (!this.assignment) {
			void vscode.window.showWarningMessage(vscode.l10n.t('No autograded assignment is loaded.'));
			return;
		}
		if (!this.assignmentEditorPanel) {
			this.assignmentEditorPanel = new AssignmentEditorPanel(this.context.extensionUri, this.assignment.uri, async () => {
				await this.refreshState();
			}, () => {
				this.assignmentEditorPanel = undefined;
			});
		}
		await this.assignmentEditorPanel.open();
	}

	async openReference(): Promise<void> {
		await this.openReferencePanel('Processing Reference', 'https://processing.org/reference/');
	}

	async openApcsaReference(): Promise<void> {
		await this.openReferencePanel('APCSA Reference', vscode.Uri.joinPath(this.context.extensionUri, 'media', 'reference', 'ap-computer-science-a-java-quick-reference.pdf'));
	}

	async openReferenceSheet(): Promise<void> {
		const selected = await vscode.window.showQuickPick([
			{
				label: 'Processing Reference',
				open: () => this.openReference()
			},
			{
				label: 'APCSA Reference',
				open: () => this.openApcsaReference()
			}
		], {
			placeHolder: 'Open reference sheet'
		});
		await selected?.open();
	}

	private registerCommands(): void {
		this.disposables.push(vscode.commands.registerCommand(compileCommand, () => this.compile()));
		this.disposables.push(vscode.commands.registerCommand(runCommand, () => this.run()));
		this.disposables.push(vscode.commands.registerCommand(runAssignmentTestsCommand, () => this.runAssignmentTests()));
		this.disposables.push(vscode.commands.registerCommand(openTestReportCommand, () => this.openTestReport()));
		this.disposables.push(vscode.commands.registerCommand(createAssignmentCommand, () => this.createAssignment()));
		this.disposables.push(vscode.commands.registerCommand(editAssignmentCommand, () => this.editAssignment()));
		this.disposables.push(vscode.commands.registerCommand(stopCommand, () => this.stop()));
		this.disposables.push(vscode.commands.registerCommand(exportWebsiteCommand, () => this.exportWebsite()));
		this.disposables.push(vscode.commands.registerCommand(openReferenceCommand, () => this.openReference()));
		this.disposables.push(vscode.commands.registerCommand(openApcsaReferenceCommand, () => this.openApcsaReference()));
		this.disposables.push(vscode.commands.registerCommand(openReferenceSheetCommand, () => this.openReferenceSheet()));
	}

	private registerWorkspaceListeners(): void {
		this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshState()));
		this.disposables.push(vscode.workspace.onDidOpenTextDocument(() => this.refreshState()));
		this.disposables.push(vscode.workspace.onDidChangeTextDocument(() => this.refreshState()));
		this.disposables.push(vscode.workspace.onDidDeleteFiles(() => this.refreshState()));
		this.disposables.push(vscode.workspace.onDidCreateFiles(() => this.refreshState()));
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('webprocessing.processingOutput')) {
				void this.refreshState();
			}
		}));
	}

	private async refreshState(): Promise<void> {
		const workspaceFolder = getWorkspaceFolder();
		let assignmentErrorMessage: string | undefined;
		try {
			this.assignment = await loadAssignment(workspaceFolder);
		} catch (error) {
			this.assignment = undefined;
			assignmentErrorMessage = `Invalid assignment.json: ${error}`;
			this.assignmentReport = emptyAssignmentReport(assignmentErrorMessage);
		}
		if (this.assignment) {
			this.mode = 'java';
			this.assignmentReport = this.assignmentReport.assignment_mode ? this.assignmentReport : emptyAssignmentReport('No test results yet.', true);
			await this.openAssignmentWorkspace();
		} else {
			this.assignmentReport = emptyAssignmentReport(assignmentErrorMessage);
			this.openedAssignmentScope = undefined;
		}
		let buildArtifact: BuildArtifact | undefined;
		if (workspaceFolder) {
			const wasmUri = buildArtifactFileUri(workspaceFolder, 'wasm');
			const jsUri = buildArtifactFileUri(workspaceFolder, 'js');
			const [wasmStat, jsStat] = await Promise.all([statOrUndefined(wasmUri), statOrUndefined(jsUri)]);
			const output = this.resolveBuildArtifactOutput(wasmStat, jsStat);
			const stat = output === 'js' ? jsStat : wasmStat;
			if (output && stat) {
				const extension = output === 'js' ? 'js' : 'wasm';
				buildArtifact = {
					mode: this.mode,
					scope: workspaceFolder.uri.toString(),
					name: buildArtifactFileName(workspaceFolder, extension),
					output,
					uri: buildArtifactFileUri(workspaceFolder, extension),
					outdated: await isBuildArtifactOutdated(workspaceFolder, stat.mtime)
				};
			}
		} else if ((this.buildArtifact?.bytes || this.buildArtifact?.text) && this.buildArtifact.sourceVersions) {
			buildArtifact = {
				...this.buildArtifact,
				outdated: isTempBuildArtifactOutdated(this.buildArtifact.sourceVersions)
			};
		}

		this.buildArtifact = buildArtifact;
		await vscode.commands.executeCommand('setContext', 'webprocessing.hasCompiled', !!buildArtifact);
		await vscode.commands.executeCommand('setContext', 'webprocessing.isCompiling', this.compiling);
		await vscode.commands.executeCommand('setContext', 'webprocessing.isRunning', this.running);
		await vscode.commands.executeCommand('setContext', 'webprocessing.assignment_mode', !!this.assignment);
		this.controlsProvider.update();
		this.assignmentReportPanel?.update();
	}

	private async compileCurrentSources(): Promise<BuildArtifact> {
		this.log('\n[compiler] collecting source files...');
		const compileMode = this.assignment ? 'java' : this.mode;
		const collection = await collectSources(compileMode);
		const { sources } = collection;
		if (sources.length === 0) {
			throw new Error(`No ${compileMode === 'processing' ? '.pde' : '.java'} files were found.`);
		}

		for (const source of sources) {
			this.log(`[compiler] Found ${source.path} (${countLines(source.content)} lines, ${source.content.length} chars)`);
		}

		const workspaceFolder = collection.workspaceFolders[0];
		const entrypoint = this.assignment
			? sources.find(source => source.path === this.assignment?.config.entrypoint)
			: identifyEntrypoint(sources, workspaceFolder);
		if (!entrypoint && sources.length > 1) {
			throw new Error(this.assignment ? `Assignment entrypoint not found: ${this.assignment.config.entrypoint}` : 'Cannot determine program entrypoint for a multi-file project. Use foldername.pde, foldername.java, main.pde, or main.java.');
		}
		const mainSource = entrypoint ?? sources[0];
		this.log(`[compiler] Entrypoint: ${mainSource.path}`);

		const processingOutput = this.getProcessingOutputTarget();
		const targetFileName = workspaceFolder ? buildArtifactFileName(workspaceFolder) : `${stripExtension(mainSource.path ?? 'sketch')}.compiled.wasm`;
		const compiled = await this.compiler.compile(compileMode, sources, mainSource, targetFileName, processingOutput);
		const targetUri = workspaceFolder ? buildArtifactFileUri(workspaceFolder, compiled.output === 'js' ? 'js' : 'wasm') : undefined;

		if (targetUri && workspaceFolder) {
			const bytes = compiled.bytes ?? new TextEncoder().encode(compiled.text!);
			await vscode.workspace.fs.writeFile(targetUri, bytes);
			this.log(`[compiler] Wrote ${compiled.name} (${bytes.byteLength} bytes, ${compiled.output}).`);
			return {
				mode: compileMode,
				scope: workspaceFolder.uri.toString(),
				name: compiled.name,
				output: compiled.output,
				uri: targetUri,
				outdated: false
			};
		}

		const size = compiled.bytes?.byteLength ?? compiled.text?.length ?? 0;
		this.log(`[compiler] Stored ${compiled.name} in temporary memory (${size} ${compiled.bytes ? 'bytes' : 'chars'}, ${compiled.output}).`);
		return {
			mode: compileMode,
			scope: 'open-tabs',
			name: compiled.name,
			output: compiled.output,
			bytes: compiled.bytes,
			text: compiled.text,
			sourceVersions: sourceVersions(sources),
			outdated: false
		};
	}

	private async runProcessing(artifact: BuildArtifact): Promise<void> {
		this.showOutput();
		if (artifact.outdated) {
			this.log('[runtime] Warning: Running an outdated executable. The output may not include your latest saved or unsaved changes.');
		}
		this.log(`[runtime] Running ${artifact.name}...`);

		if (!this.runtimePanel || !this.runtimePanel.checkScope(artifact.scope)) {
			this.runtimePanel?.dispose();
			this.runtimePanel = new ProcessingRuntimePanel(this.context.extensionUri, artifact.scope, artifact.uri ? getWorkspaceFolder()?.uri : undefined, message => this.handleRuntimeMessage(message), () => {
				this.runtimePanel = undefined;
				this.setRunning(false);
			});
		}

		const output = artifact.output ?? 'wasm-gc';
		await this.runtimePanel.run(artifact.uri ? { output, uri: artifact.uri } : output === 'js' ? { output, text: artifact.text! } : { output, bytes: artifact.bytes! });
		this.setRunning(true);
		await this.refreshState();
	}

	async exportWebsite(): Promise<void> {
		if (this.compiling || this.running) {
			return;
		}
		this.setCompiling(true);
		this.showOutput();
		try {
			await this.websiteExporter.export();
		} catch (error) {
			this.logCompileError(error);
			void vscode.window.showErrorMessage(vscode.l10n.t('Website export failed. See the Processing output channel.'));
		} finally {
			this.setCompiling(false);
			await this.refreshState();
		}
	}

	private getProcessingOutputTarget(): ProcessingOutputTarget {
		return 'auto';
	}

	private resolveBuildArtifactOutput(wasmStat: vscode.FileStat | undefined, jsStat: vscode.FileStat | undefined): BuildOutputKind | undefined {
		if (this.mode === 'java') {
			return wasmStat ? 'wasm-gc' : undefined;
		}
		switch (this.getProcessingOutputTarget()) {
			case 'js':
				return jsStat ? 'js' : undefined;
			case 'wasm-gc':
				return wasmStat ? 'wasm-gc' : undefined;
			default:
				return jsStat && (!wasmStat || jsStat.mtime > wasmStat.mtime) ? 'js' : wasmStat ? 'wasm-gc' : undefined;
		}
	}

	private describeProcessingOutputTarget(output: ProcessingOutputTarget): string {
		switch (output) {
			case 'js':
				return 'JavaScript';
			case 'wasm-gc':
				return 'WebAssembly (Wasm-GC)';
			default:
				return 'Auto (Wasm-GC with JavaScript fallback)';
		}
	}

	private async openReferencePanel(title: string, source: string | vscode.Uri): Promise<void> {
		if (!this.referencePanel) {
			this.referencePanel = new ProcessingReferencePanel(this.context.extensionUri, () => {
				this.referencePanel = undefined;
			});
		}
		await this.referencePanel.open(title, source);
	}

	getAssignmentReportState(): AssignmentReportState {
		return this.assignment ? this.assignmentReport : emptyAssignmentReport();
	}

	async diffAssignmentTest(id: string): Promise<void> {
		const result = this.assignmentReport.results.find(result => result.id === id);
		if (!result || typeof result.expected_output !== 'string') {
			return;
		}
		const expectedUri = vscode.Uri.parse(`webprocessing-assignment:/${encodeURIComponent(id)}.expected.txt`);
		const actualUri = vscode.Uri.parse(`webprocessing-assignment:/${encodeURIComponent(id)}.actual.txt`);
		this.assignmentDocuments.set(expectedUri, result.expected_output);
		this.assignmentDocuments.set(actualUri, result.actual_output);
		await vscode.commands.executeCommand('vscode.diff', expectedUri, actualUri, `${id}: Expected ↔ Actual`);
	}

	private async openAssignmentWorkspace(): Promise<void> {
		if (!this.assignment) {
			this.openedAssignmentScope = undefined;
			return;
		}
		const scope = `${this.assignment.uri.toString()}@${this.assignment.config.student_code}@${this.assignment.config.instructions}`;
		if (this.openedAssignmentScope === scope) {
			return;
		}
		this.openedAssignmentScope = scope;
		await vscode.window.showTextDocument(assignmentPath(this.assignment, this.assignment.config.student_code), {
			viewColumn: vscode.ViewColumn.One,
			preview: false
		});
		await vscode.commands.executeCommand('markdown.showPreviewToSide', assignmentPath(this.assignment, this.assignment.config.instructions));
		await this.openTestReport();
	}

	private handleRuntimeMessage(message: RuntimeMessage): void {
		switch (message.type) {
			case 'stdout':
			case 'stderr':
				this.showOutput();
				this.appendOutput(message.text);
				break;
			case 'log-raw':
				this.showOutput();
				this.log(`${message.text}`);
				break;
			case 'started':
				this.showOutput();
				this.log('[runtime] Runtime started.\n');
				this.setRunning(true);
				break;
			case 'stopped':
				this.showOutput();
				this.log('[runtime] Runtime stopped.');
				this.setRunning(false);
				break;
		}
	}

	private logCompileError(error: unknown): void {
		if (hasIssues(error)) {
			for (const issue of error.issues) {
				this.log(`[compiler] ${issue.message}`);
			}
			return;
		}
		this.log(`[compiler] ${error}`);
	}

	private setCompiling(compiling: boolean): void {
		this.compiling = compiling;
		void vscode.commands.executeCommand('setContext', 'webprocessing.isCompiling', compiling);
		this.controlsProvider.update();
	}

	private setRunning(running: boolean): void {
		this.running = running;
		void vscode.commands.executeCommand('setContext', 'webprocessing.isRunning', running);
		this.controlsProvider.update();
	}

	private showOutput(): void {
		this.output.show(true);
	}

	private log(message = ''): void {
		this.output.appendLine(message);
	}

	private appendOutput(message = ''): void {
		this.output.append(message);
	}

	private async openControlView(): Promise<void> {
		if (this.context.globalState.get<boolean>(defaultOpenStateKey)) {
			return;
		}
		await this.context.globalState.update(defaultOpenStateKey, true);
		await new Promise(resolve => setTimeout(resolve, 500));
		await vscode.commands.executeCommand(`${controlsViewType}.focus`);
	}
}

function hasIssues(error: unknown): error is { readonly issues: readonly { readonly message: string }[] } {
	return typeof error === 'object' && error !== null && Array.isArray((error as { readonly issues?: unknown }).issues);
}

function extensionVersion(context: vscode.ExtensionContext): string {
	const packageJson = context.extension.packageJSON as { readonly version?: unknown };
	return typeof packageJson.version === 'string' ? packageJson.version : 'unknown version';
}

function emptyAssignmentReport(message = 'No autograded assignment is loaded.', assignment_mode = false): AssignmentReportState {
	return {
		assignment_mode,
		title: 'Test Case Report',
		running: false,
		unlocked: false,
		results: [],
		message
	};
}
