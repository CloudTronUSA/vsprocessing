import * as vscode from 'vscode';
import { ProcessingLinter } from './linter';
import {
	buildArtifactFileName, buildArtifactFileUri, collectSources, countLines,
	createNonce, escapeScriptJson, formatDiagnostic, formatDuration,
	getWorkspaceFolder, hasSources, identifyEntrypoint, isBuildArtifactOutdated,
	isTempBuildArtifactOutdated, readTemplate,
	renderTemplate, sourceVersions, statOrUndefined, stripExtension, stripWasmExtension,
	toJavaIdentifier, type SourceKind, type WorkspaceSource
} from './utils';

declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number): unknown;

const compileCommand = 'webprocessing.compile';
const runCommand = 'webprocessing.run';
const stopCommand = 'webprocessing.stop';
const controlsViewType = 'webprocessing.controls';
const runtimeViewType = 'webruntime';
const defaultOpenStateKey = 'webprocessing.defaultOpen.v1';

type ProcessingModule = typeof import('../lib/teavm-javac/processing-teavm.js');
type CompilerModule = typeof import('../lib/teavm-javac/teavm-javac.js');

interface BuildArtifact {
	readonly mode: SourceKind;
	readonly scope: string;
	readonly name: string;
	readonly uri?: vscode.Uri;
	readonly bytes?: Uint8Array;
	readonly sourceVersions?: ReadonlyMap<string, number>;
	readonly outdated: boolean;	// if the compiled file outdated?
}

interface ExtensionState {
	readonly mode: SourceKind;
	readonly hasSources: boolean;	// has source files?
	readonly hasCompiled: boolean;	// has compiled file?
	readonly isCompiling: boolean;
	readonly isRunning: boolean;
	readonly isOutdated: boolean;
}

interface ExtensionControlsViewState extends ExtensionState {
	readonly status: string;
	readonly warning: string;
}

const importModule = new Function('specifier', 'return import(specifier);') as <T>(specifier: string) => Promise<T>;

export function activate(context: vscode.ExtensionContext): void {
	const extension = new Extension(context);
	context.subscriptions.push(extension);
}

