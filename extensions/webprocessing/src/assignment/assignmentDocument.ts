import * as vscode from 'vscode';

export class AssignmentTextDocumentProvider implements vscode.TextDocumentContentProvider {
	private readonly documents = new Map<string, string>();
	private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.emitter.event;

	set(uri: vscode.Uri, content: string): void {
		this.documents.set(uri.toString(), content);
		this.emitter.fire(uri);
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.documents.get(uri.toString()) ?? '';
	}
}
