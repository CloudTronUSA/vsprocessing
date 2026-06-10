import * as vscode from 'vscode';
import type { BuildOutputKind } from '../core/types';
import { runtimeViewType } from '../core/constants';
import { teavmPackageUri } from '../compiler/teavmPackage';
import { createNonce, escapeScriptJson, readTemplate, renderTemplate } from '../utils';

export type RuntimeMessage =
	| { readonly type: 'log-raw'; readonly text: string }
	| { readonly type: 'started' }
	| { readonly type: 'stopped' };

export type RuntimeSource =
	| { readonly output: BuildOutputKind; readonly uri: vscode.Uri }
	| { readonly output: 'wasm-gc'; readonly bytes: Uint8Array }
	| { readonly output: 'js'; readonly text: string };

export class ProcessingRuntimePanel implements vscode.Disposable {
	private readonly panel: vscode.WebviewPanel;
	private pendingSource: RuntimeSource | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly scope: string,
		localRoot: vscode.Uri | undefined,
		private readonly onMessage: (message: RuntimeMessage) => void,
		onDispose: () => void
	) {
		const teavmRoot = vscode.Uri.joinPath(teavmPackageUri(extensionUri, 'package.json'), '..');
		const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
		this.panel = vscode.window.createWebviewPanel(runtimeViewType, 'Processing Runtime', vscode.ViewColumn.Beside, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: localRoot ? [teavmRoot, mediaRoot, localRoot] : [teavmRoot, mediaRoot]
		});
		this.panel.webview.onDidReceiveMessage(message => {
			if (message?.type === 'readyForArtifact') {
				if (this.pendingSource && !('uri' in this.pendingSource)) {
					void this.panel.webview.postMessage(this.pendingSource.output === 'js'
						? { type: 'jsText', text: this.pendingSource.text }
						: { type: 'wasmBytes', bytes: this.pendingSource.bytes });
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

	async run(source: RuntimeSource): Promise<void> {
		this.panel.reveal(vscode.ViewColumn.Beside);
		this.pendingSource = source;
		this.panel.webview.html = await this.getHtml(source);
	}

	stop(): void {
		this.panel.webview.postMessage({ type: 'stop' });
	}

	private async getHtml(source: RuntimeSource): Promise<string> {
		const nonce = createNonce();
		const payload = escapeScriptJson(JSON.stringify({
			output: source.output,
			artifactUri: 'uri' in source ? this.panel.webview.asWebviewUri(source.uri).toString() : '',
			wasmRuntimeUri: this.panel.webview.asWebviewUri(teavmPackageUri(this.extensionUri, 'compiler.wasm-runtime.js')).toString(),
			p5Uri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'p5.min.js')).toString()
		}));
		return renderTemplate(await readTemplate(this.extensionUri, 'processing-runtime.html'), {
			nonce,
			payload,
			cspSource: this.panel.webview.cspSource
		});
	}
}
