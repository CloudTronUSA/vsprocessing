import * as vscode from 'vscode';
import { collectJavaSources, collectProcessingSources, compiledFileName, compiledFileUri, countLines, createNonce, escapeScriptJson, exists, formatDiagnostic, formatDuration, isCompiledOutdated, isInWorkspaceFolder, isJavaUri, isProcessingUri, identifyEntrypoint, statOrUndefined, stripExtension, stripWasmExtension, toJavaIdentifier, type WorkspaceSource } from './utils';

declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number): unknown;
declare function clearTimeout(handle: unknown): void;

const compileCommand = 'webprocessing.compile';
const runCommand = 'webprocessing.run';
const stopCommand = 'webprocessing.stop';
const controlsViewType = 'webprocessing.controls';
const runtimeViewType = 'webprocessing.runtime';
const defaultOpenStateKey = 'webprocessing.defaultOpen.v1';

type ProcessingModule = typeof import('../lib/teavm-javac/processing-teavm.js');

interface JdtWasmExports {
	readonly lint: (uri: string, source: string) => string;
	readonly lintProcessing: (entrypointUri: string, entrypointSource: string, additionalPdesJson: string) => string;
	readonly handle: (payload: string) => string;
}

interface JdtWasmInstance {
	readonly exports: JdtWasmExports;
}

interface JdtWasmGlobal {
	readonly TeaVM?: {
		readonly wasmGC?: {
			readonly load: (wasm: Uint8Array) => Promise<JdtWasmInstance>;
		};
	};
}

interface LspPosition {
	readonly line: number;
	readonly character: number;
}

interface LspDiagnostic {
	readonly range: {
		readonly start: LspPosition;
		readonly end: LspPosition;
	};
	readonly severity?: number;
	readonly source?: string;
	readonly code?: number | string;
	readonly message: string;
}

interface MappedLspDiagnostic extends LspDiagnostic {
	readonly uri?: string;
}

interface PublishDiagnosticsMessage {
	readonly method?: string;
	readonly params?: {
		readonly uri?: string;
		readonly diagnostics?: readonly LspDiagnostic[];
	};
}

interface CompiledState {
	readonly workspaceFolder: vscode.WorkspaceFolder;
	readonly uri: vscode.Uri;
	readonly mtime: number;	// last modified time
	readonly outdated: boolean;	// if the compiled file outdated?
}

interface ProcessingState {
	readonly hasWorkspace: boolean;
	readonly hasCompiled: boolean;	// has compiled file?
	readonly isCompiling: boolean;
	readonly isRunning: boolean;
	readonly isOutdated: boolean;
}

interface ProcessingControlsViewState extends ProcessingState {
	readonly status: string;
	readonly warning: string;
}

const importModule = new Function('specifier', 'return import(specifier);') as <T>(specifier: string) => Promise<T>;

export function activate(context: vscode.ExtensionContext): void {
	const extension = new ProcessingExtension(context);
	context.subscriptions.push(extension);
}

