import * as vscode from 'vscode';
import { createAnswerKey, createProof } from '../assignment/crypto';
import { parseAssignmentConfig } from '../assignment/assignmentLoader';
import type { AssignmentConfig, AssignmentTest } from '../assignment/types';
import { createNonce, escapeScriptJson, readTemplate, renderTemplate } from '../utils';

declare const TextDecoder: { new(): { decode(input?: Uint8Array): string } };
declare const TextEncoder: { new(): { encode(input?: string): Uint8Array } };

const decoder = new TextDecoder();
const encoder = new TextEncoder();

type EditorMessage =
	| { readonly type: 'save'; readonly draft: AssignmentEditorDraft };

interface AssignmentEditorDraft {
	readonly student_code: string;
	readonly entrypoint: string;
	readonly instructions: string;
	readonly tests: readonly AssignmentEditorTestDraft[];
}

interface AssignmentEditorTestDraft {
	readonly id: string;
	readonly visibility: 'visible' | 'hidden';
	readonly input: string;
	readonly expected_output: string;
	readonly show_input?: boolean;
}

export class AssignmentEditorPanel implements vscode.Disposable {
	private readonly panel: vscode.WebviewPanel;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly assignmentUri: vscode.Uri,
		private readonly onSaved: () => Promise<void>,
		onDispose: () => void
	) {
		this.panel = vscode.window.createWebviewPanel('webprocessing.assignmentEditor', 'Autograded Assignment Editor', vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true
		});
		this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message));
		this.panel.onDidDispose(onDispose);
	}

	dispose(): void {
		this.panel.dispose();
	}

	async open(): Promise<void> {
		this.panel.reveal(vscode.ViewColumn.Active);
		const config = await this.loadConfig();
		this.panel.webview.html = await this.getHtml(config);
	}

	private async loadConfig(): Promise<AssignmentConfig> {
		const text = decoder.decode(await vscode.workspace.fs.readFile(this.assignmentUri));
		return parseAssignmentConfig(JSON.parse(text));
	}

	private async handleMessage(message: EditorMessage): Promise<void> {
		if (message.type !== 'save') {
			return;
		}
		try {
			const existing = await this.loadConfig();
			const config = await this.buildConfig(existing, message.draft);
			parseAssignmentConfig(config);
			await vscode.workspace.fs.writeFile(this.assignmentUri, encoder.encode(`${JSON.stringify(config, null, 2)}\n`));
			await this.onSaved();
			void vscode.window.showInformationMessage('Autograded assignment saved.');
		} catch (error) {
			void vscode.window.showErrorMessage(`Could not save assignment: ${error}`);
		}
	}

	private async buildConfig(existing: AssignmentConfig, draft: AssignmentEditorDraft): Promise<AssignmentConfig> {
		const existingById = new Map(existing.tests.map(test => [test.id, test]));
		const tests: AssignmentTest[] = [];
		const expectedOutputs = new Map<string, string>();
		let needsNewAnswerKey = false;

		for (const draftTest of draft.tests) {
			const id = draftTest.id.trim();
			if (!id) {
				throw new Error('Every test needs an id.');
			}
			if (draftTest.visibility === 'visible') {
				tests.push({ id, visibility: 'visible', input: draftTest.input, expected_output: draftTest.expected_output });
				expectedOutputs.set(id, draftTest.expected_output);
				continue;
			}

			const previous = existingById.get(id);
			if (draftTest.expected_output.length > 0) {
				const proof = await createProof(draftTest.expected_output);
				tests.push({ id, visibility: 'hidden', input: draftTest.input, show_input: !!draftTest.show_input, proof });
				expectedOutputs.set(id, draftTest.expected_output);
				needsNewAnswerKey = true;
			} else if (previous?.visibility === 'hidden' && previous.proof) {
				tests.push({ id, visibility: 'hidden', input: draftTest.input, show_input: !!draftTest.show_input, proof: previous.proof });
			} else {
				throw new Error(`Hidden test ${id} needs an expected output to generate its proof.`);
			}
		}

		const answer_key = needsNewAnswerKey || !existing.answer_key
			? await createAnswerKey(tests, expectedOutputs)
			: existing.answer_key;
		return {
			student_code: draft.student_code.trim(),
			entrypoint: draft.entrypoint.trim(),
			instructions: draft.instructions.trim(),
			tests,
			answer_key
		};
	}

	private async getHtml(config: AssignmentConfig): Promise<string> {
		const nonce = createNonce();
		const state = {
			...config,
			tests: config.tests.map(test => ({
				id: test.id,
				visibility: test.visibility,
				input: test.input,
				expected_output: test.visibility === 'visible' ? test.expected_output ?? '' : '',
				show_input: test.show_input ?? test.visibility === 'visible'
			}))
		};
		return renderTemplate(await readTemplate(this.extensionUri, 'assignment-editor.html'), {
			nonce,
			initialState: escapeScriptJson(JSON.stringify(state))
		});
	}
}
