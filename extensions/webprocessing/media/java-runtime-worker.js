self.onmessage = event => {
	if (event.data?.type === 'run') {
		void run(event.data);
	}
};

const send = message => self.postMessage(message);

function toText(value) {
	if (value instanceof Error) {
		return value.stack || `${value.name}: ${value.message}`;
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

for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
	const original = console[level].bind(console);
	console[level] = (...values) => {
		send({ type: 'log', text: values.map(toText).join(' ') });
		original(...values);
	};
}

async function run(payload) {
	try {
		const runtimeModule = await import(payload.runtimeUri);
		const runtime = await runtimeModule.load(new Uint8Array(payload.wasmBytes), {});
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