class ProcessingExtension implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly output = vscode.window.createOutputChannel('Processing');	// output channel
	private readonly controlsProvider: ProcessingControlsProvider;	// control panel
	private readonly linter: ProcessingLinter;
	private runtimePanel: ProcessingRuntimePanel | undefined;	// runtime panel
	private compilerModule: Promise<ProcessingModule> | undefined;
	private compiledState: CompiledState | undefined;
	private compiling = false;
	private running = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.controlsProvider = new ProcessingControlsProvider(this);
		this.linter = new ProcessingLinter(context);
		this.disposables.push(this.output);
		this.disposables.push(this.linter);
		this.disposables.push(vscode.window.registerWebviewViewProvider(controlsViewType, this.controlsProvider, {
			webviewOptions: { retainContextWhenHidden: true }
		}));
		// commands
		this.disposables.push(vscode.commands.registerCommand(compileCommand, () => this.compile()));
		this.disposables.push(vscode.commands.registerCommand(runCommand, () => this.run()));
		this.disposables.push(vscode.commands.registerCommand(stopCommand, () => this.stop()));
		// events
		this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshState()));
		this.disposables.push(vscode.workspace.onDidChangeTextDocument(event => {
			if (isProcessingUri(event.document.uri)) {
				void this.refreshState();
			}
		}));
		this.disposables.push(vscode.workspace.onDidSaveTextDocument(() => this.refreshState()));
		this.disposables.push(vscode.workspace.onDidDeleteFiles(() => this.refreshState()));
		this.disposables.push(vscode.workspace.onDidCreateFiles(() => this.refreshState()));
		void this.refreshState();
		void this.openControlView();
	}

	dispose(): void {
		this.stop();
		// kill all evilness
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.runtimePanel?.dispose();
	}

	getState(): ProcessingState {
		return {
			hasWorkspace: !!this.getWorkspaceFolder(),
			hasCompiled: !!this.compiledState,
			isCompiling: this.compiling,
			isRunning: this.running,
			isOutdated: !!this.compiledState?.outdated
		};
	}

	private async refreshState(): Promise<void> {
		const workspaceFolder = this.getWorkspaceFolder();
		let compiledState: CompiledState | undefined;
		if (workspaceFolder) {
			// see if the compiled file exists and if it's outdated
			const uri = compiledFileUri(workspaceFolder);
			const stat = await statOrUndefined(uri);
			if (stat) {
				compiledState = {
					workspaceFolder,
					uri,
					mtime: stat.mtime,
					outdated: await isCompiledOutdated(workspaceFolder, stat.mtime)
				};
			}
		}

		this.compiledState = compiledState;
		await vscode.commands.executeCommand('setContext', 'webprocessing.hasCompiled', !!compiledState);
		await vscode.commands.executeCommand('setContext', 'webprocessing.isCompiling', this.compiling);
		await vscode.commands.executeCommand('setContext', 'webprocessing.isRunning', this.running);
		this.controlsProvider.update();
	}

	private getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
		return vscode.workspace.workspaceFolders?.[0];
	}

	private showOutput(): void {
		this.output.show(true);
	}

	private log(message = ''): void {
		this.output.appendLine(message);
	}

	// open the control panel (on first activation)
	private async openControlView(): Promise<void> {
		if (this.context.globalState.get<boolean>(defaultOpenStateKey)) {
			return;
		}
		await this.context.globalState.update(defaultOpenStateKey, true);
		await new Promise(resolve => setTimeout(resolve, 500));
		await vscode.commands.executeCommand(`${controlsViewType}.focus`);
	}

	async compile(): Promise<void> {
		if (this.compiling || this.running) {
			return;
		}

		const workspaceFolder = this.getWorkspaceFolder();
		if (!workspaceFolder) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Open a folder before compiling a Processing sketch.'));
			return;
		}

		const startedAt = Date.now();
		const targetUri = compiledFileUri(workspaceFolder);
		const targetFileName = compiledFileName(workspaceFolder);
		this.setCompiling(true);
		this.showOutput();
		this.output.clear();
		this.log('\n==== Begin compilation ====\n');
		this.log(`[processing.compiler] Workspace: ${workspaceFolder.uri.toString()}`);
		this.log(`[processing.compiler] Target: ${targetUri.toString()}`);
		this.log('[processing.compiler] Target configuration: type=WebAssembly (Wasm-GC), backend=canvas2d, fast global analysis enabled');

		try {
			// collect
			this.log('\n[processing.compiler] collecting .pde files...');
			const sources = await collectProcessingSources(workspaceFolder.uri);
			if (sources.length === 0) {
				throw new Error('No .pde files were found in the workspace folder.');
			}

			for (const source of sources) {
				this.log(`[processing.compiler] Found ${source.path} (${countLines(source.content)} lines, ${source.content.length} chars)`);
			}

			const entrypoint = identifyEntrypoint(sources, workspaceFolder);
			if (!entrypoint && sources.length > 1) {
				throw new Error(`Cannot determine Processing entrypoint for a multi-file project. Please put your program's entrypoint in ${workspaceFolder.name}.pde or main.pde.`);
			}
			const mainSource = entrypoint ?? sources[0];
			this.log(`[processing.compiler] Entrypoint: ${mainSource.path}`);

			// compile
			this.log('\n[processing.compiler] Loading TeaVM Java compiler...');
			const processing = await this.loadCompilerModule();
			const core = await this.readAsset('processing-core-teavm.jar');

			this.log('[processing.compiler] Compiling code...');
			const generated = await processing.generateProcessingSketch(sources, {
				core,
				sketchName: toJavaIdentifier(stripExtension(mainSource.path ?? 'Sketch'), 'Sketch'),
				sourceMaps: false,
				target: 'webassembly',
				output: 'webassembly',
				backend: 'canvas2d',
				optimizationLevel: 'simple',
				fastGlobalAnalysis: true,
				worker: false,
				wasmOutputName: stripWasmExtension(targetFileName),
				compilerOptions: {
					compilerWasmUrl: this.assetUri('compiler.wasm').toString(),
					compilerWasmRuntimeUrl: this.assetImportUri('compiler.wasm-runtime.js'),
					javacClasslibUrl: this.assetUri('compile-classlib-teavm.bin').toString(),
					runtimeClasslibUrl: this.assetUri('runtime-classlib-teavm.bin').toString(),
					fallbackToJs: false
				},
				onDiagnostic: diagnostic => {
					this.log(formatDiagnostic(diagnostic));
				}
			});

			if (generated.output !== 'wasm-gc' || !generated.wasmBytes) {
				throw new Error('TeaVM did not produce a valid WebAssembly output.');
			}

			this.log(`[processing.compiler] Compilation complete.`);
			await vscode.workspace.fs.writeFile(targetUri, generated.wasmBytes);
			const stat = await vscode.workspace.fs.stat(targetUri);
			this.compiledState = { workspaceFolder, uri: targetUri, mtime: stat.mtime, outdated: false };

			this.log(`[processing.compiler] Wrote ${targetFileName} (${generated.wasmBytes.byteLength} bytes).`);
			this.log(`\n==== Compilation succeeded in ${formatDuration(Date.now() - startedAt)} ====\n`);
			await this.refreshState();
		} catch (error) {
			// check if error.issues is exists, then list
			if (error.issues) {
				for (const issue of error.issues) {
					this.log(`[processing.compiler] ${issue.message}`);
				}
			} else {
				this.log(`[processing.compiler] ${error}`);
			}

			this.log(`\n==== Compilation failed in ${formatDuration(Date.now() - startedAt)} ====\n`);
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

		const workspaceFolder = this.getWorkspaceFolder();
		if (!workspaceFolder) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Open a folder before running a Processing sketch.'));
			return;
		}

		const compiledUri = compiledFileUri(workspaceFolder);
		const targetFileName = compiledFileName(workspaceFolder);
		if (!await exists(compiledUri)) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Compile the Processing sketch before running it.'));
			await this.refreshState();
			return;
		}

		this.showOutput();
		await this.refreshState();
		if (this.compiledState?.outdated) {
			this.log('[processing.runtime] Warning: Running an outdated executable. The output may not include your latest saved or unsaved changes.');
		}
		this.log(`[processing.runtime] Running ${targetFileName}...`);

		// if there's no runtime panel or the current one is not for the workspace folder, create a new one
		if (!this.runtimePanel || !this.runtimePanel.checkWorkspace(workspaceFolder.uri)) {
			this.runtimePanel?.dispose();
			this.runtimePanel = new ProcessingRuntimePanel(this.context.extensionUri, workspaceFolder.uri, message => this.handleRuntimeMessage(message), () => {
				this.runtimePanel = undefined;
				this.setRunning(false);
			});
		}

		this.runtimePanel.run(compiledUri);
		this.setRunning(true);
		await this.refreshState();
	}

	stop(): void {
		this.runtimePanel?.stop();
		this.setRunning(false);
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

	private handleRuntimeMessage(message: RuntimeMessage): void {
		switch (message.type) {
			case 'log-raw':
				this.showOutput();
				this.log(`${message.text}`);
				break;
			case 'started':
				this.showOutput();
				this.log('[processing.runtime] Runtime started.\n');
				this.setRunning(true);
				break;
			case 'stopped':
				this.showOutput();
				this.log('[processing.runtime] Runtime stopped.');
				this.setRunning(false);
				break;
		}
	}

	private async loadCompilerModule(): Promise<ProcessingModule> {
		if (!this.compilerModule) {
			this.compilerModule = importModule<ProcessingModule>(this.assetImportUri('processing-teavm.js'));
		}
		return this.compilerModule;
	}

	private async readAsset(name: string): Promise<Uint8Array> {
		return vscode.workspace.fs.readFile(this.assetUri(name));
	}

	private assetUri(name: string): vscode.Uri {
		return vscode.Uri.joinPath(this.context.extensionUri, 'lib', 'teavm-javac', name);
	}

	private assetImportUri(name: string): string {
		return this.assetUri(name).toString();
	}
}

