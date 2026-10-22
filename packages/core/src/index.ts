// NOTE: this is the entrypoint for scramjet.bundle.js
// as such it exports everything in scramjet
// the entry point for scramjet.all.js (what most sites wil use) is entry.ts

/// <reference path="./global.d.ts" />
// A path reference, not `import "./global.d"`. The ambient file is a
// declaration, so importing it emitted `import "./global.d"` into
// `dist/types/index.d.ts`, and that specifier names no file the package
// contains: there is no `global.d.js`, and `./global.d` only resolves through
// the compiler's own extension probing. `tsc` drops a path reference from
// declaration emit (it assumes ambient types are simply available), so the
// declaration step re-adds it to the emitted entry next to the copied file — see
// `declarationReferences` in the root `rspack.config.ts`. The reference here is
// what keeps the ambient globals in the source program itself.
import { atob } from "@/shared/snapshot";
import { registerProviders } from "@/shared/providers";
import { rewriteJs } from "@rewriters/js";
import { setWasm } from "@rewriters/wasm";
import { ScramjetVersionInfo, ScramjetConfig } from "./types";

declare const VERSION: string;
declare const COMMITHASH: string;
declare const BUILDDATE: string;
export const versionInfo: ScramjetVersionInfo = {
	version: VERSION,
	build: COMMITHASH,
	date: BUILDDATE,
};

export { defaultConfig, defaultConfigDev } from "./config";
export { realmDocumentEventType } from "@rewriters/realm";

// The full builds rewrite script text met inside HTML and URLs with the wasm rewriter; builds
// without it leave script text as it is
registerProviders({ rewriteJs });

declare const REWRITERWASM: string | undefined;
// bundled build will have the wasm binary inlined as a base64 string
if (REWRITERWASM) {
	setWasm(Uint8Array.from(atob(REWRITERWASM), (c) => c.charCodeAt(0)));
}

export * from "./symbols";
export * from "./types";
export * from "./Tap";
export * from "./shared";
export * from "./fetch";
export { BareResponse } from "@mercuryworkshop/proxy-transports";
export * from "./client";
export { createWorkerTransport } from "./client/worker-transport";

export {
	identityName,
	internalAttribute,
	internalAttributePrefix,
	injectedAttribute,
	runtimeNamespace,
	controllerNamespace,
	wasmNamespace,
	messageFields,
	runtimeIdentity,
} from "./runtime-identity";
