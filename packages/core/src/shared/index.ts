import { ScramjetConfig, ScramjetFlags } from "@/types";
import type { Document, Element } from "./htmlparser";
import { URLMeta } from "@rewriters/url";
import type { CookieStore } from "./cookie";
import type { UrlCodec } from "@/plugins/types";
import { TapInstance } from "@/Tap";
import { HtmlContext } from "@/shared/rewriters/html";

export * from "./cookie";
export * from "./headers";
export * from "./htmlRules";
export * from "./mime";
export * from "./providers";
export * from "./rewriters";

/** the flags whose value is a boolean, which is all but `incumbency` */
export type BooleanFlag = {
	[K in keyof ScramjetFlags]: ScramjetFlags[K] extends boolean ? K : never;
}[keyof ScramjetFlags];

/**
 * A flag's value. Flags are fixed for a context: an embedder that wants
 * different flags for different sites hands each its own config.
 */
export function flagValue<K extends keyof ScramjetFlags>(
	flag: K,
	context: ScramjetContext
): ScramjetFlags[K] {
	return context.config.flags[flag];
}

/**
 * `flagValue` for the boolean flags. Kept separate so that a flag which is not
 * a boolean - `incumbency` - cannot be read as if it were one, where every
 * mode including `"none"` would come back truthy.
 */
export function flagEnabled(
	flag: BooleanFlag,
	context: ScramjetContext
): boolean {
	return flagValue(flag, context);
}
export type ScramjetInterface = {
	codecEncode: (input: string) => string;
	codecDecode: (input: string) => string;

	/**
	 * `transform` is handed the source of each script the embedder injects
	 * inline, for the `injectedJavascript` code hook
	 */
	getInjectScripts(
		meta: URLMeta,
		root: Document,
		htmlcontext: HtmlContext,
		script: (src: string) => Element,
		transform?: (source: string) => string
	): Element[];
	getWorkerInjectScripts?(
		meta: URLMeta,
		isModule: boolean,
		script: (src: string) => string,
		transform?: (source: string) => string
	): string;
};

export type ScramjetContext = {
	config: ScramjetConfig;
	prefix: URL;
	interface: ScramjetInterface;
	/**
	 * Where original URLs load from, for a runtime without the proxy's wire
	 * format. With a codec, rewriteUrl maps each URL the codec owns and leaves
	 * the rest as written, unrewriteUrl maps back, and the prefix is unused
	 */
	codec?: UrlCodec;
	cookieJar: CookieStore;
	hooks?: {
		rewriter: {
			html: TapInstance<HtmlRewriterHooks>;
			code?: TapInstance<CodeRewriterHooks>;
		};
	};
};

export type HtmlRewriterHooks = {
	/** an element, once scramjet has rewritten its attributes and before its children */
	element: {
		context: { element: Element; meta: URLMeta };
		props: {};
	};
	/** a text node's data, which a plugin may replace */
	text: {
		context: { parent: Element | null; meta: URLMeta };
		props: { text: string };
	};
	pre: {
		context: {
			root: Document;
			/** the same root, under the name the fork's plugins read it by */
			handler: { root: Document };
			meta: URLMeta;
			origHtml: string;
			htmlcontext: HtmlContext;
		};
	};
	post: {
		context: {
			root: Document;
			handler: { root: Document };
			meta: URLMeta;
			origHtml: string;
			htmlcontext: HtmlContext;
		};
		props: {
			setRawHtml?: string;
		};
	};
};

/**
 * Transforms that run inside scramjet's rewriters, synchronously, on what
 * they produce and before anything uses it.
 */
export type CodeRewriterHooks = {
	/** code scramjet injects itself, which is not guest javascript and is not rewritten as such */
	injectedJavascript: {
		context: {
			kind: "document" | "workerPrelude" | "worker" | "wasm";
			meta: URLMeta;
			isModule: boolean;
		};
		props: { source: string };
	};
	/** guest javascript, after scramjet's rewrite */
	javascript: {
		context: {
			url: string | null;
			meta: URLMeta;
			isModule: boolean;
			functionBody?: boolean;
		};
		props: { source: string };
	};
	css: {
		context: {
			meta: URLMeta;
			direction: "rewrite" | "unrewrite";
			kind: "stylesheet" | "declarations" | "value";
		};
		props: { source: string };
	};
};
