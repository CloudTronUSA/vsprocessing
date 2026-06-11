self.onmessage = event => {
	if (event.data?.type === 'run') {
		void run(event.data);
	}
};

const send = message => self.postMessage(message);
let currentCapture = false;
let inputBytes = new Uint8Array();
let inputOffset = 0;

function toText(value) {
	if (value instanceof Error) {
		return formatError(value);
	}
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function formatError(error) {
	const stack = error.stack || `${error.name}: ${error.message}`;
	const message = error.message || '';
	const inferred = inferJavaError(stack, message);
	if (!inferred) {
		return stack;
	}
	if (stack.startsWith(inferred)) {
		return stack;
	}
	return `${inferred}\n${stack}`;
}

function inferJavaError(stack, message) {
	if (message && message !== 'Error') {
		return message;
	}
	const javaExceptionFrame = String(stack).match(/\bat ([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)::<init>/);
	if (javaExceptionFrame?.[1] && javaExceptionFrame[1] !== 'java.lang.Throwable') {
		return javaExceptionFrame[1];
	}
	if (String(stack).includes('java.lang.ConsoleInputStream::read')) {
		return 'java.io.EOFException: standard input ended before the program finished reading';
	}
	return '';
}

for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
	const original = console[level].bind(console);
	console[level] = (...values) => {
		send({ type: 'log', level, text: values.map(toText).join(' ') });
		if (!currentCapture) {
			original(...values);
		}
	};
}

async function run(payload) {
	try {
		currentCapture = !!payload.capture;
		const runtimeModule = await import(payload.runtimeUri);
		const runtimeOptions = await createRuntimeOptions(payload);
		const runtime = await runtimeModule.load(new Uint8Array(payload.wasmBytes), runtimeOptions);
		const main = runtime.exports?.main;
		if (typeof main !== 'function') {
			throw new Error('Compiled Java program did not export main().');
		}
		await Promise.resolve(main([]));
		send({ type: 'finished' });
	} catch (error) {
		send({ type: 'error', text: toText(error) });
	}
}

async function createRuntimeOptions(payload) {
	try {
		const helperModule = await import(new URL('teavm-javac.js', payload.runtimeUri).toString());
		if (typeof helperModule.createJavaRuntimeOptions === 'function') {
			return helperModule.createJavaRuntimeOptions({
				stdin: payload.input || '',
				stdout: text => send({ type: 'log', level: 'log', text }),
				stderr: text => send({ type: 'log', level: 'error', text })
			});
		}
	} catch {
		// Fall through to the lower-level import hook for older package builds.
	}
	inputBytes = new TextEncoder().encode(payload.input || '');
	inputOffset = 0;
	return {
		installImports(imports) {
			imports.teavmConsole = {
				...imports.teavmConsole,
				readStdin() {
					return inputOffset < inputBytes.length ? inputBytes[inputOffset++] : -1;
				}
			};
		}
	};
}
