import * as vscode from 'vscode';
import { createAnswerKey, createProof } from './crypto';
import type { AssignmentConfig, AssignmentTest } from './types';
import { exists } from '../utils';

declare const TextEncoder: { new(): { encode(input?: string): Uint8Array } };

const encoder = new TextEncoder();

export async function createAssignmentScaffold(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
	const assignmentUri = vscode.Uri.joinPath(workspaceFolder.uri, 'assignment.json');
	if (await exists(assignmentUri)) {
		const overwrite = await vscode.window.showWarningMessage('assignment.json already exists. Overwrite it?', { modal: true }, 'Overwrite');
		if (overwrite !== 'Overwrite') {
			return;
		}
	}

	const visibleExpected = '5\n';
	const hiddenExpected = '30\n';
	const tests: AssignmentTest[] = [
		{ id: 'sample_1', visibility: 'visible', input: '2 3\n', expected_output: visibleExpected },
		{ id: 'hidden_1', visibility: 'hidden', input: '10 20\n', show_input: false, proof: await createProof(hiddenExpected) }
	];
	const expected = new Map<string, string>([
		['sample_1', visibleExpected],
		['hidden_1', hiddenExpected]
	]);
	const config: AssignmentConfig = {
		student_code: 'src/Solution.java',
		entrypoint: 'src/Main.java',
		instructions: 'README.md',
		tests,
		answer_key: await createAnswerKey(tests, expected)
	};

	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceFolder.uri, 'src'));
	await writeFile(vscode.Uri.joinPath(workspaceFolder.uri, 'README.md'), readmeText());
	await writeFile(vscode.Uri.joinPath(workspaceFolder.uri, 'src', 'Solution.java'), solutionText());
	await writeFile(vscode.Uri.joinPath(workspaceFolder.uri, 'src', 'Main.java'), mainText());
	await writeFile(assignmentUri, `${JSON.stringify(config, null, 2)}\n`);
}

async function writeFile(uri: vscode.Uri, text: string): Promise<void> {
	await vscode.workspace.fs.writeFile(uri, encoder.encode(text));
}

function readmeText(): string {
	return `# Sum Two Integers\n\nWrite \`Solution.sum\` so it returns the sum of the two integers read from standard input.\n\n## Input\n\nTwo integers separated by whitespace.\n\n## Output\n\nThe sum of the two integers followed by a newline.\n`;
}

function solutionText(): string {
	return `public class Solution {\n\tpublic static int sum(int a, int b) {\n\t\treturn a + b;\n\t}\n}\n`;
}

function mainText(): string {
	return `import java.util.Scanner;\n\npublic class Main {\n\tpublic static void main(String[] args) {\n\t\tScanner scanner = new Scanner(System.in);\n\t\tint a = scanner.nextInt();\n\t\tint b = scanner.nextInt();\n\t\tSystem.out.println(Solution.sum(a, b));\n\t}\n}\n`;
}
