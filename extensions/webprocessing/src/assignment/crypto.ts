import type { AssignmentAnswerKey, AssignmentAnswerKeyPayload, AssignmentProof, AssignmentTest } from './types';

declare const TextEncoder: { new(): { encode(input?: string): Uint8Array } };
declare const TextDecoder: { new(): { decode(input?: Uint8Array): string } };
declare function btoa(input: string): string;
declare function atob(input: string): string;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const defaultIterations = 310000;
const esmImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, unknown>>;

export function normalizeOutput(output: string): string {
	return output.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\t ]+$/gm, '').trimEnd();
}

export function canonicalOutputText(testIds: readonly string[], outputs: ReadonlyMap<string, string>): string {
	return testIds.map(id => `${id}\0${normalizeOutput(outputs.get(id) ?? '')}`).join('\0');
}

export async function createProof(expectedOutput: string): Promise<AssignmentProof> {
	const salt = randomBytes(16);
	const digest = await deriveBytes(encoder.encode(normalizeOutput(expectedOutput)), salt, defaultIterations, 32);
	return {
		algorithm: 'PBKDF2-HMAC-SHA-256',
		iterations: defaultIterations,
		salt: encodeBase64Url(salt),
		digest: encodeBase64Url(digest)
	};
}

export async function verifyProof(actualOutput: string, proof: AssignmentProof): Promise<boolean> {
	if (proof.algorithm !== 'PBKDF2-HMAC-SHA-256') {
		return false;
	}
	const salt = decodeBase64Url(proof.salt);
	const expected = decodeBase64Url(proof.digest);
	const actual = await deriveBytes(encoder.encode(normalizeOutput(actualOutput)), salt, proof.iterations, expected.byteLength);
	return constantTimeEquals(actual, expected);
}

export async function createAnswerKey(tests: readonly AssignmentTest[], expectedOutputs: ReadonlyMap<string, string>): Promise<AssignmentAnswerKey> {
	const salt = randomBytes(16);
	const nonce = randomBytes(12);
	const hidden: Record<string, { expected_output: string }> = {};
	for (const test of tests) {
		if (test.visibility === 'hidden') {
			const expected = expectedOutputs.get(test.id);
			if (typeof expected === 'string') {
				hidden[test.id] = { expected_output: expected };
			}
		}
	}
	const plaintext = encoder.encode(JSON.stringify({ tests: hidden } satisfies AssignmentAnswerKeyPayload));
	const key = await deriveAnswerKey(tests.map(test => test.id), expectedOutputs, salt, defaultIterations);
	const ciphertext = await aesGcmEncrypt(key, nonce, plaintext);
	return {
		algorithm: 'AES-256-GCM',
		kdf: 'PBKDF2-HMAC-SHA-256',
		iterations: defaultIterations,
		salt: encodeBase64Url(salt),
		nonce: encodeBase64Url(nonce),
		ciphertext: encodeBase64Url(ciphertext)
	};
}

export async function decryptAnswerKey(answerKey: AssignmentAnswerKey, tests: readonly AssignmentTest[], actualOutputs: ReadonlyMap<string, string>): Promise<AssignmentAnswerKeyPayload | undefined> {
	if (answerKey.algorithm !== 'AES-256-GCM' || answerKey.kdf !== 'PBKDF2-HMAC-SHA-256') {
		return undefined;
	}
	try {
		const salt = decodeBase64Url(answerKey.salt);
		const nonce = decodeBase64Url(answerKey.nonce);
		const ciphertext = decodeBase64Url(answerKey.ciphertext);
		const key = await deriveAnswerKey(tests.map(test => test.id), actualOutputs, salt, answerKey.iterations);
		const plaintext = await aesGcmDecrypt(key, nonce, ciphertext);
		const decoded = JSON.parse(decoder.decode(plaintext)) as AssignmentAnswerKeyPayload;
		return decoded && typeof decoded === 'object' ? decoded : undefined;
	} catch {
		return undefined;
	}
}

export function encodeBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeBase64Url(value: string): Uint8Array {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	const cryptoLike = globalThis.crypto as Crypto | undefined;
	if (cryptoLike?.getRandomValues) {
		cryptoLike.getRandomValues(bytes);
		return bytes;
	}
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Math.floor(Math.random() * 256);
	}
	return bytes;
}

async function deriveAnswerKey(testIds: readonly string[], outputs: ReadonlyMap<string, string>, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const cumulativeHash = await sha256Bytes(encoder.encode(canonicalOutputText(testIds, outputs)));
	return deriveBytes(cumulativeHash, salt, iterations, 32);
}

async function sha256Bytes(input: Uint8Array): Promise<Uint8Array> {
	const subtle = globalThis.crypto?.subtle;
	if (subtle) {
		return new Uint8Array(await subtle.digest('SHA-256', toArrayBuffer(input)));
	}
	const module = await esmImport('@noble/hashes/sha2.js') as { readonly sha256: (input: Uint8Array) => Uint8Array };
	return module.sha256(input);
}

async function deriveBytes(password: Uint8Array, salt: Uint8Array, iterations: number, length: number): Promise<Uint8Array> {
	const subtle = globalThis.crypto?.subtle;
	if (subtle) {
		const material = await subtle.importKey('raw', toArrayBuffer(password), 'PBKDF2', false, ['deriveBits']);
		const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: toArrayBuffer(salt), iterations }, material, length * 8);
		return new Uint8Array(bits);
	}
	const [pbkdf2Module, sha2Module] = await Promise.all([
		esmImport('@noble/hashes/pbkdf2.js') as Promise<{ readonly pbkdf2: (hash: unknown, password: Uint8Array, salt: Uint8Array, options: { readonly c: number; readonly dkLen: number }) => Uint8Array }>,
		esmImport('@noble/hashes/sha2.js') as Promise<{ readonly sha256: unknown }>
	]);
	return pbkdf2Module.pbkdf2(sha2Module.sha256, password, salt, { c: iterations, dkLen: length });
}

async function aesGcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
	const subtle = globalThis.crypto?.subtle;
	if (subtle) {
		const cryptoKey = await subtle.importKey('raw', toArrayBuffer(key), 'AES-GCM', false, ['encrypt']);
		return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(nonce) }, cryptoKey, toArrayBuffer(plaintext)));
	}
	const module = await esmImport('@noble/ciphers/aes.js') as { readonly gcm: (key: Uint8Array, nonce: Uint8Array) => { readonly encrypt: (plaintext: Uint8Array) => Uint8Array } };
	return module.gcm(key, nonce).encrypt(plaintext);
}

async function aesGcmDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
	const subtle = globalThis.crypto?.subtle;
	if (subtle) {
		const cryptoKey = await subtle.importKey('raw', toArrayBuffer(key), 'AES-GCM', false, ['decrypt']);
		return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(nonce) }, cryptoKey, toArrayBuffer(ciphertext)));
	}
	const module = await esmImport('@noble/ciphers/aes.js') as { readonly gcm: (key: Uint8Array, nonce: Uint8Array) => { readonly decrypt: (ciphertext: Uint8Array) => Uint8Array } };
	return module.gcm(key, nonce).decrypt(ciphertext);
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) {
		return false;
	}
	let result = 0;
	for (let i = 0; i < a.byteLength; i++) {
		result |= a[i] ^ b[i];
	}
	return result === 0;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
