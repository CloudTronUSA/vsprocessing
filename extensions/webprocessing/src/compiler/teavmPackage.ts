import * as vscode from 'vscode';

const importModule = new Function('specifier', 'return import(specifier);') as <T>(specifier: string) => Promise<T>;

const teavmPackageFiles: Record<string, string> = {
	'': 'teavm-javac.js',
	'processing': 'processing-teavm.js'
};

export function teavmPackageUri(extensionUri: vscode.Uri, exportName = ''): vscode.Uri {
	return vscode.Uri.joinPath(
		extensionUri,
		'dist',
		'browser',
		'vendor',
		'teavm-javac',
		teavmPackageFiles[exportName] ?? exportName
	);
}

export class TeaVmPackage {
	private compilerPackage: Promise<typeof import('@worldeditaxe/teavm-javac')> | undefined;
	private processingPackage: Promise<typeof import('@worldeditaxe/teavm-javac/processing')> | undefined;

	constructor(private readonly extensionUri: vscode.Uri) { }

	async compiler(): Promise<typeof import('@worldeditaxe/teavm-javac')> {
		if (!this.compilerPackage) {
			this.compilerPackage = importModule<typeof import('@worldeditaxe/teavm-javac')>(this.moduleUri().toString());
		}
		return this.compilerPackage;
	}

	async processing(): Promise<typeof import('@worldeditaxe/teavm-javac/processing')> {
		if (!this.processingPackage) {
			this.processingPackage = importModule<typeof import('@worldeditaxe/teavm-javac/processing')>(this.processingModuleUri().toString());
		}
		return this.processingPackage;
	}

	assetUri(name: string): vscode.Uri {
		return teavmPackageUri(this.extensionUri, name);
	}

	assetImportUri(name: string): string {
		return this.assetUri(name).toString();
	}

	private moduleUri(): vscode.Uri {
		return teavmPackageUri(this.extensionUri);
	}

	private processingModuleUri(): vscode.Uri {
		return teavmPackageUri(this.extensionUri, 'processing');
	}
}
