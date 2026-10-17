// V8 stack trace API (`Error.stackTraceLimit`, `Error.prepareStackTrace`).
//
// Source-only: this file is an input to the declaration program
// (`tsconfig.types.json`) so the sources that use the API type-check, and it is
// never copied into `dist/types`. It describes a host capability rather than a
// Scramjet API — no emitted declaration references these names, and a consumer's
// own `lib`/`@types` selection decides whether they exist in its program.
//
// Scramjet uses the hook to tell its own injected frames apart from the page's
// when cleaning error stacks, and raises the frame limit so a rewritten stack
// still reaches the original call site.
//
// @see https://v8.dev/docs/stack-trace-api

export {};

declare global {
	/** One frame of a structured V8 stack trace. */
	interface V8CallSite {
		/** The script name or url, absent for eval'd and native frames. */
		getFileName(): string | undefined;
		getFunctionName(): string | null;
		getLineNumber(): number | undefined;
		getColumnNumber(): number | undefined;
	}

	interface ErrorConstructor {
		/** How many frames V8 captures before truncating. */
		stackTraceLimit: number;
		/**
		 * Structured stack trace hook. Whatever it returns becomes `err.stack`,
		 * including non-strings — which is how a wrapped internal error carries its
		 * original stack through to the handler that unwraps it.
		 */
		prepareStackTrace?: (error: Error, stackTraces: V8CallSite[]) => unknown;
	}
}
