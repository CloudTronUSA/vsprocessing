import * as vscode from 'vscode';
import type { CompilerOutput, ProcessingCompiler } from '../compiler/processingCompiler';
import type { BuildOutputKind, ProcessingOutputTarget } from '../core/types';
import {
	collectSources, countLines, getWorkspaceFolder, identifyEntrypoint, isInWorkspaceFolder,
	readTemplate, renderTemplate, stripExtension, type WorkspaceSource
} from '../utils';

declare const TextEncoder: {
	new(): { encode(input?: string): Uint8Array };
};

const canvasId = 'processing-canvas';
const defaultExportFolder = 'web-export';

interface WebsiteCompileOutput {
	readonly output: ProcessingOutputTarget;
	readonly wasm?: CompilerOutput;
	readonly js?: CompilerOutput;
}

export class WebsiteExporter {
	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly compiler: ProcessingCompiler,
		private readonly processingOutput: () => ProcessingOutputTarget,
		private readonly softwareVersion: string,
		private readonly log: (message?: string) => void
	) { }

	async export(): Promise<void> {
		const workspaceFolder = getWorkspaceFolder();
		if (!workspaceFolder) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Open a workspace folder before exporting a website.'));
			return;
		}

		const title = await vscode.window.showInputBox({
			title: vscode.l10n.t('Export Website'),
			prompt: vscode.l10n.t('Website title'),
			value: workspaceFolder.name,
			ignoreFocusOut: true,
			validateInput: value => value.trim() ? undefined : vscode.l10n.t('Enter a title.')
		});
		if (title === undefined) {
			return;
		}

		const footer = await vscode.window.showInputBox({
			title: vscode.l10n.t('Export Website'),
			prompt: vscode.l10n.t('Footer text'),
			value: '',
			ignoreFocusOut: true
		});
		if (footer === undefined) {
			return;
		}

		const relativePath = await vscode.window.showInputBox({
			title: vscode.l10n.t('Export Website'),
			prompt: vscode.l10n.t('Export folder, relative to the workspace folder'),
			value: defaultExportFolder,
			ignoreFocusOut: true,
			validateInput: value => this.validateExportPath(value)
		});
		if (relativePath === undefined) {
			return;
		}

		const startedAt = Date.now();
		this.log('\n==== BEGIN WEBSITE EXPORT ====\n');
		this.log(`[export] Output target: ${this.processingOutput()}`);
		const outputUri = this.resolveExportUri(workspaceFolder, relativePath);
		const compiled = await this.compileSketch(workspaceFolder);

		await this.purgeAndCreate(outputUri);
		await this.writeRuntimeFiles(outputUri, compiled);
		await this.writeIndex(outputUri, {
			title: title.trim(),
			footer,
			output: compiled.output,
			wasmArtifactName: compiled.wasm ? 'sketch.wasm' : '',
			jsArtifactName: compiled.js ? 'sketch.js' : '',
			buildTime: new Date().toISOString()
		});

		this.log(`[export] Wrote website to ${relativePath.trim()} in ${Date.now() - startedAt}ms.`);
		void vscode.window.showInformationMessage(vscode.l10n.t('Website exported to {0}.', relativePath.trim()));
	}

	private async compileSketch(workspaceFolder: vscode.WorkspaceFolder): Promise<WebsiteCompileOutput> {
		this.log('[export] Collecting Processing sources...');
		const collection = await collectSources('processing');
		const { sources } = collection;
		if (!sources.length) {
			throw new Error('No .pde files were found.');
		}
		for (const source of sources) {
			this.log(`[export] Found ${source.path} (${countLines(source.content)} lines, ${source.content.length} chars)`);
		}

		const entrypoint = identifyEntrypoint(sources, workspaceFolder);
		if (!entrypoint && sources.length > 1) {
			throw new Error('Cannot determine program entrypoint for a multi-file project. Use foldername.pde or main.pde.');
		}
		const mainSource = entrypoint ?? sources[0];
		this.log(`[export] Entrypoint: ${mainSource.path}`);
		const targetFileName = `${stripExtension(mainSource.path ?? 'sketch')}.wasm`;
		const output = this.processingOutput();

		if (output === 'auto') {
			const [wasm, js] = await Promise.all([
				this.compileProcessingOutput(sources, mainSource, targetFileName, 'wasm-gc'),
				this.compileProcessingOutput(sources, mainSource, targetFileName, 'js')
			]);
			return { output, wasm, js };
		}

		const compiled = await this.compileProcessingOutput(sources, mainSource, targetFileName, output);
		return compiled.output === 'js'
			? { output, js: compiled }
			: { output, wasm: compiled };
	}

	private async purgeAndCreate(outputUri: vscode.Uri): Promise<void> {
		if (await exists(outputUri)) {
			this.log(`[export] Removing existing ${outputUri.path}...`);
			await vscode.workspace.fs.delete(outputUri, { recursive: true, useTrash: false });
		}
		await vscode.workspace.fs.createDirectory(outputUri);
	}

	private async writeRuntimeFiles(outputUri: vscode.Uri, compiled: WebsiteCompileOutput): Promise<void> {
		await vscode.workspace.fs.copy(
			this.compiler.assetUri('teavm-javac.js'),
			vscode.Uri.joinPath(outputUri, 'teavm-javac.js'),
			{ overwrite: true }
		);

		if (compiled.js) {
			await this.writeText(vscode.Uri.joinPath(outputUri, 'sketch.js'), compiled.js.text!);
		}
		if (compiled.wasm) {
			await vscode.workspace.fs.copy(
				this.compiler.assetUri('compiler.wasm-runtime.js'),
				vscode.Uri.joinPath(outputUri, 'compiler.wasm-runtime.js'),
				{ overwrite: true }
			);
			await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(outputUri, 'sketch.wasm'), compiled.wasm.bytes!);
		}
		await vscode.workspace.fs.copy(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'p5.min.js'),
			vscode.Uri.joinPath(outputUri, 'p5.min.js'),
			{ overwrite: true }
		);

		await this.writeText(vscode.Uri.joinPath(outputUri, 'processing.js'), this.renderRunnerScript());
	}

	private async writeIndex(outputUri: vscode.Uri, options: {
		readonly title: string;
		readonly footer: string;
		readonly output: string;
		readonly wasmArtifactName: string;
		readonly jsArtifactName: string;
		readonly buildTime: string;
	}): Promise<void> {
		const template = await readTemplate(this.extensionUri, 'export-website.html');
		const config = {
			output: options.output,
			wasmArtifact: options.wasmArtifactName ? `./${options.wasmArtifactName}` : '',
			jsArtifact: options.jsArtifactName ? `./${options.jsArtifactName}` : '',
			canvasId
		};
		const html = renderTemplate(template, {
			title: escapeHtml(options.title),
			headline: escapeHtml(options.title),
			footer_content: escapeHtml(options.footer),
			canvas_id: canvasId,
			custom_scripts: `<script>window.WEBPROCESSING_EXPORT = ${escapeInlineJson(config)};</script>\n    <script src="p5.min.js"></script>`,
			template_debug: sanitizeHtmlComment(`Built ${options.buildTime} by Web Processing ${this.softwareVersion} using ${options.output} output.`)
		});
		await this.writeText(vscode.Uri.joinPath(outputUri, 'index.html'), html);
	}

	private renderRunnerScript(): string {
		return `(() => {
	const config = window.WEBPROCESSING_EXPORT;

	function toText(value) {
		if (value instanceof Error) {
			return value.stack || value.name + ': ' + value.message;
		}
		if (typeof value === 'string') {
			return value;
		}
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}

	function formatError(value) {
		return toText(value);
	}

	function installUiHooks() {
		for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
			const original = console[level].bind(console);
			console[level] = (...values) => {
				UI.updateConsole(values.map(toText).join(' '), true);
				original(...values);
			};
		}

		window.addEventListener('error', event => {
			UI.showError(formatError(event.error || event.message), 'Uncaught exception');
		});
		window.addEventListener('unhandledrejection', event => {
			UI.showError(formatError(event.reason), 'Unhandled promise rejection');
		});
	}

	async function loadWasmStart() {
		if (!config.wasmArtifact) {
			throw new Error('No WebAssembly artifact was exported.');
		}
		const [runtimeModule, response] = await Promise.all([
			import('./compiler.wasm-runtime.js'),
			fetch(config.wasmArtifact)
		]);
		if (!response.ok) {
			throw new Error('Failed to load compiled WebAssembly: HTTP ' + response.status);
		}
		const runtime = await runtimeModule.load(new Uint8Array(await response.arrayBuffer()), {});
		return runtime?.exports?.start;
	}

	async function loadJsStart() {
		if (!config.jsArtifact) {
			throw new Error('No JavaScript artifact was exported.');
		}
		return (await import(config.jsArtifact)).start;
	}

	async function loadStart() {
		if (config.output === 'js') {
			console.info('Selected JavaScript runtime.');
			return loadJsStart();
		}
		if (config.output === 'auto') {
			try {
				const start = await loadWasmStart();
				console.info('Auto-selected WebAssembly runtime.');
				return start;
			} catch (error) {
				const start = await loadJsStart();
				console.warn('Auto-selected JavaScript runtime after WebAssembly failed.', error);
				return start;
			}
		}
		console.info('Selected WebAssembly runtime.');
		return loadWasmStart();
	}

	async function run() {
		UI.clearError();
		const canvas = document.getElementById(config.canvasId);
		const parent = canvas.parentElement || document.body;
		const start = await loadStart();
		if (typeof start !== 'function') {
			throw new Error('Compiled Processing sketch did not export start.');
		}
		canvas.remove();
		if (typeof window.p5 !== 'function') {
			throw new Error('p5.js is not loaded.');
		}
		new window.p5(p => {
			p.setup = () => {
				const result = start(p);
				console.info('Render backend used: p5');
				if (result && typeof result.then === 'function') {
					result.then(() => UI.showError('The program has finished running.', 'Program exited'));
				}
			};
		}, parent);
	}

	function start() {
		installUiHooks();
		run().catch(error => {
			UI.showError(formatError(error), 'Program failed');
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	} else {
		start();
	}
})();`;
	}

	private async compileProcessingOutput(
		sources: readonly WorkspaceSource[],
		mainSource: WorkspaceSource,
		targetFileName: string,
		output: BuildOutputKind
	): Promise<CompilerOutput> {
		const compiled = await this.compiler.compile('processing', sources, mainSource, targetFileName, output);
		if (compiled.output !== output) {
			throw new Error(`Expected ${output} output, got ${compiled.output}.`);
		}
		return compiled;
	}

	private resolveExportUri(workspaceFolder: vscode.WorkspaceFolder, rawPath: string): vscode.Uri {
		const normalized = normalizeRelativePath(rawPath);
		const uri = vscode.Uri.joinPath(workspaceFolder.uri, ...normalized.split('/'));
		if (uri.toString() === workspaceFolder.uri.toString() || !isInWorkspaceFolder(uri, workspaceFolder)) {
			throw new Error('Export folder must be inside the workspace folder and cannot be the workspace root.');
		}
		return uri;
	}

	private validateExportPath(value: string): string | undefined {
		try {
			normalizeRelativePath(value);
			return undefined;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	private async writeText(uri: vscode.Uri, text: string): Promise<void> {
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
	}

}

function normalizeRelativePath(value: string): string {
	const normalized = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
	if (!normalized || normalized === '.' || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
		throw new Error('Enter a folder path relative to the workspace folder.');
	}
	const parts = normalized.split('/');
	if (parts.some(part => !part || part === '.' || part === '..')) {
		throw new Error('Export folder cannot use empty, current, or parent path segments.');
	}
	return parts.join('/');
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function escapeInlineJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003C');
}

function sanitizeHtmlComment(value: string): string {
	return value.replace(/--/g, '- -').replace(/>/g, '&gt;');
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}
