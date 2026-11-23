// NOTE: this is the entrypoint for scramjet.bundle.js
// as such it exports everything in scramjet
// the entry point for scramjet.all.js (what most sites wil use) is entry.ts

import "./global.d";
import { atob, _Uint8Array } from "@/shared/snapshot";
import { setWasm } from "@rewriters/wasm";
import { identityName, runtimeIdentity } from "./runtime-identity";
import { pstAvailable } from "@/shared/incumbency";
import { ScramjetVersionInfo, ScramjetConfig } from "./types";

declare const VERSION: string;
declare const COMMITHASH: string;
declare const BUILDDATE: string;
export const versionInfo: ScramjetVersionInfo = {
	version: VERSION,
	build: COMMITHASH,
	date: BUILDDATE,
};

export const defaultConfig: ScramjetConfig = {
	globals: {
		wrapfn: identityName("$scramjet$wrap"),
		wrappropertybase: identityName("$scramjet__"),
		wrappropertyfn: identityName("$scramjet$prop"),
		callfn: identityName("$scramjet$call"),
		cleanrestfn: identityName("$scramjet$clean"),
		importfn: identityName("$scramjet$import"),
		rewritefn: identityName("$scramjet$rewrite"),
		metafn: identityName("$scramjet$meta"),
		pushsourcemapfn: identityName("$scramjet$pushsourcemap"),
		registerrealmfn: identityName("$scramjet$registerrealm"),
		standinfn: identityName("$scramjet$standin"),
		trysetfn: identityName("$scramjet$tryset"),
		templocid: identityName("$scramjet$temploc"),
		tempreceiverid: identityName("$scramjet$tempreceiver"),
		tempcalleeid: identityName("$scramjet$tempcallee"),
		tempunusedid: identityName("$scramjet$tempunused"),
	},
	flags: {
		syncxhr: false,
		disableComputedWrap: false,
		rewriterLogs: false,
		captureErrors: false,
		cleanErrors: true,
		sourcemaps: true,
		destructureRewrites: true,
		allowInvalidJs: true,
		debugTrampolines: false,
		encapsulateWorkers: true,
		debugSourceURL: false,
		incumbency: pstAvailable ? "pst" : "lazystamp",
	},
	maskedfiles: [],
	identity: runtimeIdentity,
};

export const defaultConfigDev: ScramjetConfig = {
	...defaultConfig,
	flags: {
		...defaultConfig.flags,
		rewriterLogs: false,
		captureErrors: true,
		cleanErrors: false,
		debugTrampolines: true,
		debugSourceURL: true,
		allowInvalidJs: false,
	},
};

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