class Extension implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly output = vscode.window.createOutputChannel('Processing');	// output channel
	private readonly controlsProvider: ExtensionControlsProvider;	// control panel
	private readonly linter: ProcessingLinter;
	private runtimePanel: ProcessingRuntimePanel | undefined;	// runtime panel
	private javaRuntimeWorker: Worker | undefined;
	private javaRuntimeRunId = 0;
	private mode: SourceKind = 'processing';
	private processingCompilerModule: Promise<ProcessingModule> | undefined;
	private javaCompilerModule: Promise<CompilerModule> | undefined;
	private buildArtifact: BuildArtifact | undefined;
	private compiling = false;
	private running = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.controlsProvider = new ExtensionControlsProvider(this.context.extensionUri, this);
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
		this.disposables.push(vscode.workspace.onDidOpenTextDocument(() => this.refreshState()));
		this.disposables.push(vscode.workspace.onDidChangeTextDocument(() => this.refreshState()));
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

	getState(): ExtensionState {
		return {
			mode: this.mode,
			hasSources: hasSources(this.mode),
			hasCompiled: !!this.buildArtifact,
			isCompiling: this.compiling,
			isRunning: this.running,
			isOutdated: !!this.buildArtifact?.outdated
		};
	}

	private async refreshState(): Promise<void> {
		const workspaceFolder = getWorkspaceFolder();
		let buildArtifact: BuildArtifact | undefined;
		if (workspaceFolder) {
			// see if the compiled file exists and if it's outdated
			const uri = buildArtifactFileUri(workspaceFolder);
			const stat = await statOrUndefined(uri);
			if (stat) {
				buildArtifact = {
					mode: this.mode,
					scope: workspaceFolder.uri.toString(),
					name: buildArtifactFileName(workspaceFolder),
					uri,
					outdated: await isBuildArtifactOutdated(workspaceFolder, stat.mtime)
				};
			}
		} else if (this.buildArtifact?.bytes && this.buildArtifact.sourceVersions) {
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

	setMode(mode: SourceKind): void {
		if (this.mode === mode || this.compiling || this.running) {
			return;
		}
		this.mode = mode;
		this.buildArtifact = undefined;
		void this.refreshState();
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
		this.setCompiling(true);
		const startedAt = Date.now();

		this.showOutput();
		this.output.clear();
		this.log('\n==== BEGIN COMPILATION ====\n');
		this.log(`[compiler] Mode: ${this.mode}`);
		this.log('[compiler] Target configuration: type=WebAssembly (Wasm-GC), fast global analysis enabled');

		try {
			// collect
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

			const targetFileName = workspaceFolder ? buildArtifactFileName(workspaceFolder) : `${stripExtension(mainSource.path ?? 'sketch')}.compiled.wasm`;
			const targetUri = workspaceFolder ? buildArtifactFileUri(workspaceFolder) : undefined;

			const wasmBytes = this.mode === 'processing'
				? await this.compileProcessing(sources, mainSource, targetFileName)
				: await this.compileJava(sources, mainSource, targetFileName);

			if (targetUri && workspaceFolder) {
				await vscode.workspace.fs.writeFile(targetUri, wasmBytes);
				this.buildArtifact = {
					mode: this.mode,
					scope: workspaceFolder.uri.toString(),
					name: targetFileName,
					uri: targetUri,
					outdated: false
				};
				this.log(`[compiler] Wrote ${targetFileName} (${wasmBytes.byteLength} bytes).`);
			} else {
				this.buildArtifact = {
					mode: this.mode,
					scope: 'open-tabs',
					name: targetFileName,
					bytes: wasmBytes,
					sourceVersions: sourceVersions(sources),
					outdated: false
				};
				this.log(`[compiler] Stored ${targetFileName} in temporary memory (${wasmBytes.byteLength} bytes).`);
			}

			this.log(`\n==== BUILD SUCCEEDED in ${formatDuration(Date.now() - startedAt)} ====\n`);
			await this.refreshState();
		} catch (error) {
			// check if error.issues is exists, then list
			if (error.issues) {
				for (const issue of error.issues) {
					this.log(`[compiler] ${issue.message}`);
				}
			} else {
				this.log(`[compiler] ${error}`);
			}

			this.log(`\n==== BUILD FAILED in ${formatDuration(Date.now() - startedAt)} ====\n`);
			void vscode.window.showErrorMessage(vscode.l10n.t('Processing compile failed. See the Processing output channel.'));
			await this.refreshState();
		} finally {
			this.setCompiling(false);
		}
	}

	private async compileProcessing(sources: readonly WorkspaceSource[], mainSource: WorkspaceSource, targetFileName: string): Promise<Uint8Array> {
		this.log('\n[compiler] Loading Processing compiler...');
		const processing = await this.loadProcessingCompilerModule();
		const core = await this.readAsset('processing-core-teavm.jar');

		this.log('[compiler] Compiling Processing sketch...');
		const generated = await processing.generateProcessingSketch([...sources], {
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
			compilerOptions: this.compilerOptions(),
			onDiagnostic: diagnostic => {
				this.log(formatDiagnostic(diagnostic));
			}
		});

		if (generated.output !== 'wasm-gc' || !generated.wasmBytes) {
			throw new Error('TeaVM did not produce a valid WebAssembly output.');
		}
		if (generated.files?.length) {
			this.log(`[compiler] Generated files: ${generated.files.join(', ')}`);
		}
		return generated.wasmBytes;
	}

	private async compileJava(sources: readonly WorkspaceSource[], mainSource: WorkspaceSource, targetFileName: string): Promise<Uint8Array> {
		this.log('\n[compiler] Loading Java compiler...');
		const module = await this.loadJavaCompilerModule();
		const compiler = await module.createCompiler(this.compilerOptions());
		const diagnostics = compiler.onDiagnostic(diagnostic => {
			this.log(formatDiagnostic(diagnostic));
		});

		try {
			for (const source of sources) {
				compiler.addSource(source.path, source.content);
			}

			this.log('[compiler] Compiling Java sources...');
			if (!compiler.compile()) {
				throw new Error('Java compilation failed.');
			}

			const mainClass = this.resolveJavaMainClass(compiler.findMainClasses(), mainSource);
			this.log(`[compiler] Main class: ${mainClass}`);
			const emitted = compiler.emitWasm({
				mainClass,
				outputName: stripWasmExtension(targetFileName),
				optimizationLevel: 'simple',
				fastGlobalAnalysis: true
			});

			if (!emitted.ok || !emitted.bytes) {
				throw new Error('TeaVM did not produce a valid WebAssembly output.');
			}
			if (emitted.files.length) {
				this.log(`[compiler] Generated files: ${emitted.files.join(', ')}`);
			}
			return new Uint8Array(emitted.bytes);
		} finally {
			diagnostics.dispose();
		}
	}

	private resolveJavaMainClass(mainClasses: readonly string[], mainSource: WorkspaceSource): string {
		if (mainClasses.length === 0) {
			throw new Error('No Java main class was found.');
		}
		const sourceClass = toJavaIdentifier(stripExtension(mainSource.path ?? 'Main').split('/').pop() ?? 'Main', 'Main');
		const matched = mainClasses.find(candidate => candidate === sourceClass || candidate.endsWith(`.${sourceClass}`));
		if (matched) {
			return matched;
		}
		if (mainClasses.length === 1) {
			return mainClasses[0];
		}
		throw new Error(`Multiple Java main classes found: ${mainClasses.join(', ')}. Use main.java or the workspace folder name for the entrypoint.`);
	}

	async run(): Promise<void> {
		if (this.compiling || this.running) {
			return;
		}

		await this.refreshState();
		const artifact = this.buildArtifact;
		if (!artifact || artifact.mode !== this.mode) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Compile before running.'));
			await this.refreshState();
			return;
		}

		// run java
		if (this.mode === 'java') {
			return this.runJavaInBackground(artifact);
		}

		// run processing
		this.showOutput();
		if (artifact.outdated) {
			this.log('[runtime] Warning: Running an outdated executable. The output may not include your latest saved or unsaved changes.');
		}
		this.log(`[runtime] Running ${artifact.name}...`);

		// if there's no runtime panel or the current one is not for the workspace folder, create a new one
		if (!this.runtimePanel || !this.runtimePanel.checkScope(artifact.scope)) {
			this.runtimePanel?.dispose();
			this.runtimePanel = new ProcessingRuntimePanel(this.context.extensionUri, artifact.scope, artifact.uri ? getWorkspaceFolder()?.uri : undefined, message => this.handleRuntimeMessage(message), () => {
				this.runtimePanel = undefined;
				this.setRunning(false);
			});
		}

		await this.runtimePanel.run(artifact.uri ? { uri: artifact.uri } : { bytes: artifact.bytes! });
		this.setRunning(true);
		await this.refreshState();
	}

	private async runJavaInBackground(artifact: BuildArtifact): Promise<void> {
		this.showOutput();
		if (artifact.outdated) {
			this.log('[runtime] Warning: Running an outdated executable. The output may not include your latest saved or unsaved changes.');
		}
		this.log(`[runtime] Running ${artifact.name}...\n`);
		this.stopJavaRuntime(false);
		this.setRunning(true);
		await this.refreshState();

		try {
			const runId = ++this.javaRuntimeRunId;
			const sourceBytes = artifact.bytes ?? await vscode.workspace.fs.readFile(artifact.uri!);
			const wasmBytes = new Uint8Array(sourceBytes);
			const worker = new Worker(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'java-runtime-worker.js').toString(), {
				name: 'webprocessing-java-runtime'
			});
			this.javaRuntimeWorker = worker;
			worker.onmessage = event => this.handleJavaRuntimeMessage(runId, event.data);
			worker.onerror = event => {
				if (runId !== this.javaRuntimeRunId) {
					return;
				}
				this.log(`[runtime] ${event.message}`);
				this.stopJavaRuntime(false);
				this.setRunning(false);
				void this.refreshState();
			};
			worker.postMessage({
				type: 'run',
				runtimeUri: this.assetImportUri('compiler.wasm-runtime.js'),
				wasmBytes
			}, [wasmBytes.buffer]);
		} catch (error) {
			this.log(`[runtime] ${error}`);
			void vscode.window.showErrorMessage(vscode.l10n.t('Java runtime failed. See the Processing output channel.'));
			this.setRunning(false);
			await this.refreshState();
		}
	}

	stop(): void {
		this.runtimePanel?.stop();
		this.stopJavaRuntime();
		this.setRunning(false);
	}

	private handleJavaRuntimeMessage(runId: number, message: { readonly type?: string; readonly text?: string }): void {
		if (runId !== this.javaRuntimeRunId) {
			return;
		}
		switch (message.type) {
			case 'log':
				this.showOutput();
				this.log(`${message.text ?? ''}`);
				break;
			case 'finished':
				this.showOutput();
				this.log('[runtime] Runtime finished.');
				this.stopJavaRuntime(false);
				this.setRunning(false);
				void this.refreshState();
				break;
			case 'error':
				this.showOutput();
				this.log(`[runtime] ${message.text ?? 'Runtime failed.'}`);
				this.stopJavaRuntime(false);
				this.setRunning(false);
				void this.refreshState();
				void vscode.window.showErrorMessage(vscode.l10n.t('Java runtime failed. See the Processing output channel.'));
				break;
		}
	}

	private stopJavaRuntime(log = true): void {
		if (!this.javaRuntimeWorker) {
			return;
		}
		this.javaRuntimeRunId++;
		this.javaRuntimeWorker.terminate();
		this.javaRuntimeWorker = undefined;
		if (log) {
			this.showOutput();
			this.log('[runtime] Runtime stopped.');
		}
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

	private async loadProcessingCompilerModule(): Promise<ProcessingModule> {
		if (!this.processingCompilerModule) {
			this.processingCompilerModule = importModule<ProcessingModule>(this.assetImportUri('processing-teavm.js'));
		}
		return this.processingCompilerModule;
	}

	private async loadJavaCompilerModule(): Promise<CompilerModule> {
		if (!this.javaCompilerModule) {
			this.javaCompilerModule = importModule<CompilerModule>(this.assetImportUri('teavm-javac.js'));
		}
		return this.javaCompilerModule;
	}

	private async readAsset(name: string): Promise<Uint8Array> {
		return vscode.workspace.fs.readFile(this.assetUri(name));
	}

	private compilerOptions(): import('../lib/teavm-javac/teavm-javac.js').CreateCompilerOptions {
		return {
			compilerWasmUrl: this.assetUri('compiler.wasm').toString(),
			compilerWasmRuntimeUrl: this.assetImportUri('compiler.wasm-runtime.js'),
			javacClasslibUrl: this.assetUri('compile-classlib-teavm.bin').toString(),
			runtimeClasslibUrl: this.assetUri('runtime-classlib-teavm.bin').toString(),
			fallbackToJs: false
		};
	}

	private assetUri(name: string): vscode.Uri {
		return vscode.Uri.joinPath(this.context.extensionUri, 'lib', 'teavm-javac', name);
	}

	private assetImportUri(name: string): string {
		return this.assetUri(name).toString();
	}
}

