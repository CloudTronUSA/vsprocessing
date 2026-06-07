/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { CompilerDiagnostic, ProcessingCompileResult, ProcessingPreprocessResult, ProcessingSource } from './teavm-javac';

declare const TextDecoder: {
	new(): { decode(input?: Uint8Array): string };
};

declare const TextEncoder: {
	new(): { encode(input?: string): Uint8Array };
};

declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number): unknown;

const compileCommand = 'webprocessing.compile';
const runCommand = 'webprocessing.run';
const stopCommand = 'webprocessing.stop';
const controlsViewType = 'webprocessing.controls';
const outcomeViewType = 'webprocessing.outcome';
const compiledFileName = 'compiled.js';
const defaultOpenStateKey = 'webprocessing.defaultOpen.v1';

type ProcessingModule = typeof import('./teavm-javac');

interface CompiledState {
	readonly workspaceFolder: vscode.WorkspaceFolder;
	readonly uri: vscode.Uri;
	readonly mtime: number;
	readonly outdated: boolean;
}

interface ProcessingState {
	readonly hasWorkspace: boolean;
	readonly hasCompiled: boolean;
	readonly isCompiling: boolean;
	readonly isRunning: boolean;
	readonly isOutdated: boolean;
}

interface OrderedProcessingSources {
	readonly sources: ProcessingSource[];
	readonly mainSource: ProcessingSource;
	readonly entryPointConfidence: 'confident' | 'inferred' | 'unknown';
	readonly expectedEntryPoints: readonly string[];
}

const importModule = new Function('specifier', 'return import(specifier);') as <T>(specifier: string) => Promise<T>;

export function activate(context: vscode.ExtensionContext): void {
	const controller = new WebProcessingController(context);
	context.subscriptions.push(controller);
}

