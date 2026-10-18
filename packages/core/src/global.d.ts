// Ambient globals for the Scramjet core build.
//
// This file is an input to the declaration build (`tsconfig.types.json`) but
// `tsc` never emits `.d.ts` inputs, so the declaration step copies it verbatim
// to `dist/types/global.d.ts` (see `TypeScriptDeclarationsPlugin` in the root
// `rspack.config.ts`). It is therefore written in the module form a published
// declaration needs: `export {}` makes `declare global` legal, the imports
// resolve the same way from `src/` and from `dist/types/`, and every name it
// mentions resolves for an external consumer compiling with
// `skipLibCheck: false`.
//
// One deliberate difference from a plain source-side ambient file: the `dbg`
// global (an rspack `ProvidePlugin` alias) and the `@rspack/core/module`
// reference live in `src/dbg.d.ts`, which is build-internal and is never copied.
// No emitted declaration references `dbg`, and consumers do not have that global
// at runtime.

import type { SCRAMJETCLIENT } from "./symbols";

export {};

declare global {
	interface Window {
		WASM: string;
		REAL_WASM: Uint8Array;

		/**
		 * Inert presence marker for the Scramjet realm this window belongs to.
		 *
		 * The live client is held off-global in a module `WeakMap`
		 * (client/clients.ts); this key only answers "is this a Scramjet realm?"
		 * for cross-realm hook coordination and exposes nothing. Declared required
		 * (not optional) so `X in window` narrowing of a `Window` value is
		 * unchanged from when this held the client.
		 */
		[SCRAMJETCLIENT]: true;
	}

	interface Document {
		/**
		 * Unused reader-side; kept so a stray `document[SCRAMJETCLIENT]` access
		 * stays well-typed. The client is not stored here.
		 */
		[SCRAMJETCLIENT]: true;
	}

	// eslint-disable-next-line scramjet-core/no-globals
	type GlobalThis = typeof globalThis;
	// eslint-disable-next-line scramjet-core/no-globals
	type Self = Window & GlobalThis;
}
