import * as vscode from 'vscode';
import { loadCsptAssignment, readAssignmentData } from '../assignment/assignmentLoader';
import type { AssignmentCheck, AssignmentViewState, CsptAssignment } from '../assignment/types';
import { createNonce, escapeScriptJson, readTemplate, renderTemplate } from '../utils';

type AssignmentViewMessage =
	| { readonly type: 'start' }
	| { readonly type: 'restart' }
	| { readonly type: 'evaluate' };

export interface AssignmentViewController {
	startAssignment(assignment: CsptAssignment): Promise<void>;
	restartAssignment(assignment: CsptAssignment): Promise<void>;
	evaluateAssignment(assignment: CsptAssignment): Promise<void>;
}

export class AssignmentViewProvider implements vscode.CustomReadonlyEditorProvider {
	static readonly viewType = 'webprocessing.csptAssignment';

	private readonly panels = new Map<string, vscode.WebviewPanel>();
	private readonly running = new Set<string>();

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly controller: AssignmentViewController
	) { }

	async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
		return { uri, dispose() { } };
	}

	async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
		const key = document.uri.toString();
		this.panels.set(key, panel);
		panel.webview.options = { enableScripts: true };
		panel.webview.onDidReceiveMessage(message => this.handleMessage(document.uri, message));
		panel.onDidDispose(() => this.panels.delete(key));
		await this.refresh(document.uri);
	}

	async refresh(uri: vscode.Uri): Promise<void> {
		const panel = this.panels.get(uri.toString());
		if (!panel) {
			return;
		}
		panel.webview.html = await this.getHtml(await loadCsptAssignment(this.extensionUri, uri));
	}

	private async handleMessage(uri: vscode.Uri, message: AssignmentViewMessage): Promise<void> {
		const key = uri.toString();
		if (this.running.has(key)) {
			return;
		}
		const assignment = await loadCsptAssignment(this.extensionUri, uri);
		switch (message.type) {
			case 'start':
				await this.controller.startAssignment(assignment);
				break;
			case 'restart':
				await this.controller.restartAssignment(assignment);
				break;
			case 'evaluate':
				this.running.add(key);
				await this.update(uri);
				try {
					await this.controller.evaluateAssignment(assignment);
				} finally {
					this.running.delete(key);
				}
				break;
		}
		await this.update(uri);
	}

	private async update(uri: vscode.Uri): Promise<void> {
		const panel = this.panels.get(uri.toString());
		if (!panel) {
			return;
		}
		await panel.webview.postMessage({ type: 'state', state: await this.getState(await loadCsptAssignment(this.extensionUri, uri)) });
	}

	private async getHtml(assignment: CsptAssignment): Promise<string> {
		const nonce = createNonce();
		return renderTemplate(await readTemplate(this.extensionUri, 'assignment-view.html'), {
			nonce,
			initialState: escapeScriptJson(JSON.stringify(await this.getState(assignment)))
		});
	}

	private async getState(assignment: CsptAssignment): Promise<AssignmentViewState> {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		const data = await readAssignmentData(workspaceFolder);
		const active = data?.id === assignment.id;
		const running = this.running.has(assignment.uri.toString());
		const results = new Map((active ? data.results ?? [] : []).map(result => [result.id, result]));
		return {
			id: assignment.id,
			displayName: assignment.displayName,
			description: assignment.description,
			started: active,
			running,
			results: assignment.checks.map(check => {
				const result = results.get(check.id);
				return {
					id: check.id,
					displayName: this.checkDisplayName(check),
					description: check.hidden ? undefined : check.description,
					passed: result?.passed,
					reason: result?.reason
				};
			}),
			message: active ? '' : 'Start the assignment to extract template files into this workspace.'
		};
	}

	private checkDisplayName(check: AssignmentCheck): string {
		if (check.hidden) {
			return 'Hidden check';
		}
		const name = check.displayName ?? check.id;
		return `${check.id}: ${name}`;
	}
}
