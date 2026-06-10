import * as vscode from 'vscode';
import { ProcessingCompiler } from './compiler/processingCompiler';
import {
	compileCommand, controlsViewType, defaultOpenStateKey, exportWebsiteCommand, openApcsaReferenceCommand,
	openReferenceCommand, openReferenceSheetCommand, runCommand, stopCommand
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
import { ProcessingReferencePanel } from './views/referencePanel';

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
	private readonly websiteExporter: WebsiteExporter;
	private readonly javaRunner: JavaRunner;
	private readonly languageService: ProcessingLanguageService;
	private runtimePanel: ProcessingRuntimePanel | undefined;
	private referencePanel: ProcessingReferencePanel | undefined;
	private mode: SourceKind = 'processing';
	private buildArtifact: BuildArtifact | undefined;
	private compiling = false;
	private running = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.compiler = new ProcessingCompiler(context.extensionUri, message => this.log(message));
		this.controlsProvider = new ExtensionControlsProvider(context.extensionUri, this);
		this.websiteExporter = new WebsiteExporter(context.extensionUri, this.compiler, () => this.getProcessingOutputTarget(), extensionVersion(context), message => this.log(message));
		this.javaRunner = new JavaRunner(
			context.extensionUri,
			() => this.compiler.assetImportUri('compiler.wasm-runtime.js'),
			message => this.log(message),
			() => this.showOutput(),
			running => this.setRunning(running),
			() => this.refreshState()
		);
		this.languageService = new ProcessingLanguageService(context);

		this.disposables.push(this.output);
		this.disposables.push(this.languageService);
		this.disposables.push(this.javaRunner);
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
	}

	getState(): ExtensionState {
		return {
			mode: this.mode,
			processingOutput: this.getProcessingOutputTarget(),
			hasSources: hasSources(this.mode),
			hasCompiled: !!this.buildArtifact,
			isCompiling: this.compiling,
			isRunning: this.running,
			isOutdated: !!this.buildArtifact?.outdated
		};
	}

	setMode(mode: SourceKind): void {
		if (this.mode === mode || this.compiling || this.running) {
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
		this.controlsProvider.update();
	}

	private async compileCurrentSources(): Promise<BuildArtifact> {
		this.log('\n[compiler] collecting source files...');
		const collection = await collectSources(this.mode);
		const { sources } = collection;
		if (sources.length === 0) {
			throw new Error(`No ${this.mode === 'processing' ? '.pde' : '.java'} files were found.`);
		}

		for (const source of sources) {
			this.log(`[compiler] Found ${source.path} (${countLines(source.content)} lines, ${source.content.length} chars)`);
		}

		const workspaceFolder = collection.workspaceFolders[0];
		const entrypoint = identifyEntrypoint(sources, workspaceFolder);
		if (!entrypoint && sources.length > 1) {
			throw new Error('Cannot determine program entrypoint for a multi-file project. Use foldername.pde, foldername.java, main.pde, or main.java.');
		}
		const mainSource = entrypoint ?? sources[0];
		this.log(`[compiler] Entrypoint: ${mainSource.path}`);

		const processingOutput = this.getProcessingOutputTarget();
		const targetFileName = workspaceFolder ? buildArtifactFileName(workspaceFolder) : `${stripExtension(mainSource.path ?? 'sketch')}.compiled.wasm`;
		const compiled = await this.compiler.compile(this.mode, sources, mainSource, targetFileName, processingOutput);
		const targetUri = workspaceFolder ? buildArtifactFileUri(workspaceFolder, compiled.output === 'js' ? 'js' : 'wasm') : undefined;

		if (targetUri && workspaceFolder) {
			const bytes = compiled.bytes ?? new TextEncoder().encode(compiled.text!);
			await vscode.workspace.fs.writeFile(targetUri, bytes);
			this.log(`[compiler] Wrote ${compiled.name} (${bytes.byteLength} bytes, ${compiled.output}).`);
			return {
				mode: this.mode,
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
			mode: this.mode,
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
		const configured = vscode.workspace.getConfiguration('webprocessing').get<string>('processingOutput', 'auto');
		return configured === 'wasm-gc' || configured === 'js' ? configured : 'auto';
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

	private handleRuntimeMessage(message: RuntimeMessage): void {
		switch (message.type) {
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
