import * as vscode from 'vscode';
import type { BuildArtifact } from '../core/types';

interface JavaRuntimeMessage {
	readonly type?: string;
	readonly text?: string;
}

export class JavaRunner implements vscode.Disposable {
	private worker: Worker | undefined;
	private runId = 0;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly runtimeUri: () => string,
		private readonly log: (message?: string) => void,
		private readonly showOutput: () => void,
		private readonly setRunning: (running: boolean) => void,
		private readonly refreshState: () => Promise<void>
	) { }

	dispose(): void {
		this.stop(false);
	}

	async run(artifact: BuildArtifact): Promise<void> {
		this.showOutput();
		if (artifact.outdated) {
			this.log('[runtime] Warning: Running an outdated executable. The output may not include your latest saved or unsaved changes.');
		}
		this.log(`[runtime] Running ${artifact.name}...\n`);
		this.stop(false);
		this.setRunning(true);
		await this.refreshState();

		try {
			const runId = ++this.runId;
			const sourceBytes = artifact.bytes ?? await vscode.workspace.fs.readFile(artifact.uri!);
			const wasmBytes = new Uint8Array(sourceBytes);
			const worker = new Worker(vscode.Uri.joinPath(this.extensionUri, 'media', 'java-runtime-worker.js').toString(), {
				name: 'webprocessing-java-runtime'
			});
			this.worker = worker;
			worker.onmessage = event => this.handleMessage(runId, event.data);
			worker.onerror = event => {
				if (runId !== this.runId) {
					return;
				}
				this.log(`[runtime] ${event.message}`);
				this.stop(false);
				this.setRunning(false);
				void this.refreshState();
			};
			worker.postMessage({
				type: 'run',
				runtimeUri: this.runtimeUri(),
				wasmBytes
			}, [wasmBytes.buffer]);
		} catch (error) {
			this.log(`[runtime] ${error}`);
			void vscode.window.showErrorMessage(vscode.l10n.t('Java runtime failed. See the Processing output channel.'));
			this.setRunning(false);
			await this.refreshState();
		}
	}

	stop(log = true): void {
		if (!this.worker) {
			return;
		}
		this.runId++;
		this.worker.terminate();
		this.worker = undefined;
		if (log) {
			this.showOutput();
			this.log('[runtime] Runtime stopped.');
		}
	}

	private handleMessage(runId: number, message: JavaRuntimeMessage): void {
		if (runId !== this.runId) {
			return;
		}
		switch (message.type) {
			case 'log':
				this.showOutput();
				this.log(`${message.text ?? ''}`);
				break;
			case 'finished':
				this.showOutput();
				this.log('[runtime] Runtime finished.');
				this.stop(false);
				this.setRunning(false);
				void this.refreshState();
				break;
			case 'error':
				this.showOutput();
				this.log(`[runtime] ${message.text ?? 'Runtime failed.'}`);
				this.stop(false);
				this.setRunning(false);
				void this.refreshState();
				void vscode.window.showErrorMessage(vscode.l10n.t('Java runtime failed. See the Processing output channel.'));
				break;
		}
	}
}
