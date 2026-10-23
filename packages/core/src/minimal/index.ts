/**
 * Scramjet's client without the proxy: the hooking the full client uses, a URL codec, a Wisp
 * transport that starts on first use or runs over the host's link, and a plugin installer for
 * pages, workers and nested windows. It has no rewriter wasm, service worker or location
 * emulation; what it intercepts comes from its plugins.
 */
export {
	ScramjetMinimalClient,
	type ScramjetMinimalConfig,
	type ScramjetMinimalOptions,
	type ScramjetMinimalRoute,
} from "./client";
export {
	install,
	attach,
	register,
	registered,
	installed,
	prepare,
	worker,
	workerLink,
	WORKER_INIT,
	SHARED_CONNECT,
	workerMessageTypes,
	type InstallOptions,
} from "./install";
export {
	requestLink,
	acceptLinks,
	LINK_KEY,
	LINK_ABI,
	type LinkAnswer,
	type LinkRequest,
} from "./link";
export { start, takeOver, tookOver, type StartOptions } from "./boot";
export { LazyTransport, PortTransport, serveTransport } from "./transport";
export {
	NativeMap,
	NativeSet,
	NativeURL,
	NativeWeakMap,
	NativeWeakSet,
	natives,
} from "./natives";
export { HookClient } from "@/hook/hook-client";
export { createCodec, noCodec, PathCodec } from "@/codec";
export { Plugin, Tap } from "@/Tap";
export {
	RpcHelper,
	RpcLink,
	RemoteTransport,
	remoteTransportMethods,
	serveRemoteTransport,
	type MethodsDefinition,
	type RpcDescription,
	type TransportToController,
	type StorageMutation,
} from "@mercuryworkshop/rpc";
export type {
	ScramjetStorageManager,
	ScramjetStorageArea,
	ScramjetStorageContext,
	ScramjetIndexedDBStorageAdapter,
	ScramjetCacheStorageAdapter,
	ScramjetStorageMutation,
} from "@/shared/storage";
export { ScramjetStorageJar } from "@/shared/storage";
export { createStorageObject } from "@/shared/storage-object";
export {
	IncrementalHtmlRewriter,
	rewriteHtml,
	rewriteSrcset,
	unrewriteHtml,
	isEventHandlerAttribute,
	type HtmlContext,
} from "@rewriters/html";
// Realm mode, for an embedder whose pages run their scripts in a realm of its own: the stubs
// that stand in for page script, the policy a document that holds them is sent with, and the
// javascript: URL handling that keeps their code out of the document's realm
export {
	createRealmHandlerStub,
	createRealmStub,
	decodeJavascriptUrlBody,
	embedText,
	isRealmStub,
	parseRealmStub,
	readRealmStubSource,
	realmDocumentEventType,
	REALM_INERT_JAVASCRIPT_URL,
	REALM_NO_LISTENER_MESSAGE,
	unstubText,
	type ParsedRealmStub,
	type RealmScriptDetail,
	type RealmScriptKind,
} from "@rewriters/realm";
export {
	createDocumentPolicy,
	documentPolicyHeader,
	handlerHash,
	sha256,
	trustedTypesPolicyName,
	type DocumentPolicy,
} from "@rewriters/policy";
export { isJavascriptUrl, parserReadableUrl } from "@rewriters/javascript-url";
export { rewriteCss } from "@rewriters/css";
export {
	getScriptBlockTypeString,
	isJavascriptMimeType,
	isModuleScriptType,
	isScriptType,
} from "@/shared/mime";
export { rewriteUrl, unrewriteUrl, type URLMeta } from "@rewriters/url";
export {
	registerProviders,
	providers,
	type ScramjetProviders,
} from "@/shared/providers";
export { defaultConfig } from "@/config";
export type {
	ScramjetContext,
	ScramjetInterface,
	HtmlRewriterHooks,
} from "@/shared";
export type { ScramjetConfig, ScramjetFlags } from "@/types";
export { CookieJar, type Cookie } from "@/shared/cookie";
export type * from "./types";
export type * from "@/plugins/types";

export {
	identityName,
	internalAttribute,
	internalAttributePrefix,
	logicalAttribute,
	runtimeIdentity,
} from "@/runtime-identity";
export type { CodeRewriterHooks } from "@/shared";
