import * as vscode from 'vscode';
import { collectSources, identifyEntrypoint, isInWorkspaceFolder, isJavaUri, isProcessingUri, type WorkspaceSource } from './utils';

declare function setTimeout(handler: (...args: unknown[]) => void, timeout?: number): unknown;
declare function clearTimeout(handle: unknown): void;

const importModule = new Function('specifier', 'return import(specifier);') as <T>(specifier: string) => Promise<T>;

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

export class ProcessingLinter implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly diagnostics = vscode.languages.createDiagnosticCollection('webprocessing');
	private jdtWasm: Promise<JdtWasmExports> | undefined;
	private lintTimer: unknown;
	private linting = false;
	private pendingJava = false;
	private pendingProcessing = false;
	private readonly javaUris = new Set<string>();
	private readonly javaJdtUris = new Map<string, string>();
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
		const sourceByJdtUri = new Map<string, string>();
		let lastMessages: readonly PublishDiagnosticsMessage[] = [];
		const jdt = sources.length > 0 || this.javaUris.size > 0 ? await this.loadJdtWasm() : undefined;

		for (const uri of this.javaUris) {
			if (jdt && !currentUris.has(uri)) {
				lastMessages = this.parseMessages(jdt.handle(JSON.stringify({
					jsonrpc: '2.0',
					method: 'java/browserJdtLs/removeWorkspaceSource',
					params: { uri: this.javaJdtUris.get(uri) ?? uri }
				})));
				this.diagnostics.delete(vscode.Uri.parse(uri));
			}
		}
		if (!jdt) {
			return;
		}

		for (const source of sources) {
			const jdtUri = this.jdtSourceUri(source);
			sourceByJdtUri.set(jdtUri, source.uri.toString());
			lastMessages = this.parseMessages(jdt.handle(JSON.stringify({
				jsonrpc: '2.0',
				method: 'java/browserJdtLs/workspaceSources',
				params: {
					uri: jdtUri,
					text: source.content
				}
			})));
		}

		if (sources.length === 0) {
			for (const uri of this.javaUris) {
				this.diagnostics.delete(vscode.Uri.parse(uri));
			}
		} else {
			this.applyPublishDiagnostics(lastMessages, sourceByJdtUri);
		}
		this.javaUris.clear();
		this.javaJdtUris.clear();
		for (const uri of currentUris) {
			this.javaUris.add(uri);
		}
		for (const source of sources) {
			this.javaJdtUris.set(source.uri.toString(), this.jdtSourceUri(source));
		}
	}

	private async lintProcessing(): Promise<void> {
		const currentUris = new Set<string>();
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		const sources = workspaceFolder
			? await this.collectProcessingWorkspaceSources(workspaceFolder)
			: [...(await collectSources('processing')).sources];

		for (const source of sources) {
			currentUris.add(source.uri.toString());
		}

		if (sources.length > 0) {
			const entrypoint = identifyEntrypoint(sources, workspaceFolder);
			if (!entrypoint && sources.length > 1) {
				this.setEntrypointDiagnostics(workspaceFolder, sources);
			} else {
				const mainSource = entrypoint ? sources.find(source => source.path === entrypoint.path) ?? sources[0] : sources[0];
				const additionalSources = sources
					.filter(source => source.uri.toString() !== mainSource.uri.toString())
					.map(source => ({ uri: source.uri.toString(), text: source.content }));
				const jdt = await this.loadJdtWasm();
				const diagnostics = this.parseDiagnostics(jdt.lintProcessing(mainSource.uri.toString(), mainSource.content, JSON.stringify({ sources: additionalSources })));
				this.setMappedDiagnostics(sources, diagnostics);
			}
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
		const sources = [...(await collectSources('java')).sources];

		for (const document of vscode.workspace.textDocuments) {
			if (!isJavaUri(document.uri)) {
				continue;
			}
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
			if (!workspaceFolder) {
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
		const sources = [...(await collectSources('processing')).sources].filter(source => isInWorkspaceFolder(source.uri, workspaceFolder));

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

	private setEntrypointDiagnostics(workspaceFolder: vscode.WorkspaceFolder | undefined, sources: readonly WorkspaceSource[]): void {
		const message = workspaceFolder
			? `Cannot determine Processing entrypoint for a multi-file project. Put the sketch entrypoint in ${workspaceFolder.name}.pde or main.pde.`
			: 'Cannot determine Processing entrypoint for open tabs. Put the sketch entrypoint in main.pde.';
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

	private applyPublishDiagnostics(messages: readonly PublishDiagnosticsMessage[], uriMap?: ReadonlyMap<string, string>): void {
		for (const message of messages) {
			if (message.method !== 'textDocument/publishDiagnostics' || !message.params?.uri) {
				continue;
			}
			const uri = uriMap?.get(message.params.uri) ?? message.params.uri;
			this.diagnostics.set(vscode.Uri.parse(uri), (message.params.diagnostics ?? []).map(diagnostic => this.toDiagnostic(diagnostic)));
		}
	}

	private jdtSourceUri(source: WorkspaceSource): string {
		return vscode.workspace.getWorkspaceFolder(source.uri) ? source.uri.toString() : source.path;
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