class ProcessingLinter implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly diagnostics = vscode.languages.createDiagnosticCollection('webprocessing');
	private jdtWasm: Promise<JdtWasmExports> | undefined;
	private lintTimer: unknown;
	private linting = false;
	private pendingJava = false;
	private pendingProcessing = false;
	private readonly javaUris = new Set<string>();
	private readonly processingUris = new Set<string>();

	constructor(private readonly context: vscode.ExtensionContext) {
		this.disposables.push(this.diagnostics);
		this.disposables.push(vscode.workspace.onDidOpenTextDocument(document => this.scheduleDocument(document)));
		this.disposables.push(vscode.workspace.onDidChangeTextDocument(event => this.scheduleDocument(event.document)));
		this.disposables.push(vscode.workspace.onDidSaveTextDocument(document => this.scheduleDocument(document)));
		this.disposables.push(vscode.workspace.onDidCloseTextDocument(document => this.clearClosedDocument(document)));
		this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleAll()));
		this.disposables.push(vscode.workspace.onDidCreateFiles(() => this.scheduleAll()));
		this.disposables.push(vscode.workspace.onDidDeleteFiles(() => this.scheduleAll()));
		this.disposables.push(vscode.workspace.onDidRenameFiles(() => this.scheduleAll()));
		this.scheduleAll();
	}

	dispose(): void {
		if (this.lintTimer) {
			clearTimeout(this.lintTimer);
			this.lintTimer = undefined;
		}
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private scheduleDocument(document: vscode.TextDocument): void {
		if (isJavaUri(document.uri)) {
			this.scheduleJava();
		} else if (isProcessingUri(document.uri)) {
			this.scheduleProcessing();
		}
	}

	private clearClosedDocument(document: vscode.TextDocument): void {
		if (!isJavaUri(document.uri) && !isProcessingUri(document.uri)) {
			return;
		}
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
		if (!workspaceFolder) {
			this.diagnostics.delete(document.uri);
		}
	}

	private scheduleAll(): void {
		this.pendingJava = true;
		this.pendingProcessing = true;
		this.schedule();
	}

	private scheduleJava(): void {
		this.pendingJava = true;
		this.schedule();
	}

	private scheduleProcessing(): void {
		this.pendingProcessing = true;
		this.schedule();
	}

	private schedule(): void {
		if (this.lintTimer) {
			clearTimeout(this.lintTimer);
		}
		this.lintTimer = setTimeout(() => {
			this.lintTimer = undefined;
			void this.runPendingLint();
		}, 250);
	}

	private async runPendingLint(): Promise<void> {
		if (this.linting) {
			this.schedule();
			return;
		}

		const lintJava = this.pendingJava;
		const lintProcessing = this.pendingProcessing;
		this.pendingJava = false;
		this.pendingProcessing = false;
		this.linting = true;

		try {
			if (lintJava) {
				await this.lintJava();
			}
			if (lintProcessing) {
				await this.lintProcessing();
			}
		} catch (error) {
			console.error(error);
		} finally {
			this.linting = false;
			if (this.pendingJava || this.pendingProcessing) {
				this.schedule();
			}
		}
	}

	private async lintJava(): Promise<void> {
		const sources = await this.collectJavaWorkspaceSources();
		const currentUris = new Set(sources.map(source => source.uri.toString()));
		let lastMessages: readonly PublishDiagnosticsMessage[] = [];
		const jdt = sources.length > 0 || this.javaUris.size > 0 ? await this.loadJdtWasm() : undefined;

		for (const uri of this.javaUris) {
			if (jdt && !currentUris.has(uri)) {
				lastMessages = this.parseMessages(jdt.handle(JSON.stringify({
					jsonrpc: '2.0',
					method: 'java/browserJdtLs/removeWorkspaceSource',
					params: { uri }
				})));
				this.diagnostics.delete(vscode.Uri.parse(uri));
			}
		}
		if (!jdt) {
			return;
		}

		for (const source of sources) {
			lastMessages = this.parseMessages(jdt.handle(JSON.stringify({
				jsonrpc: '2.0',
				method: 'java/browserJdtLs/workspaceSources',
				params: {
					uri: source.uri.toString(),
					text: source.content
				}
			})));
		}

		if (sources.length === 0) {
			for (const uri of this.javaUris) {
				this.diagnostics.delete(vscode.Uri.parse(uri));
			}
		} else {
			this.applyPublishDiagnostics(lastMessages);
		}
		this.javaUris.clear();
		for (const uri of currentUris) {
			this.javaUris.add(uri);
		}
	}

	private async lintProcessing(): Promise<void> {
		const currentUris = new Set<string>();
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		let jdt: JdtWasmExports | undefined;
		for (const workspaceFolder of workspaceFolders) {
			const sources = await this.collectProcessingWorkspaceSources(workspaceFolder);
			for (const source of sources) {
				currentUris.add(source.uri.toString());
			}
			if (sources.length === 0) {
				continue;
			}

			const entrypoint = identifyEntrypoint(sources, workspaceFolder);
			if (!entrypoint && sources.length > 1) {
				this.setEntrypointDiagnostics(workspaceFolder, sources);
				continue;
			}

			const mainSource = entrypoint ? sources.find(source => source.path === entrypoint.path) ?? sources[0] : sources[0];
			const additionalSources = sources
				.filter(source => source.uri.toString() !== mainSource.uri.toString())
				.map(source => ({ uri: source.uri.toString(), text: source.content }));
			jdt ??= await this.loadJdtWasm();
			const diagnostics = this.parseDiagnostics(jdt.lintProcessing(mainSource.uri.toString(), mainSource.content, JSON.stringify({ sources: additionalSources })));
			this.setMappedDiagnostics(sources, diagnostics);
		}

		for (const uri of this.processingUris) {
			if (!currentUris.has(uri)) {
				this.diagnostics.delete(vscode.Uri.parse(uri));
			}
		}
		this.processingUris.clear();
		for (const uri of currentUris) {
			this.processingUris.add(uri);
		}
	}

	private async collectJavaWorkspaceSources(): Promise<WorkspaceSource[]> {
		const sources: WorkspaceSource[] = [];
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		for (const workspaceFolder of workspaceFolders) {
			sources.push(...await collectJavaSources(workspaceFolder.uri));
		}

		for (const document of vscode.workspace.textDocuments) {
			if (!isJavaUri(document.uri)) {
				continue;
			}
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
			if (!workspaceFolder && workspaceFolders.length > 0) {
				continue;
			}
			this.upsertSource(sources, {
				uri: document.uri,
				path: document.uri.path.split('/').pop() ?? document.uri.path,
				content: document.getText()
			});
		}

		return sources;
	}

	private async collectProcessingWorkspaceSources(workspaceFolder: vscode.WorkspaceFolder): Promise<WorkspaceSource[]> {
		const sources = (await collectProcessingSources(workspaceFolder.uri)).map(source => ({
			uri: vscode.Uri.joinPath(workspaceFolder.uri, source.path ?? ''),
			path: source.path ?? '',
			content: source.content
		}));

		for (const document of vscode.workspace.textDocuments) {
			if (isProcessingUri(document.uri) && isInWorkspaceFolder(document.uri, workspaceFolder)) {
				this.upsertSource(sources, {
					uri: document.uri,
					path: this.relativePath(document.uri, workspaceFolder),
					content: document.getText()
				});
			}
		}

		return sources;
	}

	private upsertSource(sources: WorkspaceSource[], source: WorkspaceSource): void {
		const uri = source.uri.toString();
		const index = sources.findIndex(candidate => candidate.uri.toString() === uri);
		if (index >= 0) {
			sources[index] = source;
		} else {
			sources.push(source);
		}
	}

	private relativePath(uri: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder): string {
		const folderPath = workspaceFolder.uri.path.endsWith('/') ? workspaceFolder.uri.path : `${workspaceFolder.uri.path}/`;
		return uri.path.startsWith(folderPath) ? uri.path.slice(folderPath.length) : uri.path.split('/').pop() ?? uri.path;
	}

	private setEntrypointDiagnostics(workspaceFolder: vscode.WorkspaceFolder, sources: readonly WorkspaceSource[]): void {
		const message = `Cannot determine Processing entrypoint for a multi-file project. Put the sketch entrypoint in ${workspaceFolder.name}.pde or main.pde.`;
		for (const source of sources) {
			const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), message, vscode.DiagnosticSeverity.Error);
			diagnostic.source = 'Processing';
			this.diagnostics.set(source.uri, [diagnostic]);
		}
	}

	private setMappedDiagnostics(sources: readonly WorkspaceSource[], diagnostics: readonly MappedLspDiagnostic[]): void {
		const grouped = new Map<string, vscode.Diagnostic[]>();
		for (const source of sources) {
			grouped.set(source.uri.toString(), []);
		}
		for (const diagnostic of diagnostics) {
			if (!diagnostic.uri) {
				continue;
			}
			const uriDiagnostics = grouped.get(diagnostic.uri) ?? [];
			uriDiagnostics.push(this.toDiagnostic(diagnostic));
			grouped.set(diagnostic.uri, uriDiagnostics);
		}
		for (const [uri, uriDiagnostics] of grouped) {
			this.diagnostics.set(vscode.Uri.parse(uri), uriDiagnostics);
		}
	}

	private applyPublishDiagnostics(messages: readonly PublishDiagnosticsMessage[]): void {
		for (const message of messages) {
			if (message.method !== 'textDocument/publishDiagnostics' || !message.params?.uri) {
				continue;
			}
			this.diagnostics.set(vscode.Uri.parse(message.params.uri), (message.params.diagnostics ?? []).map(diagnostic => this.toDiagnostic(diagnostic)));
		}
	}

	private toDiagnostic(diagnostic: LspDiagnostic): vscode.Diagnostic {
		const result = new vscode.Diagnostic(
			new vscode.Range(
				diagnostic.range.start.line,
				diagnostic.range.start.character,
				diagnostic.range.end.line,
				diagnostic.range.end.character
			),
			diagnostic.message,
			this.toSeverity(diagnostic.severity)
		);
		result.source = diagnostic.source ?? 'Java';
		result.code = diagnostic.code;
		return result;
	}

	private toSeverity(severity: number | undefined): vscode.DiagnosticSeverity {
		switch (severity) {
			case 2:
				return vscode.DiagnosticSeverity.Warning;
			case 3:
				return vscode.DiagnosticSeverity.Information;
			case 4:
				return vscode.DiagnosticSeverity.Hint;
			default:
				return vscode.DiagnosticSeverity.Error;
		}
	}

	private parseDiagnostics(payload: string): readonly MappedLspDiagnostic[] {
		if (!payload) {
			return [];
		}
		const parsed = JSON.parse(payload);
		return Array.isArray(parsed) ? parsed : [];
	}

	private parseMessages(payload: string): readonly PublishDiagnosticsMessage[] {
		if (!payload) {
			return [];
		}
		const parsed = JSON.parse(payload);
		return Array.isArray(parsed) ? parsed : [parsed];
	}

	private async loadJdtWasm(): Promise<JdtWasmExports> {
		if (!this.jdtWasm) {
			this.jdtWasm = this.doLoadJdtWasm();
		}
		return this.jdtWasm;
	}

	private async doLoadJdtWasm(): Promise<JdtWasmExports> {
		await importModule(this.jdtAssetImportUri('classes.wasm-runtime.js'));
		const teavm = (globalThis as unknown as JdtWasmGlobal).TeaVM?.wasmGC;
		if (!teavm) {
			throw new Error('TeaVM Wasm-GC runtime is unavailable.');
		}
		const instance = await teavm.load(await vscode.workspace.fs.readFile(this.jdtAssetUri('classes.wasm')));
		return instance.exports;
	}

	private jdtAssetUri(name: string): vscode.Uri {
		return vscode.Uri.joinPath(this.context.extensionUri, 'lib', 'eclipse.jdt.ls-wasm', name);
	}

	private jdtAssetImportUri(name: string): string {
		return this.jdtAssetUri(name).toString();
	}
}

