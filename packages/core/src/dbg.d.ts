// Build-internal `dbg` global (provided by the rspack `ProvidePlugin`) and the
// rspack module types (`import.meta.webpackContext`, also build-time).
//
// Source-only: this file is in the declaration program (`tsconfig.types.json`)
// so sources type-check, but it is never copied into `dist/types`. Consumers
// have neither global at runtime, and no emitted declaration references them.

/// <reference types="@rspack/core/module" />
import type { URLMeta } from "@rewriters/url";

export {};

declare global {
	const dbg: {
		log: (message: string, ...args: any[]) => void;
		warn: (message: string, ...args: any[]) => void;
		error: (message: string, ...args: any[]) => void;
		debug: (message: string, ...args: any[]) => void;
		time: (meta: URLMeta, before: number, type: string) => void;
	};
}
