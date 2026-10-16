/**
 * Scramjet's client without the proxy: the Proxy and Trap hooking the full client uses, a Wisp
 * transport that starts on first use, and requests performed over it. It has no URL rewriting,
 * rewriter wasm, service worker or location emulation; whoever embeds it supplies the hooks.
 */
import {
	JSON_stringify,
	Object_defineProperty,
	Object_setPrototypeOf,
	Reflect_apply,
	Reflect_construct,
	Reflect_get,
	URL_createObjectURL,
} from "@/shared/snapshot";

export {
	ScramjetMinimalClient,
	type ScramjetMinimalConfig,
	type ScramjetMinimalOptions,
	type ScramjetMinimalRoute,
} from "./client";
export { LazyTransport, PortTransport, serveTransport } from "./transport";
export { NativeMap, NativeSet, NativeURL, NativeWeakMap, NativeWeakSet } from "./natives";
export type * from "./types";

/** Built-ins captured before page scripts run, for hooks that must not see a page's replacements */
export const natives = {
	JSON_stringify,
	Object_defineProperty,
	Object_setPrototypeOf,
	Reflect_apply,
	Reflect_construct,
	Reflect_get,
	URL_createObjectURL,
};