class WebProcessingController implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly output = vscode.window.createOutputChannel('Processing');
	private readonly controlsProvider: ProcessingControlsProvider;
	private outcomePanel: ProcessingOutcomePanel | undefined;
	private compilerModule: Promise<ProcessingModule> | undefined;
	private compiledState: CompiledState | undefined;
	private compiling = false;
	private running = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.controlsProvider = new ProcessingControlsProvider(this);
		this.disposables.push(this.output);
		this.disposables.push(vscode.window.createTreeView(controlsViewType, { treeDataProvider: this.controlsProvider }));
		this.disposables.push(vscode.commands.registerCommand(compileCommand, () => this.compile()));
		this.disposables.push(vscode.commands.registerCommand(runCommand, () => this.run()));
		this.disposables.push(vscode.commands.registerCommand(stopCommand, () => this.stop()));
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
		void this.openDefaultView();
	}

	dispose(): void {
		this.stop(false);
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.outcomePanel?.dispose();
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
			const uri = vscode.Uri.joinPath(workspaceFolder.uri, compiledFileName);
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

	private async openDefaultView(): Promise<void> {
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
		this.setCompiling(true);
		this.showOutput();
		this.output.clear();
		this.log('\n==== Begin Compilation ====\n');
		this.log(`[processing.compiler] Workspace: ${workspaceFolder.uri.toString()}`);
		this.log(`[processing.compiler] Target: ${vscode.Uri.joinPath(workspaceFolder.uri, compiledFileName).toString()}`);
		this.log('[processing.compiler] Collecting .pde files...');

		try {
			this.stop(false);
			const sources = await collectProcessingSources(workspaceFolder.uri);
			if (sources.length === 0) {
				throw new Error('No .pde files were found in the workspace folder.');
			}

			const ordered = orderProcessingSources(sources, workspaceFolder);
			const orderedSources = ordered.sources;
			for (const source of sources) {
				this.log(`[processing.compiler] Found ${source.path} (${countLines(source.content)} lines, ${source.content.length} chars)`);
			}
			this.log(`[processing.compiler] Entrypoint: ${ordered.mainSource.path} (${ordered.entryPointConfidence})`);
			if (ordered.entryPointConfidence !== 'confident') {
				this.log(`[processing.compiler] Warning: The compiler could not confidently determine the Processing entry point because neither ${ordered.expectedEntryPoints.join(' nor ')} exists. It will use ${ordered.mainSource.path}. For reliable multi-file sketches, rename the main sketch tab to ${ordered.expectedEntryPoints[0]} or main.pde.`);
			}

			this.log('[processing.compiler] Loading TeaVM Processing compiler...');
			const processing = await this.loadCompilerModule();
			const core = await this.readAsset('processing-core-teavm.jar');

			this.log('[processing.compiler] Compiling Java program with Processing core...');
			const compiled = await processing.compileProcessingSketch(orderedSources, {
				core,
				sketchName: toJavaIdentifier(stripExtension(orderedSources[0].path ?? 'Sketch'), 'Sketch'),
				sourceMaps: false,
				compilerOptions: {
					compilerJsUrl: this.assetImportUri('compiler.js'),
					javacClasslibUrl: this.assetUri('compile-classlib-teavm.bin').toString(),
					runtimeClasslibUrl: this.assetUri('runtime-classlib-teavm.bin').toString()
				}
			});

			this.logCompileDetails(compiled);
			if (!compiled.compiled) {
				throw new Error('Java compilation failed.');
			}

			this.log('[processing.compiler] Emitting JavaScript executable...');
			const emitted = compiled.compiler.emitJs({
				mainClass: compiled.launcherClass,
				fileName: compiledFileName,
				module: 'esm',
				sourceMap: false
			});

			if (!emitted.ok || !emitted.text) {
				throw new Error('TeaVM JavaScript emit failed.');
			}

			const compiledUri = vscode.Uri.joinPath(workspaceFolder.uri, compiledFileName);
			const text = withExecutionHeader(emitted.text);
			await vscode.workspace.fs.writeFile(compiledUri, new TextEncoder().encode(text));
			const stat = await vscode.workspace.fs.stat(compiledUri);
			this.compiledState = { workspaceFolder, uri: compiledUri, mtime: stat.mtime, outdated: false };

			this.log(`[processing.compiler] Wrote ${compiledFileName} (${text.length} chars).`);
			this.log(`\n==== Compilation succeeded in ${formatDuration(Date.now() - startedAt)} ====\n`);
			await this.refreshState();
		} catch (error) {
			this.logCompileErrorDetails(error);
			this.log(`[processing.compiler] Error: ${formatError(error)}`);
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

		const compiledUri = vscode.Uri.joinPath(workspaceFolder.uri, compiledFileName);
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
		this.log(`[processing.runtime] Running ${compiledFileName}...`);
		const bytes = await vscode.workspace.fs.readFile(compiledUri);
		const compiledJs = new TextDecoder().decode(bytes);

		if (!this.outcomePanel) {
			this.outcomePanel = new ProcessingOutcomePanel(this.context.extensionUri, message => this.handleOutcomeMessage(message), () => {
				this.outcomePanel = undefined;
				this.setRunning(false);
				this.showOutput();
				this.log('[processing.runtime] Runtime closed.');
			});
		}

		this.outcomePanel.run(compiledJs);
		this.setRunning(true);
		await this.refreshState();
	}

	stop(logStop = true): void {
		this.outcomePanel?.stop();
		this.setRunning(false);
		if (logStop) {
			this.showOutput();
			this.log('[processing.runtime] Stopped.');
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

	private handleOutcomeMessage(message: OutcomeMessage): void {
		switch (message.type) {
			case 'log':
				this.showOutput();
				this.log(`[processing.runtime] [${message.level}] ${message.text}`);
				break;
			case 'started':
				this.showOutput();
				this.log('[processing.runtime] Runner started.');
				this.setRunning(true);
				break;
			case 'stopped':
				this.showOutput();
				this.log('[processing.runtime] Runner stopped.');
				this.setRunning(false);
				break;
		}
	}

	private logCompileDetails(compiled: ProcessingCompileResult): void {
		this.log(`[processing.compiler] Preprocessor output file: ${compiled.preprocessed.sourceFileName}`);
		this.log(`[processing.compiler] Preprocessor sketch class: ${compiled.preprocessed.className}`);
		this.log(`[processing.compiler] Launcher class: ${compiled.launcherClass}`);
		this.log(`[processing.compiler] Generated Java source: ${compiled.preprocessed.javaSource.length} chars, ${countLines(compiled.preprocessed.javaSource)} lines.`);
		this.log(`[processing.compiler] Preprocessor issues: ${compiled.preprocessed.issues.length}`);
		for (const issue of compiled.preprocessed.issues) {
			this.log(`[processing.compiler] Preprocess issue ${issue.line}:${issue.column} ${issue.message}`);
		}
		this.log(`[processing.compiler] Java diagnostics: ${compiled.diagnostics.length}`);
		for (const diagnostic of compiled.diagnostics) {
			this.log(formatDiagnostic(diagnostic));
		}
	}

	private logCompileErrorDetails(error: unknown): void {
		if (!isProcessingCompileLikeError(error)) {
			return;
		}
		if (error.preprocessed) {
			this.log(`[processing.compiler] Preprocessor output file: ${error.preprocessed.sourceFileName}`);
			this.log(`[processing.compiler] Preprocessor sketch class: ${error.preprocessed.className}`);
			this.log(`[processing.compiler] Generated Java source: ${error.preprocessed.javaSource.length} chars, ${countLines(error.preprocessed.javaSource)} lines.`);
			for (const issue of error.preprocessed.issues) {
				this.log(`[processing.compiler] Preprocess issue ${issue.line}:${issue.column} ${issue.message}`);
			}
		}
		if (error.diagnostics) {
			for (const diagnostic of error.diagnostics) {
				this.log(formatDiagnostic(diagnostic));
			}
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

type ProcessingTreeItemKind = 'command' | 'status';

class ProcessingTreeItem extends vscode.TreeItem {
	constructor(
		label: string,
		kind: ProcessingTreeItemKind,
		command?: vscode.Command,
		iconPath?: vscode.ThemeIcon,
		description?: string
	) {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.contextValue = kind;
		this.command = command;
		this.iconPath = iconPath;
		this.description = description;
	}
}

function actionItem(label: string, enabled: boolean, command: string, icon: string, disabledReason?: string): ProcessingTreeItem {
	return new ProcessingTreeItem(
		label,
		'command',
		enabled ? { command, title: label } : undefined,
		new vscode.ThemeIcon(icon, enabled ? undefined : new vscode.ThemeColor('disabledForeground')),
		enabled ? undefined : disabledReason ?? 'Unavailable'
	);
}

class ProcessingControlsProvider implements vscode.TreeDataProvider<ProcessingTreeItem> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ProcessingTreeItem | undefined>();
	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	constructor(private readonly controller: WebProcessingController) { }

	getTreeItem(element: ProcessingTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(): ProcessingTreeItem[] {
		const state = this.controller.getState();
		const canCompile = state.hasWorkspace && !state.isCompiling && !state.isRunning;
		const canRun = state.hasWorkspace && state.hasCompiled && !state.isCompiling && !state.isRunning;
		const canStop = state.isRunning;
		const items: ProcessingTreeItem[] = [
			actionItem(
				'Compile',
				canCompile,
				compileCommand,
				'tools',
				state.isCompiling ? 'Compiling' : state.isRunning ? 'Running' : 'No folder'
			),
			actionItem(
				'Run',
				canRun,
				runCommand,
				'play',
				state.isCompiling ? 'Compiling' : state.isRunning ? 'Running' : state.hasWorkspace ? 'No compiled.js' : 'No folder'
			),
			actionItem(
				'Stop',
				canStop,
				stopCommand,
				'debug-stop',
				state.isCompiling ? 'Compiling' : 'Not running'
			)
		];

		if (!state.hasWorkspace) {
			items.push(new ProcessingTreeItem('Open a folder to use Processing.', 'status', undefined, new vscode.ThemeIcon('info')));
		} else if (state.isCompiling) {
			items.push(new ProcessingTreeItem('Compiling sketch...', 'status', undefined, new vscode.ThemeIcon('sync~spin')));
		} else if (state.isRunning) {
			items.push(new ProcessingTreeItem('Running sketch...', 'status', undefined, new vscode.ThemeIcon('run')));
		} else if (state.hasCompiled) {
			items.push(new ProcessingTreeItem('Ready to run.', 'status', undefined, new vscode.ThemeIcon('check')));
			if (state.isOutdated) {
				items.push(new ProcessingTreeItem('Warning: outdated executable.', 'status', undefined, new vscode.ThemeIcon('warning')));
			}
		} else {
			items.push(new ProcessingTreeItem('Compile a sketch to create compiled.js.', 'status', undefined, new vscode.ThemeIcon('info')));
		}

		return items;
	}

	update(): void {
		this.onDidChangeTreeDataEmitter.fire(undefined);
	}
}

type OutcomeMessage =
	| { readonly type: 'log'; readonly level: string; readonly text: string }
	| { readonly type: 'started' }
	| { readonly type: 'stopped' };

class ProcessingOutcomePanel implements vscode.Disposable {
	private readonly panel: vscode.WebviewPanel;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly onMessage: (message: OutcomeMessage) => void,
		onDispose: () => void
	) {
		this.panel = vscode.window.createWebviewPanel(outcomeViewType, 'Processing Runtime', vscode.ViewColumn.Beside, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
		});
		this.panel.webview.onDidReceiveMessage(message => this.onMessage(message));
		this.panel.onDidDispose(onDispose);
	}

	dispose(): void {
		this.panel.dispose();
	}

	run(compiledJs: string): void {
		this.panel.reveal(vscode.ViewColumn.Beside);
		this.panel.webview.html = this.getHtml(compiledJs);
	}

	stop(): void {
		this.panel.webview.postMessage({ type: 'stop' });
	}

	private getHtml(compiledJs: string): string {
		const nonce = createNonce();
		const p5Uri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'p5.min.js')).toString();
		const payload = escapeScriptJson(JSON.stringify({ compiledJs, p5Uri }));
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${this.panel.webview.cspSource} blob:; connect-src blob:;">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		html, body { height: 100%; margin: 0; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
		#root { height: 100%; display: grid; grid-template-rows: 1fr auto; }
		#sketch { min-height: 0; display: grid; place-items: center; overflow: auto; }
		#status { border-top: 1px solid var(--vscode-panel-border); padding: 6px 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
		canvas { outline: 1px solid var(--vscode-panel-border); }
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
		let moduleUrl;
		let p5Instance;
		let runnerFrame;

		const send = message => vscode.postMessage(message);
		const format = value => {
			if (typeof value === 'string') return value;
			if (value instanceof Error) return value.stack || value.message;
			try { return JSON.stringify(value); } catch { return String(value); }
		};
		for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
			const original = console[level].bind(console);
			console[level] = (...values) => {
				send({ type: 'log', level, text: values.map(format).join(' ') });
				original(...values);
			};
		}
		window.onerror = (message, source, line, column, error) => {
			send({ type: 'log', level: 'error', text: error?.stack || String(message) + ' at ' + source + ':' + line + ':' + column });
		};
		window.onunhandledrejection = event => {
			send({ type: 'log', level: 'error', text: format(event.reason) });
		};
		window.addEventListener('message', event => {
			if (event.data?.type === 'stop') {
				stop();
			}
		});

		function stop() {
			generation++;
			p5Instance?.remove?.();
			p5Instance = undefined;
			runnerFrame?.remove();
			runnerFrame = undefined;
			sketch.replaceChildren();
			if (moduleUrl) {
				URL.revokeObjectURL(moduleUrl);
				moduleUrl = undefined;
			}
			status.textContent = 'Stopped.';
			send({ type: 'stopped' });
		}

		async function loadP5() {
			if (typeof globalThis.p5 === 'function') {
				return globalThis.p5;
			}
			await new Promise((resolve, reject) => {
				const script = document.createElement('script');
				script.src = payload.p5Uri;
				script.onload = resolve;
				script.onerror = () => reject(new Error('Failed to load p5.js runtime.'));
				document.head.append(script);
			});
			return globalThis.p5;
		}

		async function run() {
			stop();
			const current = ++generation;
			status.textContent = 'Running...';
			moduleUrl = URL.createObjectURL(new Blob([payload.compiledJs], { type: 'text/javascript' }));
			const mod = await import(moduleUrl);
			if (current !== generation) return;
			if (typeof mod.start === 'function') {
				const P5 = await loadP5();
				if (current !== generation) return;
				p5Instance = new P5(p => {
					p.setup = () => mod.start(p);
				}, sketch);
			} else {
				runnerFrame = document.createElement('iframe');
				runnerFrame.sandbox = 'allow-scripts';
				runnerFrame.style.display = 'none';
				document.body.append(runnerFrame);
				const win = runnerFrame.contentWindow;
				const doc = runnerFrame.contentDocument;
				win.console = console;
				doc.open();
				doc.write('<!doctype html><html><body></body></html>');
				doc.close();
				const script = doc.createElement('script');
				script.textContent = payload.compiledJs + '\\n//# sourceURL=compiled.js';
				doc.body.append(script);
				if (typeof win.main === 'function') {
					await new Promise((resolve, reject) => {
						try {
							win.main([], error => error ? reject(error) : resolve());
						} catch (error) {
							reject(error);
						}
					});
				}
			}
			status.textContent = 'Running.';
			send({ type: 'started' });
		}
		run().catch(error => {
			status.textContent = 'Run failed.';
			send({ type: 'log', level: 'error', text: format(error) });
			send({ type: 'stopped' });
		});
	</script>
</body>
</html>`;
	}
}

async function collectProcessingSources(root: vscode.Uri): Promise<ProcessingSource[]> {
	const result: ProcessingSource[] = [];
	async function visit(folder: vscode.Uri, relativeFolder: string): Promise<void> {
		const entries = await vscode.workspace.fs.readDirectory(folder);
		entries.sort(([a], [b]) => a.localeCompare(b));
		for (const [name, type] of entries) {
			const child = vscode.Uri.joinPath(folder, name);
			const relativePath = relativeFolder ? `${relativeFolder}/${name}` : name;
			if (type === vscode.FileType.Directory) {
				if (name === '.git' || name === 'node_modules') {
					continue;
				}
				await visit(child, relativePath);
			} else if (type === vscode.FileType.File && name.toLowerCase().endsWith('.pde')) {
				const bytes = await vscode.workspace.fs.readFile(child);
				result.push({ path: relativePath, content: new TextDecoder().decode(bytes) });
			}
		}
	}
	await visit(root, '');
	return result;
}

async function isCompiledOutdated(workspaceFolder: vscode.WorkspaceFolder, compiledMtime: number): Promise<boolean> {
	for (const document of vscode.workspace.textDocuments) {
		if (document.isDirty && isProcessingUri(document.uri) && isInWorkspaceFolder(document.uri, workspaceFolder)) {
			return true;
		}
	}

	for (const uri of await collectProcessingUris(workspaceFolder.uri)) {
		const stat = await statOrUndefined(uri);
		if (stat && stat.mtime > compiledMtime) {
			return true;
		}
	}

	return false;
}

async function collectProcessingUris(root: vscode.Uri): Promise<vscode.Uri[]> {
	const result: vscode.Uri[] = [];
	async function visit(folder: vscode.Uri): Promise<void> {
		const entries = await vscode.workspace.fs.readDirectory(folder);
		entries.sort(([a], [b]) => a.localeCompare(b));
		for (const [name, type] of entries) {
			const child = vscode.Uri.joinPath(folder, name);
			if (type === vscode.FileType.Directory) {
				if (name === '.git' || name === 'node_modules') {
					continue;
				}
				await visit(child);
			} else if (type === vscode.FileType.File && name.toLowerCase().endsWith('.pde')) {
				result.push(child);
			}
		}
	}
	await visit(root);
	return result;
}

function isProcessingUri(uri: vscode.Uri): boolean {
	return uri.path.toLowerCase().endsWith('.pde');
}

function isInWorkspaceFolder(uri: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder): boolean {
	if (uri.scheme !== workspaceFolder.uri.scheme || uri.authority !== workspaceFolder.uri.authority) {
		return false;
	}
	const folderPath = workspaceFolder.uri.path.endsWith('/') ? workspaceFolder.uri.path : `${workspaceFolder.uri.path}/`;
	return uri.path === workspaceFolder.uri.path || uri.path.startsWith(folderPath);
}

function orderProcessingSources(sources: readonly ProcessingSource[], workspaceFolder: vscode.WorkspaceFolder): OrderedProcessingSources {
	const folderName = workspaceFolder.name.toLowerCase();
	const candidates = [
		`${folderName}.pde`,
		'main.pde'
	];

	for (const candidate of candidates) {
		const index = sources.findIndex(source => source.path?.toLowerCase() === candidate);
		if (index >= 0) {
			const ordered = [sources[index], ...sources.slice(0, index), ...sources.slice(index + 1)];
			return { sources: ordered, mainSource: ordered[0], entryPointConfidence: 'confident', expectedEntryPoints: candidates };
		}
	}

	const sketchTabIndex = sources.findIndex(source => hasProcessingSketchEntryPoint(source.content) && !startsWithClassDeclaration(source.content));
	if (sketchTabIndex >= 0) {
		const ordered = [sources[sketchTabIndex], ...sources.slice(0, sketchTabIndex), ...sources.slice(sketchTabIndex + 1)];
		return { sources: ordered, mainSource: ordered[0], entryPointConfidence: 'inferred', expectedEntryPoints: candidates };
	}

	const ordered = [...sources];
	return { sources: ordered, mainSource: ordered[0], entryPointConfidence: 'unknown', expectedEntryPoints: candidates };
}

function hasProcessingSketchEntryPoint(content: string): boolean {
	return /\bvoid\s+(setup|draw)\s*\(/.test(content);
}

function startsWithClassDeclaration(content: string): boolean {
	return /^\s*(?:public\s+)?(?:abstract\s+|final\s+)?class\s+\w+/.test(content);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

async function statOrUndefined(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
	try {
		return await vscode.workspace.fs.stat(uri);
	} catch {
		return undefined;
	}
}

function withExecutionHeader(text: string): string {
	return `/* Generated by Web Processing. Do not edit by hand. */\n${text}`;
}

function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
}

function stripExtension(path: string): string {
	const basename = path.split('/').pop() ?? path;
	return basename.replace(/\.[^.]+$/, '');
}

function toJavaIdentifier(value: string, fallback: string): string {
	const identifier = value.replace(/^[^A-Za-z_$]+/, '').replace(/[^A-Za-z0-9_$]/g, '_');
	return identifier || fallback;
}

function formatDiagnostic(diagnostic: CompilerDiagnostic): string {
	const type = diagnostic.type ?? 'compiler';
	const severity = diagnostic.severity ?? 'other';
	const file = diagnostic.fileName ?? '';
	const line = diagnostic.lineNumber ? `:${diagnostic.lineNumber}` : '';
	const column = diagnostic.columnNumber ? `:${diagnostic.columnNumber}` : '';
	const message = diagnostic.message ?? String(diagnostic);
	return `[processing.compiler] [${type} ${severity}] ${file}${line}${column} ${message}`.trim();
}

function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	return `${(ms / 1000).toFixed(2)}s`;
}

function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.stack || error.message;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

interface ProcessingCompileLikeError {
	readonly preprocessed?: ProcessingPreprocessResult;
	readonly diagnostics?: readonly CompilerDiagnostic[];
}

function isProcessingCompileLikeError(error: unknown): error is ProcessingCompileLikeError {
	return typeof error === 'object' && error !== null && ('preprocessed' in error || 'diagnostics' in error);
}

function createNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

function escapeScriptJson(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\u003C');
}
