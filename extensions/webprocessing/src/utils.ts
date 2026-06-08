import * as vscode from 'vscode';
import type { ProcessingDiagnostic, ProcessingSketchTimings } from '../lib/teavm-javac/processing-teavm.js';
import type { ProcessingPreprocessResult, ProcessingSource } from '../lib/teavm-javac/teavm-javac.js';

declare const TextDecoder: {
	new(): { decode(input?: Uint8Array): string };
};

export async function collectProcessingSources(root: vscode.Uri): Promise<ProcessingSource[]> {
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

export function compiledFileUri(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
	return vscode.Uri.joinPath(workspaceFolder.uri, compiledFileName(workspaceFolder));
}

export function compiledFileName(workspaceFolder: vscode.WorkspaceFolder): string {
	return `${toFileBaseName(workspaceFolder.name, 'sketch')}.compiled.wasm`;
}

// check if any .pde file in the workspace folder is newer than the compiled file
export async function isCompiledOutdated(workspaceFolder: vscode.WorkspaceFolder, compiledMtime: number): Promise<boolean> {
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

export function isProcessingUri(uri: vscode.Uri): boolean {
	return uri.path.toLowerCase().endsWith('.pde');
}

function isInWorkspaceFolder(uri: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder): boolean {
	if (uri.scheme !== workspaceFolder.uri.scheme || uri.authority !== workspaceFolder.uri.authority) {
		return false;
	}
	const folderPath = workspaceFolder.uri.path.endsWith('/') ? workspaceFolder.uri.path : `${workspaceFolder.uri.path}/`;
	return uri.path === workspaceFolder.uri.path || uri.path.startsWith(folderPath);
}

export function identifyEntrypoint(sources: readonly ProcessingSource[], workspaceFolder: vscode.WorkspaceFolder): ProcessingSource | undefined {
	const folderName = workspaceFolder.name.toLowerCase();
	const candidates = [
		`${folderName}.pde`,
		'main.pde'
	];

	for (const candidate of candidates) {
		const index = sources.findIndex(source => source.path?.toLowerCase() === candidate);
		if (index >= 0) {
			return sources[index];
		}
	}

	return undefined;
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

// get file metadata
export async function statOrUndefined(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
	try {
		return await vscode.workspace.fs.stat(uri);
	} catch {
		return undefined;
	}
}

export function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
}

export function stripExtension(path: string): string {
	const basename = path.split('/').pop() ?? path;
	return basename.replace(/\.[^.]+$/, '');
}

export function toJavaIdentifier(value: string, fallback: string): string {
	const identifier = value.replace(/^[^A-Za-z_$]+/, '').replace(/[^A-Za-z0-9_$]/g, '_');
	return identifier || fallback;
}

function toFileBaseName(value: string, fallback: string): string {
	const fileName = value.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+$/, '').trim();
	return fileName || fallback;
}

export function stripWasmExtension(fileName: string): string {
	return fileName.toLowerCase().endsWith('.wasm') ? fileName.slice(0, -'.wasm'.length) : fileName;
}

export function formatDiagnostic(diagnostic: ProcessingDiagnostic): string {
	const type = diagnostic.type ?? 'compiler';
	const severity = diagnostic.severity ?? 'other';
	const file = diagnostic.fileName ? `${diagnostic.fileName}` : 'unknown';
	const line = diagnostic.lineNumber ? `:${diagnostic.lineNumber}` : '';
	const column = diagnostic.columnNumber ? `:${diagnostic.columnNumber}` : '';
	const message = diagnostic.message ?? String(diagnostic);
	return `[processing.compiler] ${file}${line}${column}: ${type} ${severity}: ${message}`.trim();
}

export function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	return `${(ms / 1000).toFixed(2)}s`;
}

export function formatTimings(timings: ProcessingSketchTimings): string {
	const parts: string[] = [];
	if (typeof timings.compileMs === 'number') {
		parts.push(`compile ${formatDuration(timings.compileMs)}`);
	}
	if (typeof timings.emitMs === 'number') {
		parts.push(`emit ${formatDuration(timings.emitMs)}`);
	}
	if (typeof timings.totalMs === 'number') {
		parts.push(`total ${formatDuration(timings.totalMs)}`);
	}
	if (typeof timings.workerStartupMs === 'number') {
		parts.push(`worker startup ${formatDuration(timings.workerStartupMs)}`);
	}
	if (typeof timings.compileRequestMs === 'number') {
		parts.push(`compile request ${formatDuration(timings.compileRequestMs)}`);
	}
	return parts.length ? parts.join(', ') : 'not reported';
}

export interface ProcessingCompileLikeError {
	readonly preprocessed?: ProcessingPreprocessResult;
	readonly diagnostics?: readonly ProcessingDiagnostic[];
}

export function createNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

export function escapeScriptJson(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\u003C');
}
