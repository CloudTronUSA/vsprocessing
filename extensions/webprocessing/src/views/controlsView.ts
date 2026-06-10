import * as vscode from 'vscode';
import type { ExtensionControlsViewState, ExtensionController, ProcessingOutputTarget } from '../core/types';
import { createNonce, escapeScriptJson, readTemplate, renderTemplate, type SourceKind } from '../utils';

type ControlsMessage =
	| { readonly type: 'compile' }
	| { readonly type: 'run' }
	| { readonly type: 'exportWebsite' }
	| { readonly type: 'stop' }
	| { readonly type: 'openReference' }
	| { readonly type: 'openApcsaReference' }
	| { readonly type: 'mode'; readonly mode: SourceKind }
	| { readonly type: 'processingOutput'; readonly output: ProcessingOutputTarget };

export class ExtensionControlsProvider implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly controller: ExtensionController
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

	private handleMessage(message: ControlsMessage): void {
		switch (message.type) {
			case 'compile':
				void this.controller.compile();
				break;
			case 'run':
				void this.controller.run();
				break;
			case 'exportWebsite':
				void this.controller.exportWebsite();
				break;
			case 'stop':
				this.controller.stop();
				break;
			case 'openReference':
				void this.controller.openReference();
				break;
			case 'openApcsaReference':
				void this.controller.openApcsaReference();
				break;
			case 'mode':
				this.controller.setMode(message.mode);
				break;
			case 'processingOutput':
				void this.controller.setProcessingOutput(message.output);
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
						: 'Compile a sketch to create an executable.';
		return {
			...state,
			status,
			warning: state.hasCompiled && state.isOutdated ? 'Warning: outdated executable.' : '',
		};
	}

	private async getHtml(state: ExtensionControlsViewState): Promise<string> {
		const nonce = createNonce();
		const initialState = escapeScriptJson(JSON.stringify(state));
		return renderTemplate(await readTemplate(this.extensionUri, 'processing-controls.html'), {
			nonce,
			initialState
		});
	}
}
