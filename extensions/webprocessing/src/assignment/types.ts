import * as vscode from 'vscode';

export interface AssignmentProof {
	readonly algorithm: 'PBKDF2-HMAC-SHA-256';
	readonly iterations: number;
	readonly salt: string;
	readonly digest: string;
}

export interface AssignmentAnswerKey {
	readonly algorithm: 'AES-256-GCM';
	readonly kdf: 'PBKDF2-HMAC-SHA-256';
	readonly iterations: number;
	readonly salt: string;
	readonly nonce: string;
	readonly ciphertext: string;
}

export interface AssignmentTest {
	readonly id: string;
	readonly visibility: 'visible' | 'hidden';
	readonly input: string;
	readonly expected_output?: string;
	readonly show_input?: boolean;
	readonly proof?: AssignmentProof;
}

export interface AssignmentConfig {
	readonly student_code: string;
	readonly entrypoint: string;
	readonly instructions: string;
	readonly tests: readonly AssignmentTest[];
	readonly answer_key?: AssignmentAnswerKey;
}

export interface Assignment {
	readonly workspaceFolder: vscode.WorkspaceFolder;
	readonly uri: vscode.Uri;
	readonly config: AssignmentConfig;
}

export interface AssignmentCaseResult {
	readonly id: string;
	readonly visibility: 'visible' | 'hidden';
	readonly input?: string;
	readonly expected_output?: string;
	readonly actual_output: string;
	readonly passed: boolean;
	readonly error?: string;
	readonly diff_available: boolean;
}

export interface AssignmentReportState {
	readonly assignment_mode: boolean;
	readonly title: string;
	readonly running: boolean;
	readonly unlocked: boolean;
	readonly results: readonly AssignmentCaseResult[];
	readonly message: string;
}

export interface AssignmentAnswerKeyPayload {
	readonly tests?: Record<string, { readonly expected_output?: string }>;
}
