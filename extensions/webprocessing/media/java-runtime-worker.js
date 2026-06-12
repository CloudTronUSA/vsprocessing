self.onmessage = event => {
	if (event.data?.type === 'run') {
		void run(event.data);
	}
};

const send = message => self.postMessage(message);
let currentCapture = false;

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
		const compilerModule = await import(new URL('teavm-javac.js', payload.runtimeUri).toString());
		const runtimeModule = await import(payload.runtimeUri);
		if (typeof compilerModule.createJavaProgram !== 'function') {
			throw new Error('teavm-javac.js did not export createJavaProgram().');
		}

		let finished = false;
		const finish = () => {
			if (!finished) {
				finished = true;
				send({ type: 'finished' });
			}
		};
		const program = await compilerModule.createJavaProgram(new Uint8Array(payload.wasmBytes), {
			runtimeModule,
			stdio: {
				stdin: payload.input || '',
				stdout: text => send({ type: 'stdout', text }),
				stderr: text => send({ type: 'stderr', text })
			}
		});
		await program.execute({
			args: [],
			timeoutMs: 10000,
			onFinish: finish
		});
		finish();
	} catch (error) {
		send({ type: 'error', text: toText(error) });
	}
}
