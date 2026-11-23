// NOTE: this is the entrypoint for scramjet.bundle.js
// as such it exports everything in scramjet
// the entry point for scramjet.all.js (what most sites wil use) is entry.ts

import "./global.d";
import { atob, _Uint8Array } from "@/shared/snapshot";
import { setWasm } from "@rewriters/wasm";
import { rewriteJs } from "@rewriters/js";
import { registerProviders } from "@/shared/providers";
import { ScramjetVersionInfo } from "./types";

declare const VERSION: string;
declare const COMMITHASH: string;
declare const BUILDDATE: string;
export const versionInfo: ScramjetVersionInfo = {
	version: VERSION,
	build: COMMITHASH,
	date: BUILDDATE,
};

export { defaultConfig, defaultConfigDev } from "./config";

// the full builds rewrite script text met inside HTML and URLs with the wasm
// rewriter; a runtime built without it leaves script text as it is
registerProviders({
	rewriteJs: (js, url, context, meta, isModule, functionBody, handlerPrelude) =>
		rewriteJs(
			js,
			url,
			context,
			meta,
			isModule,
			undefined,
			handlerPrelude ?? "",
			functionBody ?? false
		),
});

declare const REWRITERWASM: string | undefined;
// bundled build will have the wasm binary inlined as a base64 string
if (REWRITERWASM) {
	setWasm(_Uint8Array.from(atob(REWRITERWASM), (c) => c.charCodeAt(0)));
}

export * from "./symbols";
export * from "./types";
export * from "./Tap";
export * from "./shared";
export * from "./fetch";
// embedders that answer a fetch hook with a response of their own build it with this
export { BareResponse } from "@mercuryworkshop/proxy-transports";
export * from "./client";

export {
	identityName,
	keyedBuild,
	internalAttributePrefix,
	injectedAttribute,
	runtimeNamespace,
	controllerNamespace,
	wasmNamespace,
	messageFields,
	runtimeIdentity,
} from "./runtime-identity";
export { IDENTITY_NAMES, type IdentityName } from "./runtime-identity-names";
