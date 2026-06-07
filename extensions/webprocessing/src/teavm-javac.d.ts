interface URL { }

export type BinaryInput = string | URL | ArrayBuffer | ArrayBufferView | Int8Array;

export interface CompilerDiagnostic {
	readonly type?: string;
	readonly severity?: string;
	readonly fileName?: string | null;
	readonly lineNumber?: number;
	readonly columnNumber?: number;
	readonly message?: string;
}

export interface ProcessingSource {
	readonly path?: string;
	readonly name?: string;
	readonly content: string;
}

export interface ProcessingIssue {
	readonly line: number;
	readonly column: number;
	readonly message: string;
}

export interface ProcessingPreprocessResult {
	readonly ok: boolean;
	readonly sourceFileName: string;
	readonly className: string;
	readonly javaSource: string;
	readonly issues: readonly ProcessingIssue[];
}

export interface EmitJsResult {
	readonly ok: boolean;
	readonly text: string | null;
}

export interface DiagnosticRegistration {
	dispose(): void;
	unsubscribe(): void;
}

export interface JavaCompiler {
	clearSources(): JavaCompiler;
	clearClassFiles(): JavaCompiler;
	clearDependencies(): JavaCompiler;
	onDiagnostic(listener: (diagnostic: CompilerDiagnostic) => void): DiagnosticRegistration;
	emitJs(options: { readonly mainClass: string; readonly fileName?: string; readonly module?: string; readonly sourceMap?: boolean }): EmitJsResult;
}

export interface ProcessingCompileResult {
	readonly compiler: JavaCompiler;
	readonly compiled: boolean;
	readonly diagnostics: readonly CompilerDiagnostic[];
	readonly preprocessed: ProcessingPreprocessResult;
	readonly launcherClass: string;
}

export interface ProcessingCompileOptions {
	readonly core?: BinaryInput;
	readonly compilerOptions?: {
		readonly compilerJsUrl?: string | URL;
		readonly javacClasslibUrl?: BinaryInput;
		readonly runtimeClasslibUrl?: BinaryInput;
	};
	readonly sketchName?: string;
	readonly sourceMaps?: boolean;
}

export function compileProcessingSketch(sources: readonly ProcessingSource[], options?: ProcessingCompileOptions): Promise<ProcessingCompileResult>;
