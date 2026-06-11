import * as vscode from 'vscode';
import type { AssignmentReportState } from '../assignment/types';
import { createNonce, escapeScriptJson, readTemplate, renderTemplate } from '../utils';

type ReportMessage =
	| { readonly type: 'run' }
	| { readonly type: 'diff'; readonly id: string };

export interface AssignmentReportController {
	runAssignmentTests(): Promise<void>;
	diffAssignmentTest(id: string): Promise<void>;
	getAssignmentReportState(): AssignmentReportState;
}

export class AssignmentReportPanel implements vscode.Disposable {
	private readonly panel: vscode.WebviewPanel;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly controller: AssignmentReportController,
		onDispose: () => void
	) {
		this.panel = vscode.window.createWebviewPanel('webprocessing.testReport', 'Test Case Report', vscode.ViewColumn.Beside, {
			enableScripts: true,
			retainContextWhenHidden: true
		});
		this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message));
		this.panel.onDidDispose(onDispose);
		void this.refreshHtml();
	}

	dispose(): void {
		this.panel.dispose();
	}

	update(): void {
		void this.panel.webview.postMessage({ type: 'state', state: this.controller.getAssignmentReportState() });
	}

	reveal(): void {
		this.panel.reveal(vscode.ViewColumn.Beside);
	}

	private async refreshHtml(): Promise<void> {
		this.panel.webview.html = await this.getHtml(this.controller.getAssignmentReportState());
	}

	private handleMessage(message: ReportMessage): void {
		switch (message.type) {
			case 'run':
				void this.controller.runAssignmentTests();
				break;
			case 'diff':
				void this.controller.diffAssignmentTest(message.id);
				break;
		}
	}

	private async getHtml(state: AssignmentReportState): Promise<string> {
		const nonce = createNonce();
		return renderTemplate(await readTemplate(this.extensionUri, 'assignment-report.html'), {
			nonce,
			initialState: escapeScriptJson(JSON.stringify(state))
		});
	}
}
