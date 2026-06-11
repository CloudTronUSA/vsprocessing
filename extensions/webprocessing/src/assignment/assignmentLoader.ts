import * as vscode from 'vscode';
import type { Assignment, AssignmentAnswerKey, AssignmentConfig, AssignmentProof, AssignmentTest } from './types';
import { exists } from '../utils';

declare const TextDecoder: { new(): { decode(input?: Uint8Array): string } };

const decoder = new TextDecoder();

export async function loadAssignment(workspaceFolder: vscode.WorkspaceFolder | undefined): Promise<Assignment | undefined> {
	if (!workspaceFolder) {
		return undefined;
	}
	const uri = vscode.Uri.joinPath(workspaceFolder.uri, 'assignment.json');
	if (!await exists(uri)) {
		return undefined;
	}
	const text = decoder.decode(await vscode.workspace.fs.readFile(uri));
	const parsed = JSON.parse(text) as unknown;
	const config = parseAssignmentConfig(parsed);
	return { workspaceFolder, uri, config };
}

export function assignmentPath(assignment: Assignment, path: string): vscode.Uri {
	return vscode.Uri.joinPath(assignment.workspaceFolder.uri, ...path.split('/').filter(Boolean));
}

export function parseAssignmentConfig(value: unknown): AssignmentConfig {
	if (!isRecord(value)) {
		throw new Error('assignment.json must be a JSON object.');
	}
	const student_code = requiredString(value, 'student_code');
	const entrypoint = requiredString(value, 'entrypoint');
	const instructions = requiredString(value, 'instructions');
	if (!student_code.toLowerCase().endsWith('.java') || !entrypoint.toLowerCase().endsWith('.java')) {
		throw new Error('student_code and entrypoint must point to .java files.');
	}
	if (!instructions.toLowerCase().endsWith('.md')) {
		throw new Error('instructions must point to a markdown file.');
	}
	const rawTests = Array.isArray(value.tests) ? value.tests : undefined;
	if (!rawTests?.length) {
		throw new Error('assignment.json must include at least one test.');
	}
	const tests = rawTests.map(parseTest);
	const answer_key = value.answer_key === undefined ? undefined : parseAnswerKey(value.answer_key);
	return { student_code, entrypoint, instructions, tests, answer_key };
}

function parseTest(value: unknown): AssignmentTest {
	if (!isRecord(value)) {
		throw new Error('Each test must be a JSON object.');
	}
	const id = requiredString(value, 'id');
	const visibility = value.visibility === 'hidden' ? 'hidden' : value.visibility === 'visible' ? 'visible' : undefined;
	if (!visibility) {
		throw new Error(`Test ${id} must have visibility "visible" or "hidden".`);
	}
	const input = requiredString(value, 'input');
	const expected_output = typeof value.expected_output === 'string' ? value.expected_output : undefined;
	const show_input = typeof value.show_input === 'boolean' ? value.show_input : undefined;
	const proof = value.proof === undefined ? undefined : parseProof(value.proof);
	if (visibility === 'visible' && typeof expected_output !== 'string') {
		throw new Error(`Visible test ${id} must include expected_output.`);
	}
	if (visibility === 'hidden' && !proof) {
		throw new Error(`Hidden test ${id} must include proof.`);
	}
	return { id, visibility, input, expected_output, show_input, proof };
}

function parseProof(value: unknown): AssignmentProof {
	if (!isRecord(value)) {
		throw new Error('proof must be a JSON object.');
	}
	return {
		algorithm: value.algorithm === 'PBKDF2-HMAC-SHA-256' ? value.algorithm : fail('proof.algorithm must be PBKDF2-HMAC-SHA-256.'),
		iterations: requiredNumber(value, 'iterations'),
		salt: requiredString(value, 'salt'),
		digest: requiredString(value, 'digest')
	};
}

function parseAnswerKey(value: unknown): AssignmentAnswerKey {
	if (!isRecord(value)) {
		throw new Error('answer_key must be a JSON object.');
	}
	return {
		algorithm: value.algorithm === 'AES-256-GCM' ? value.algorithm : fail('answer_key.algorithm must be AES-256-GCM.'),
		kdf: value.kdf === 'PBKDF2-HMAC-SHA-256' ? value.kdf : fail('answer_key.kdf must be PBKDF2-HMAC-SHA-256.'),
		iterations: requiredNumber(value, 'iterations'),
		salt: requiredString(value, 'salt'),
		nonce: requiredString(value, 'nonce'),
		ciphertext: requiredString(value, 'ciphertext')
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`${key} must be a non-empty string.`);
	}
	return value;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${key} must be a positive integer.`);
	}
	return value;
}

function fail(message: string): never {
	throw new Error(message);
}