type ProcessingControlsMessage =
	| { readonly type: 'compile' }
	| { readonly type: 'run' }
	| { readonly type: 'stop' };

// stuff in left side bar
class ProcessingControlsProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	constructor(private readonly controller: ProcessingExtension) { }

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.getHtml(this.getViewState());
		webviewView.webview.onDidReceiveMessage(message => this.handleMessage(message));
	}

	update(): void {
		void this.view?.webview.postMessage({ type: 'state', state: this.getViewState() });
	}

	private handleMessage(message: ProcessingControlsMessage): void {
		switch (message.type) {
			case 'compile':
				void this.controller.compile();
				break;
			case 'run':
				void this.controller.run();
				break;
			case 'stop':
				this.controller.stop();
				break;
		}
	}

	private getViewState(): ProcessingControlsViewState {
		const state = this.controller.getState();
		const status = !state.hasWorkspace
			? 'Open a folder to use Processing.'
			: state.isCompiling
				? 'Compiling sketch...'
				: state.isRunning
					? 'Running sketch...'
					: state.hasCompiled
						? 'Ready to run.'
						: 'Compile a sketch to create a WebAssembly executable.';
		return {
			...state,
			status,
			warning: state.hasCompiled && state.isOutdated ? 'Warning: outdated executable.' : '',
		};
	}

	// generate the HTML content for the control panel
	private getHtml(state: ProcessingControlsViewState): string {
		const nonce = createNonce();
		const initialState = escapeScriptJson(JSON.stringify(state));
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		html, body {
			margin: 0;
			padding: 0;
			background: transparent;
			color: var(--vscode-foreground);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
		}
		.controls {
			box-sizing: border-box;
			display: flex;
			flex-direction: column;
			gap: 6px;
			padding: 8px 12px 10px;
		}
		button {
			box-sizing: border-box;
			width: 100%;
			min-height: 28px;
			border: 1px solid var(--vscode-button-border, transparent);
			border-radius: 2px;
			padding: 4px 10px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			font: inherit;
			text-align: center;
			cursor: pointer;
		}
		button:hover:not(:disabled) {
			background: var(--vscode-button-hoverBackground);
		}
		button:focus-visible {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: 2px;
		}
		button.secondary {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		button.secondary:hover:not(:disabled) {
			background: var(--vscode-button-secondaryHoverBackground);
		}
		button:disabled {
			opacity: 0.45;
			cursor: default;
		}
		.status, .warning {
			margin-top: 4px;
			color: var(--vscode-descriptionForeground);
			font-size: 11px;
			line-height: 1.35;
		}
		.warning {
			color: var(--vscode-editorWarning-foreground);
		}
	</style>
</head>
<body>
	<div class="controls">
		<button id="compile" type="button">Compile</button>
		<button id="run" type="button">Run</button>
		<button id="stop" class="secondary" type="button">Stop</button>
		<div id="status" class="status"></div>
		<div id="warning" class="warning"></div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const state = JSON.parse("${initialState}");
		const buttons = {
			compile: document.getElementById('compile'),
			run: document.getElementById('run'),
			stop: document.getElementById('stop')
		};
		const status = document.getElementById('status');
		const warning = document.getElementById('warning');
		function applyState(next) {
			Object.assign(state, next);
			buttons.compile.disabled = !state.hasWorkspace || state.isCompiling || state.isRunning;
			buttons.run.disabled = !state.hasWorkspace || !state.hasCompiled || state.isCompiling || state.isRunning;
			buttons.stop.disabled = !state.isRunning;
			status.textContent = state.status || '';
			warning.textContent = state.warning || '';
			warning.hidden = !state.warning;
		}
		buttons.compile.addEventListener('click', () => vscode.postMessage({ type: 'compile' }));
		buttons.run.addEventListener('click', () => vscode.postMessage({ type: 'run' }));
		buttons.stop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
		window.addEventListener('message', event => {
			if (event.data?.type === 'state') {
				applyState(event.data.state);
			}
		});
		applyState(state);
	</script>
</body>
</html>`;
	}
}

type RuntimeMessage =
	| { readonly type: 'log-raw'; readonly text: string }
	| { readonly type: 'started' }
	| { readonly type: 'stopped' };

// a panel to show execution outcome
class ProcessingRuntimePanel implements vscode.Disposable {
	private readonly panel: vscode.WebviewPanel;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly workspaceUri: vscode.Uri,
		private readonly onMessage: (message: RuntimeMessage) => void,
		onDispose: () => void
	) {
		this.panel = vscode.window.createWebviewPanel(runtimeViewType, 'Processing Runtime', vscode.ViewColumn.Beside, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'lib', 'teavm-javac'), workspaceUri]
		});
		this.panel.webview.onDidReceiveMessage(message => this.onMessage(message));
		this.panel.onDidDispose(onDispose);
	}

	checkWorkspace(workspaceUri: vscode.Uri): boolean {
		return this.workspaceUri.toString() === workspaceUri.toString();
	}

	dispose(): void {
		this.panel.dispose();
	}

	run(wasmUri: vscode.Uri): void {	// fill in the webview to run the sketch
		this.panel.reveal(vscode.ViewColumn.Beside);
		this.panel.webview.html = this.getHtml(wasmUri);
	}

	stop(): void {	// tell the runner inside of webview to shut
		this.panel.webview.postMessage({ type: 'stop' });
	}

	// generate the HTML content for the runtime panel
	private getHtml(wasmUri: vscode.Uri): string {
		const nonce = createNonce();
		const payload = escapeScriptJson(JSON.stringify({
			wasmUri: this.panel.webview.asWebviewUri(wasmUri).toString(),
			wasmRuntimeUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'lib', 'teavm-javac', 'compiler.wasm-runtime.js')).toString(),
			processingUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'lib', 'teavm-javac', 'processing-teavm.js')).toString()
		}));
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval' ${this.panel.webview.cspSource}; connect-src ${this.panel.webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		html, body { height: 100%; margin: 0; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
		#root { height: 100%; display: grid; grid-template-rows: 1fr auto; }
		#sketch { min-height: 0; display: grid; place-items: center; overflow: hidden; }
		#status { border-top: 1px solid var(--vscode-panel-border); padding: 6px 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
		canvas { display: block; outline: 1px solid var(--vscode-panel-border); }
	</style>
</head>
<body>
	<div id="root">
		<div id="sketch"></div>
		<div id="status">Starting...</div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const payload = JSON.parse("${payload}");
		const sketch = document.getElementById('sketch');
		const status = document.getElementById('status');
		let generation = 0;
		let canvasBackend;
		let wasmRuntime;
		let sketchInstance;
		let canvasObserver;

		const send = message => vscode.postMessage(message);
		const format = value => {
			if (typeof value === 'string') return value;
			if (value instanceof Error) return value.stack || value.message;
			try { return JSON.stringify(value); } catch { return String(value); }
		};
		for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
			const original = console[level].bind(console);
			console[level] = (...values) => {
				send({ type: 'log-raw', text: values.map(format).join(' ') });
				original(...values);
			};
		}
		window.onerror = (message, source, line, column, error) => {
			send({ type: 'log-raw', text: error?.stack || String(message) + ' at ' + source + ':' + line + ':' + column });
		};
		window.onunhandledrejection = event => {
			send({ type: 'log-raw', text: format(event.reason) });
		};
		window.addEventListener('message', event => {
			if (event.data?.type === 'stop') {
				stop();
			}
		});
		window.addEventListener('resize', fitCanvas);

		function stop() {
			generation++;
			clearRuntime();
			status.textContent = 'Stopped.';
			send({ type: 'stopped' });
		}

		function clearRuntime() {
			try {
				sketchInstance?.dispose?.();
				sketchInstance?.destroy?.();
				sketchInstance?.stop?.();
				canvasBackend?.noLoop?.();
			} catch (error) {
				console.warn(error);
			}
			sketchInstance = undefined;
			canvasBackend = undefined;
			wasmRuntime = undefined;
			canvasObserver?.disconnect();
			canvasObserver = undefined;
			sketch.replaceChildren();
		}

		function fitCanvas() {
			const canvas = sketch.querySelector('canvas');
			if (!canvas) {
				return;
			}
			const sourceWidth = canvas.width || canvas.clientWidth;
			const sourceHeight = canvas.height || canvas.clientHeight;
			const targetWidth = sketch.clientWidth;
			const targetHeight = sketch.clientHeight;
			if (!sourceWidth || !sourceHeight || !targetWidth || !targetHeight) {
				return;
			}
			const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
			canvas.style.width = Math.max(1, Math.floor(sourceWidth * scale)) + 'px';
			canvas.style.height = Math.max(1, Math.floor(sourceHeight * scale)) + 'px';
		}

		function watchCanvasSize() {
			canvasObserver?.disconnect();
			canvasObserver = new MutationObserver(() => fitCanvas());
			canvasObserver.observe(sketch, { childList: true, subtree: true, attributes: true, attributeFilter: ['width', 'height', 'style'] });
			fitCanvas();
			requestAnimationFrame(fitCanvas);
		}

		async function run() {
			stop();
			const current = ++generation;
			status.textContent = 'Running...';
			const [runtimeModule, processingModule, wasmResponse] = await Promise.all([
				import(payload.wasmRuntimeUri),
				import(payload.processingUri),
				fetch(payload.wasmUri)
			]);
			if (current !== generation) return;
			if (!wasmResponse.ok) {
				throw new Error('Failed to load compiled WebAssembly: HTTP ' + wasmResponse.status);
			}
			if (typeof runtimeModule.load !== 'function') {
				throw new Error('TeaVM Wasm-GC runtime loader did not export load().');
			}
			if (typeof processingModule.createCanvas2DBackend !== 'function') {
				throw new Error('Processing runtime did not export createCanvas2DBackend().');
			}
			const wasmBytes = new Uint8Array(await wasmResponse.arrayBuffer());
			wasmRuntime = await runtimeModule.load(wasmBytes, {});
			if (current !== generation) return;
			const start = wasmRuntime?.exports?.start;
			if (typeof start !== 'function') {
				throw new Error('Compiled Processing sketch did not export start(runtime).');
			}
			sketch.replaceChildren();
			canvasBackend = processingModule.createCanvas2DBackend(sketch, {});
			sketchInstance = start(canvasBackend);
			if (canvasBackend.canvas) {
				watchCanvasSize();
				status.textContent = 'Running...';
				send({ type: 'started' });
			}
		}
		run().catch(error => {
			status.textContent = 'Run failed.';
			send({ type: 'log-raw', text: format(error) });
			send({ type: 'stopped' });
		});
	</script>
</body>
</html>`;
	}
}
