/**
 * Extension points of Scramjet's minimal client, for embedders that run it without a service
 * worker. Everything an embedder adds (storage, workers, realm adoption, input, reporting) is a
 * plugin against these, and talks to its host over @mercuryworkshop/rpc channels on one link.
 * Exported as @mercuryworkshop/scramjet/plugins.
 */
import type { Plugin } from "@/Tap";

/** What a codec knows about the request a URL is encoded for */
export interface CodecContext {
	base?: URL;
	destination?: RequestDestination;
	isModule?: boolean;
	navigate?: boolean;
}

/** Maps original URLs to URLs the browser can load, and back */
export interface UrlCodec {
	/** Part of rewrite-cache keys, since rewritten stylesheets embed encoded URLs */
	readonly id: string;
	/** Original to loadable, or null when this codec does not own the URL */
	encode(url: URL, ctx?: CodecContext): string | null;
	/** Loadable to original, or null when the URL is not one of ours */
	decode(url: string | URL): string | null;
	/** Whether encode would map this URL; synchronous, decided from boot data */
	owns(url: URL): boolean;
}

/** A codec described as plain data, so a page can hand it to its workers and nested frames */
export type CodecConfig =
	| {
			type: "path";
			/** Absolute URL every encoded URL starts with, such as https://example.com/play/<rev>/ */
			prefix: string;
			/** Original hosts, with ports, whose files live under the prefix */
			hosts: string[];
			/** Absolute URL prefixes served directly beside the encoded content */
			passthrough?: string[];
			defaultScheme: "https" | "http";
	  }
	| { type: "none" };

/** Where a request goes: the browser's own network, the Wisp transport, a plugin, or nowhere */
export type ScramjetMinimalRoute = "native" | "wisp" | "blocked" | "plugin";

/** Tap hooks on the minimal client. Route callbacks run synchronously and change props */
export type MinimalHooks = {
	/** Executable resources, awaited before creating their browser-loadable URL */
	resource: {
		context: { url: URL; kind: "script" | "style" | "other"; isModule: boolean };
		props: { response: Response };
	};
	/** Synchronous code entered through eval, constructors or parsed markup */
	javascript: {
		context: { url: string | null; isModule: boolean };
		props: { source: string };
	};
	route: {
		context: { url: URL; method: string };
		/** `url` is what the browser loads when the route is native, or what goes over Wisp */
		props: { route: ScramjetMinimalRoute; url: string };
	};
	/**
	 * The document's HTML, before start() writes it back once the host answered; awaited, so a
	 * plugin can fetch what the markup needs (blocking scripts from other sites) and change it
	 */
	document: {
		context: { url: string };
		props: { html: string };
	};
	/** The page wrote its document again (document.open), which drops window listeners */
	written: {
		context: { window: Window };
		props: {};
	};
};

/** Tap hooks around requests the client performs itself */
export type MinimalFetchHooks = {
	/** Set props.response to answer the request without the transport */
	request: {
		context: { route: ScramjetMinimalRoute };
		props: { request: Request; response?: Response | Promise<Response> };
	};
	/** Replace props.response, such as with a mirror's copy when a CDN refused the file */
	response: {
		context: { request: Request };
		props: { response: Response };
	};
};

/** What core hands a plugin while it installs */
export type MinimalPluginContext<Client> = {
	/** Taps the client's hooks under this plugin's name */
	tap: Plugin;
	/** Installs the same plugins in a same-origin child window the page made */
	subcontext: (child: Window & typeof globalThis) => Client | null;
};

/**
 * Code that installs into the minimal client, in pages, workers and nested windows. Plugins
 * register by name, so a page and its workers that load the same bundle install the same set.
 */
export interface ScramjetMinimalPlugin<Client = any> {
	name: string;
	/** A preparation failure stops the document or worker before author scripts execute */
	required?: boolean;
	/** Lower numbers install first */
	order?: number;
	/** Where the plugin installs; defaults to both */
	scope?: ("window" | "worker")[];
	enabled?(client: Client): boolean;
	install(
		client: Client,
		self: typeof globalThis,
		context: MinimalPluginContext<Client>
	): void;
	/**
	 * Runs once the host answered, before the document's own scripts: load state, probe the
	 * browser. `payload` is what the host handed this plugin by name in its welcome.
	 */
	prepare?(
		client: Client,
		context: MinimalPrepareContext
	): void | Promise<void>;
}

export type MinimalPrepareContext = {
	link: import("@mercuryworkshop/rpc").RpcLink | null;
	payload: unknown;
};
