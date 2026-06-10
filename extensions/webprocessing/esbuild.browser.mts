/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { copyFile, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import esbuild from 'esbuild';

const srcDir = path.join(import.meta.dirname, 'src');
const outDir = path.join(import.meta.dirname, 'dist', 'browser');
const require = createRequire(import.meta.url);

const options: esbuild.BuildOptions = {
	platform: 'browser',
	bundle: true,
	minify: true,
	treeShaking: true,
	sourcemap: true,
	target: ['es2024'],
	external: ['vscode'],
	format: 'cjs',
	mainFields: ['browser', 'module', 'main'],
	alias: {
		'path': 'path-browserify',
	},
	define: {
		'process.platform': JSON.stringify('web'),
		'process.env': JSON.stringify({}),
		'process.env.BROWSER_ENV': JSON.stringify('true'),
	},
	logOverride: {
		'import-is-undefined': 'error',
	},
	entryPoints: {
		'extension': path.join(srcDir, 'extension.ts'),
	},
	outdir: outDir,
	tsconfig: path.join(import.meta.dirname, 'tsconfig.browser.json'),
};

if (process.argv.includes('--watch')) {
	const context = await esbuild.context(options);
	await context.watch();
	await afterBuild();
	console.log('[watch] webprocessing browser bundle is watching');
} else {
	try {
		await esbuild.build(options);
		await afterBuild();
	} catch {
		process.exit(1);
	}
}

async function afterBuild(): Promise<void> {
	await copyPackage('@worldeditaxe/teavm-javac', 'teavm-javac');
	await writeTeaVmCompilerModule();
	await copyProcessingCoreJar();
	await copyPackage('eclipse-jdt-ls-web', 'eclipse-jdt-ls-web');

	const pdfjsOutDir = path.join(import.meta.dirname, 'media', 'pdfjs');
	const pdfjsBuildDir = path.join(import.meta.dirname, 'node_modules', 'pdfjs-dist', 'build');
	const pdfjsBuildOutDir = path.join(pdfjsOutDir, 'build');
	await mkdir(pdfjsBuildOutDir, { recursive: true });
	await copyFile(path.join(pdfjsBuildDir, 'pdf.mjs'), path.join(pdfjsBuildOutDir, 'pdf.mjs'));
	await copyFile(path.join(pdfjsBuildDir, 'pdf.mjs.map'), path.join(pdfjsBuildOutDir, 'pdf.mjs.map'));
	await copyFile(path.join(pdfjsBuildDir, 'pdf.worker.mjs'), path.join(pdfjsBuildOutDir, 'pdf.worker.mjs'));
	await copyFile(path.join(pdfjsBuildDir, 'pdf.worker.mjs.map'), path.join(pdfjsBuildOutDir, 'pdf.worker.mjs.map'));
	await copyFile(path.join(pdfjsBuildDir, 'pdf.sandbox.mjs'), path.join(pdfjsBuildOutDir, 'pdf.sandbox.mjs'));
	await copyFile(path.join(pdfjsBuildDir, 'pdf.sandbox.mjs.map'), path.join(pdfjsBuildOutDir, 'pdf.sandbox.mjs.map'));
}

async function copyPackage(packageName: string, vendorName: string): Promise<void> {
	const packageDir = path.dirname(require.resolve(packageName));
	const vendorDir = path.join(outDir, 'vendor', vendorName);
	await rm(vendorDir, { recursive: true, force: true });
	await cp(packageDir, vendorDir, { recursive: true });
}

async function writeTeaVmCompilerModule(): Promise<void> {
	const modulePath = path.join(outDir, 'vendor', 'teavm-javac', 'compiler.module.js');
	await writeFile(modulePath, `const globalObject = globalThis;
const previousDefine = globalObject.define;
const hadSelf = 'self' in globalObject;
const previousSelf = globalObject.self;
try {
\tglobalObject.define = undefined;
\tif (!hadSelf) {
\t\tglobalObject.self = globalObject;
\t}
\tawait import('./compiler.js');
} finally {
\tglobalObject.define = previousDefine;
\tif (!hadSelf) {
\t\tdelete globalObject.self;
\t}
}

export const Compiler = globalObject.Compiler;
export const ProcessingPreprocessResult = globalObject.ProcessingPreprocessResult;
export const ListenerRegistration = globalObject.ListenerRegistration;
export const TeaVMDiagnostic = globalObject.TeaVMDiagnostic;
export const JavaDiagnostic = globalObject.JavaDiagnostic;
export const createCompiler = globalObject.createCompiler;
export const installWorker = globalObject.installWorker;
`);
}

async function copyProcessingCoreJar(): Promise<void> {
	const packageDir = path.dirname(require.resolve('@worldeditaxe/teavm-javac'));
	const candidates = [
		path.join(packageDir, 'processing-core-teavm.jar'),
		path.join(import.meta.dirname, 'lib', 'teavm-javac', 'dist', 'teavm-javac', 'processing-core-teavm.jar'),
		path.resolve(import.meta.dirname, '..', '..', '..', 'teavm-javac', 'teavm-javac', 'dist', 'teavm-javac', 'processing-core-teavm.jar'),
	];
	const jar = candidates.find(candidate => existsSync(candidate));
	if (!jar) {
		throw new Error(`processing-core-teavm.jar was not found. Checked: ${candidates.join(', ')}`);
	}
	await copyFile(jar, path.join(outDir, 'vendor', 'teavm-javac', 'processing-core-teavm.jar'));
}