type controlsMessage =
	| { readonly type: 'compile' }
	| { readonly type: 'run' }
	| { readonly type: 'stop' }
	| { readonly type: 'mode'; readonly mode: SourceKind };

// stuff in left side bar
class ExtensionControlsProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly controller: Extension
	) { }

	async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = await this.getHtml(this.getViewState());
		webviewView.webview.onDidReceiveMessage(message => this.handleMessage(message));
	}

	update(): void {
		void this.view?.webview.postMessage({ type: 'state', state: this.getViewState() });
	}

	private handleMessage(message: controlsMessage): void {
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
			case 'mode':
				this.controller.setMode(message.mode);
				break;
		}
	}

	private getViewState(): ExtensionControlsViewState {
		const state = this.controller.getState();
		const status = !state.hasSources
			? `Open a ${state.mode === 'processing' ? 'Processing' : 'Java'} source file.`
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
	private async getHtml(state: ExtensionControlsViewState): Promise<string> {
		const nonce = createNonce();
		const initialState = escapeScriptJson(JSON.stringify(state));
		return renderTemplate(await readTemplate(this.extensionUri, 'processing-controls.html'), {
			nonce,
			initialState
		});
	}
}

type RuntimeMessage =
	| { readonly type: 'log-raw'; readonly text: string }
	| { readonly type: 'started' }
	| { readonly type: 'stopped' };

