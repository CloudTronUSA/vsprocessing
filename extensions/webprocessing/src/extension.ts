import * as vscode from 'vscode';
import { collectProcessingSources, compiledFileName, compiledFileUri, countLines, createNonce, escapeScriptJson, exists, formatDiagnostic, formatDuration, isCompiledOutdated, isProcessingUri, identifyEntrypoint, statOrUndefined, stripExtension, stripWasmExtension, toJavaIdentifier } from './utils';

declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number): unknown;

const compileCommand = 'webprocessing.compile';
const runCommand = 'webprocessing.run';
const stopCommand = 'webprocessing.stop';
const controlsViewType = 'webprocessing.controls';
const runtimeViewType = 'webprocessing.runtime';
const defaultOpenStateKey = 'webprocessing.defaultOpen.v1';

type ProcessingModule = typeof import('../lib/teavm-javac/processing-teavm.js');

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
	private runtimePanel: ProcessingRuntimePanel | undefined;	// runtime panel
	private compilerModule: Promise<ProcessingModule> | undefined;
	private compiledState: CompiledState | undefined;
	private compiling = false;
	private running = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.controlsProvider = new ProcessingControlsProvider(this);
		// views
		this.disposables.push(this.output);
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
