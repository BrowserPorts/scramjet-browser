import { BareCompatibleClient } from "@mercuryworkshop/proxy-transports";
import type { RemoteTransport, RpcLink } from "@mercuryworkshop/rpc";
import { HookClient } from "@/hook/hook-client";
import { createCodec } from "@/codec";
import { Tap } from "@/Tap";
import type { ScramjetStorageManager } from "@/shared/storage";
import type {
	CodecConfig,
	MinimalFetchHooks,
	MinimalHooks,
	ScramjetMinimalRoute,
	UrlCodec,
} from "@/plugins/types";
import type { ProxyTransport, RawHeaders, TransportSocket } from "./types";
import { Object_defineProperty, URL_createObjectURL } from "@/shared/snapshot";
import type { IdentityName } from "@/runtime-identity-names";
import { LazyTransport } from "./transport";
import { NativeURL, NativeMap } from "./natives";
import { providers } from "@/shared/providers";

export type { ScramjetMinimalRoute };

/** Plain settings, so a page can hand the same ones to its workers and nested windows */
export type ScramjetMinimalConfig = {
	/** Host-selected message key used before required plugins receive their settings */
	linkKey?: string;
	/**
	 * The physical names a keyed host gave Scramjet's own names, of which the worker protocol uses its
	 * message types. Leave it out to keep the logical names
	 */
	identityNames?: Readonly<Record<IdentityName, string>>;
	/** Fetch native element resources through the plugin pipeline before the browser loads them */
	resourceTransforms?: boolean;
	/** Origins whose requests keep the browser's network; defaults to the page's own */
	direct?: string[];
	/** Hostnames, with their subdomains, whose requests fail the way blocked ones do */
	blocked?: string[];
	/** Where original URLs live, so the browser loads them natively from there */
	codec?: CodecConfig;
	/** Wisp endpoint the transport connects to, when the page holds its own transport */
	wisp?: string;
	/** Module URL of the transport; its default export is constructed with `{ wisp }` */
	transport?: string;
	/** URL of this bundle, which workers import to install the same plugins */
	script?: string;
	/** Base for relative URLs; workers pass their script URL because their own is a blob */
	base?: string;
	/** Origin sent with sockets, which servers check; defaults to the original page's origin */
	origin?: string;
	/** Settings for plugins by plugin name, handed on with the rest */
	plugins?: Record<string, unknown>;
};

export type ScramjetMinimalOptions = {
	/** Starts the transport the first time a request has to leave the direct origins */
	transport: () => Promise<ProxyTransport>;
	/** Told about requests that failed after leaving through the transport */
	onError?: (error: unknown, url: string) => void;
};

const REDIRECTS = [301, 302, 303, 307, 308];
const EMPTY_BODY = [101, 204, 205, 304];
const MAX_REDIRECTS = 20;
const WISP_PROTOCOLS = ["http:", "https:", "ws:", "wss:"];

function header(headers: RawHeaders, name: string): string | null {
	for (const [key, value] of headers)
		if (key.toLowerCase() === name) return value;
	return null;
}

/**
 * Scramjet's client without the proxy. It intercepts requests where no service worker can, such
 * as a sandboxed frame with an opaque origin: a URL the codec owns loads natively from where the
 * codec put it, the page's own origin loads natively, and everything else goes over the Wisp
 * transport, unless a plugin tapped `hooks.route` or `hooks.fetch` to decide otherwise. What it
 * intercepts is up to its plugins.
 */
export class ScramjetMinimalClient extends HookClient {
	transport: LazyTransport;
	bare: {
		createWebSocket(
			remote: string | URL,
			protocols?: string | string[],
			requestHeaders?: RawHeaders
		): TransportSocket;
	};
	codec: UrlCodec;
	#minimal = Tap.create<MinimalHooks>();
	hooks = {
		resource: this.#minimal.resource,
		javascript: this.#minimal.javascript,
		route: this.#minimal.route,
		document: this.#minimal.document,
		written: this.#minimal.written,
		fetch: Tap.create<MinimalFetchHooks>(),
	};
	/** RPC channels to the page that hosts this frame or worker, when it has one */
	link: RpcLink | null = null;
	/**
	 * The transport relayed over the link, whose sendStorageMutation and sendSetCookie reach the
	 * host the same way the controller's do
	 */
	remote: RemoteTransport | null = null;
	/** Storage a plugin provides, in Scramjet's storage manager shape */
	storage: ScramjetStorageManager | null = null;
	/** Original URLs of resources served from blob URLs, so scripts still see where they came from */
	origins = new NativeMap<string, string>();
	#blobs = new NativeMap<string, Promise<string>>();
	/** The browser's fetch, captured before any interceptor replaced it */
	readonly nativeFetch: typeof fetch;

	#direct: Set<string>;