type RuntimeSource =
	| { readonly uri: vscode.Uri }
	| { readonly bytes: Uint8Array };

// a panel to show execution outcome
class ProcessingRuntimePanel implements vscode.Disposable {
	private readonly panel: vscode.WebviewPanel;
	private pendingBytes: Uint8Array | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly scope: string,
		localRoot: vscode.Uri | undefined,
		private readonly onMessage: (message: RuntimeMessage) => void,
		onDispose: () => void
	) {
		this.panel = vscode.window.createWebviewPanel(runtimeViewType, 'Processing Runtime', vscode.ViewColumn.Beside, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: localRoot
				? [vscode.Uri.joinPath(extensionUri, 'lib', 'teavm-javac'), localRoot]
				: [vscode.Uri.joinPath(extensionUri, 'lib', 'teavm-javac')]
		});
		this.panel.webview.onDidReceiveMessage(message => {
			if (message?.type === 'readyForWasm') {
				if (this.pendingBytes) {
					void this.panel.webview.postMessage({ type: 'wasmBytes', bytes: this.pendingBytes });
				}
				return;
			}
			this.onMessage(message);
		});
		this.panel.onDidDispose(onDispose);
	}

	checkScope(scope: string): boolean {
		return this.scope === scope;
	}

	dispose(): void {
		this.panel.dispose();
	}

	async run(source: RuntimeSource): Promise<void> {	// fill in the webview to run the sketch
		this.panel.reveal(vscode.ViewColumn.Beside);
		this.pendingBytes = 'bytes' in source ? source.bytes : undefined;
		this.panel.webview.html = await this.getHtml('uri' in source ? source.uri : undefined);
	}

	stop(): void {	// tell the runner inside of webview to shut
		this.panel.webview.postMessage({ type: 'stop' });
	}

	// generate the HTML content for the runtime panel
	private async getHtml(wasmUri: vscode.Uri | undefined): Promise<string> {
		const nonce = createNonce();
		const payload = escapeScriptJson(JSON.stringify({
			wasmUri: wasmUri ? this.panel.webview.asWebviewUri(wasmUri).toString() : '',
			wasmRuntimeUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'lib', 'teavm-javac', 'compiler.wasm-runtime.js')).toString(),
			processingUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'lib', 'teavm-javac', 'processing-teavm.js')).toString()
		}));
		return renderTemplate(await readTemplate(this.extensionUri, 'processing-runtime.html'), {
			nonce,
			payload,
			cspSource: this.panel.webview.cspSource
		});
	}
}