	constructor(
		global: typeof globalThis,
		public config: ScramjetMinimalConfig,
		public options: ScramjetMinimalOptions
	) {
		super(global);
		this.transport = new LazyTransport(options.transport);
		this.bare = new BareCompatibleClient(
			this.transport as never
		) as unknown as ScramjetMinimalClient["bare"];
		this.nativeFetch = global.fetch.bind(global);
		this.codec = createCodec(config.codec);
		const direct = config.direct ?? [new NativeURL(this.base).origin];
		this.#direct = new Set(
			direct
				.filter((origin) => origin && origin !== "null")
				.map((origin) => new NativeURL(origin).origin)
		);
	}

	get base(): string {
		if (this.config.base) return this.config.base;
		const document = (
			this.global as typeof globalThis & { document?: Document }
		).document;
		return document?.baseURI ?? this.global.location.href;
	}

	get origin(): string {
		if (this.config.origin) return this.config.origin;
		const base = new NativeURL(this.base);
		const original = this.codec.decode(base);
		return original ? new NativeURL(original).origin : base.origin;
	}

	/**
	 * Resolves a URL the way the page would, mapped into the codec's space when the codec owns it,
	 * or null when it is not a URL at all.
	 */
	resolve(input: string | URL, base = this.base): URL | null {
		let url: URL;
		try {
			url = new NativeURL(String(input), base);
		} catch {
			return null;
		}
		const encoded = this.codec.encode(url);
		return encoded ? new NativeURL(encoded) : url;
	}

	/** Where a URL goes, and the URL the browser loads when it loads it itself */
	decide(url: URL, method = "GET"): { route: ScramjetMinimalRoute; url: string } {
		const props = { route: this.#route(url), url: url.href };
		if (props.route === "native") props.url = this.codec.encode(url) ?? url.href;
		// Route callbacks are synchronous, so their changes to props are in place once dispatch returns
		Tap.dispatchSync(this.hooks.route, { url, method }, props);
		return props;
	}

	#route(url: URL): ScramjetMinimalRoute {
		if (!WISP_PROTOCOLS.includes(url.protocol)) return "native";
		if (this.codec.owns(url)) return "native";
		// A socket to a direct origin's host is direct too
		const scheme =
			url.protocol === "ws:"
				? "http:"
				: url.protocol === "wss:"
					? "https:"
					: url.protocol;
		if (this.#direct.has(`${scheme}//${url.host}`)) return "native";
		const host = url.hostname.toLowerCase();
		if (
			this.config.blocked?.some(
				(blocked) => host === blocked || host.endsWith(`.${blocked}`)
			)
		)
			return "blocked";
		return "wisp";
	}

	route(url: URL): ScramjetMinimalRoute {
		return this.decide(url).route;
	}

	report(error: unknown, url: string) {
		if ((error as Error)?.name === "AbortError") return;
		this.options.onError?.(error, url);
	}

	/** Performs a request the browser cannot, through the plugins' fetch hooks and the transport */
	async fetch(input: Request): Promise<Response> {
		let request = input;
		// libcurl never answers a 304 that carries the full entity's Content-Length, so a revalidation
		// (an engine checking its cached build) goes out as a plain request and gets the full response
		if (
			request.headers.has("if-none-match") ||
			request.headers.has("if-modified-since")
		) {
			const headers = new Headers(request.headers);
			headers.delete("if-none-match");
			headers.delete("if-modified-since");
			request = new Request(request, { headers });
		}
		const asked: MinimalFetchHooks["request"]["props"] = { request };
		await Tap.dispatchSeries(
			this.hooks.fetch.request,
			{ route: this.route(new NativeURL(request.url)) },
			asked
		);
		const response = await (asked.response ?? this.#follow(asked.request));
		const answered = { response };
		await Tap.dispatchSeries(this.hooks.fetch.response, { request: asked.request }, answered);
		return answered.response;
	}

	/** Follows redirects the way fetch does, deciding each hop again */
	async #follow(request: Request): Promise<Response> {
		const signal = request.signal;
		signal.throwIfAborted();
		let url = new NativeURL(request.url);
		let method = request.method;
		let body: ArrayBuffer | null =
			method === "GET" || method === "HEAD"
				? null
				: await request.arrayBuffer();
		let headers: RawHeaders = [];
		request.headers.forEach((value, name) => headers.push([name, value]));
		const present = new Set(headers.map(([name]) => name.toLowerCase()));
		const navigator = this.global.navigator;
		if (!present.has("user-agent"))
			headers.push(["User-Agent", navigator.userAgent]);
		if (!present.has("accept")) headers.push(["Accept", "*/*"]);
		if (!present.has("accept-language") && navigator.languages?.length)
			headers.push(["Accept-Language", navigator.languages.join(",")]);

		for (let hop = 0; ; hop++) {
			const decided = this.decide(url, method);
			if (decided.route === "blocked" || decided.route === "plugin")
				throw new TypeError("Failed to fetch");
			if (decided.route === "native")
				return this.nativeFetch(decided.url, {
					method,
					headers,
					body,
					signal,
					redirect: request.redirect,
				});
			// libcurl reads a HEAD response's Content-Length as a body still to come and fails it as
			// partial, so a HEAD goes out as a GET for the first byte; its Content-Range carries the
			// size, and the byte is read out, since dropping a stream mid-transfer leaves Wisp
			// delivering data for a stream that no longer exists
			const head = method === "HEAD";
			const ranged = head && !headers.some(([name]) => /^range$/i.test(name));
			// A route hook may send the request to another URL, such as a file's original location
			const target = decided.url === url.href ? url : new NativeURL(decided.url);
			const response = await this.transport.request(
				target,
				head ? "GET" : method,
				body,
				ranged ? [...headers, ["Range", "bytes=0-0"]] : headers,
				signal
			);
			if (head) {
				await new Response(response.body as BodyInit)
					.arrayBuffer()
					.catch(() => undefined);
				const total = /\/(\d+)\s*$/.exec(
					header(response.headers, "content-range") ?? ""
				)?.[1];
				if (ranged && (response.status === 206 || response.status === 416)) {
					response.status = 200;
					response.statusText = "OK";
					response.headers = response.headers.filter(
						([name]) => !/^content-(range|length)$/i.test(name)
					);
					response.headers.push(["Content-Length", total ?? "0"]);
				}
			}
			const location = header(response.headers, "location");
			if (
				REDIRECTS.includes(response.status) &&
				location !== null &&
				request.redirect !== "manual"
			) {
				if (request.redirect === "error" || hop >= MAX_REDIRECTS)
					throw new TypeError("Failed to fetch");
				if (!head)
					await new Response(response.body as BodyInit)
						.arrayBuffer()
						.catch(() => undefined);
				if (
					(response.status === 303 && method !== "HEAD") ||
					((response.status === 301 || response.status === 302) &&
						method === "POST")
				) {
					method = "GET";
					body = null;
					headers = headers.filter(([name]) => !/^content-/i.test(name));
				}
				url = new NativeURL(location, target);
				continue;
			}
			if (response.status < 200 || response.status > 599)
				throw new TypeError("Failed to fetch");
			const result = new Response(
				EMPTY_BODY.includes(response.status) || method === "HEAD"
					? null
					: (response.body as BodyInit),
				{
					status: response.status,
					statusText: response.statusText,
					headers: this.#headers(response.headers),
				}
			);
			Object_defineProperty(result, "url", { value: url.href });
			Object_defineProperty(result, "redirected", { value: hop > 0 });
			return result;
		}
	}

	#headers(raw: RawHeaders): Headers {
		const headers = new Headers();
		for (const [name, value] of raw) {
			try {
				headers.append(name, value);
			} catch {}
		}
		return headers;
	}

	/**
	 * Fetches a resource over the transport into a blob URL that a page element can load, since an
	 * element's own request would leave through the browser's network.
	 */
	blob(
		url: URL,
		kind: "script" | "style" | "other" = "other",
		isModule = false
	): Promise<string> {
		const key = `${kind} ${isModule} ${url.href}`;
		let pending = this.#blobs.get(key);
		if (!pending) {
			pending = (async () => {
				const props = { response: await this.fetch(new Request(url.href)) };
				await Tap.dispatchSeries(this.hooks.resource, { url, kind, isModule }, props);
				const response = props.response;
				if (!response.ok)
					throw new TypeError(`${url.href} answered ${response.status}`);
				let data: Blob;
				if (kind === "style")
					data = new Blob([await this.css(await response.text(), url)], {
						type: "text/css",
					});
				else if (kind === "script")
					data = new Blob([await response.arrayBuffer()], {
						type: "text/javascript",
					});
				else {
					const type = response.headers.get("content-type") ?? "";
					data = new Blob([await response.arrayBuffer()], { type });
				}
				const blob = URL_createObjectURL(data);
				this.origins.set(blob, url.href);
				return blob;
			})();
			pending.catch(() => this.#blobs.delete(key));
			this.#blobs.set(key, pending);
		}
		return pending;
	}

	/** Transforms code synchronously before a native execution entry point sees it */
	javascript(source: string, url: string | null = null, isModule = false): string {
		const props = { source };
		Tap.dispatchSync(this.hooks.javascript, { url, isModule }, props);
		return props.source;
	}

	/**
	 * Points a stylesheet's references where they load: owned URLs into the codec's space, other
	 * sites at blob URLs. A blob stylesheet has no base of its own, so `absolute` also spells out
	 * its other references in full.
	 */
	async css(text: string, base: URL, absolute = true): Promise<string> {
		const swaps = new NativeMap<string, Promise<string>>();
		providers().rewriteCssUrls(text, (raw, kind) => {
			if (
				swaps.has(raw) ||
				raw.startsWith("#")
			)
				return raw;
			const url = this.resolve(raw, base.href);
			if (!url || ["data:", "blob:", "about:"].includes(url.protocol)) return raw;
			const route = this.route(url);
			if (route === "wisp" || route === "plugin" || this.config.resourceTransforms)
				swaps.set(
					raw,
					this.blob(url, kind === "import" ? "style" : "other")
				);
			else if (absolute || url.href !== new NativeURL(raw, base).href)
				swaps.set(raw, Promise.resolve(url.href));
			return raw;
		});
		const resolved = new NativeMap<string, string>();
		for (const [raw, pending] of swaps) resolved.set(raw, await pending);
		return providers().rewriteCssUrls(text, (raw) => resolved.get(raw) ?? raw);
	}
}
