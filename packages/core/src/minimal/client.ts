import { BareCompatibleClient } from "@mercuryworkshop/proxy-transports";
import { getOwnPropertyDescriptorHandler } from "@client/helpers";
import type {
	ProxyCtx,
	ProxyHooks,
	ProxyTransport,
	RawHeaders,
	TransportSocket,
	TrapCtx,
	TrapHooks,
} from "./types";
import {
	Array_isArray,
	Object_defineProperty,
	Object_getOwnPropertyDescriptor,
	Reflect_apply,
	Reflect_construct,
	Reflect_get,
	Reflect_has,
	URL_createObjectURL,
} from "@/shared/snapshot";
import { LazyTransport } from "./transport";
import { NativeURL, NativeMap } from "./natives";

/** Where a request goes: the browser's own network, the Wisp transport, or nowhere */
export type ScramjetMinimalRoute = "native" | "wisp" | "blocked";

/** Plain settings, so a page can hand the same ones to its workers */
export type ScramjetMinimalConfig = {
	/** Origins whose requests keep the browser's network, such as the page's own files */
	direct: string[];
	/** Hostnames, with their subdomains, whose requests fail the way blocked ones do */
	blocked?: string[];
	/** Wisp endpoint the transport connects to */
	wisp?: string;
	/** Module URL of the transport; its default export is constructed with `{ wisp }` */
	transport?: string;
	/** URL of this bundle, which workers import to intercept their own requests */
	script?: string;
	/** Base for relative URLs; workers pass their script URL because their own is a blob */
	base?: string;
	/** Origin sent with sockets, which servers check; defaults to the base URL's origin */
	origin?: string;
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
 * The part of the Scramjet client that intercepts requests. It keeps the client's `Proxy` and
 * `Trap` helpers and module shape, but performs requests itself over the transport instead of
 * rewriting URLs for a service worker, so it works where no service worker can run, such as a
 * sandboxed frame with an opaque origin.
 */
export class ScramjetMinimalClient {
	natives: Record<string, any> = {};
	descriptors: Record<string, PropertyDescriptor | undefined> = {};
	transport: LazyTransport;
	bare: {
		createWebSocket(
			remote: string | URL,
			protocols?: string | string[],
			requestHeaders?: RawHeaders
		): TransportSocket;
	};
	/** Original URLs of resources served from blob URLs, so scripts still see where they came from */
	origins = new NativeMap<string, string>();
	#blobs = new NativeMap<string, Promise<string>>();
	/** The browser's fetch, captured before any interceptor replaced it */
	readonly nativeFetch: typeof fetch;

	#direct: Set<string>;

	constructor(
		public global: typeof globalThis,
		public config: ScramjetMinimalConfig,
		public options: ScramjetMinimalOptions
	) {
		this.transport = new LazyTransport(options.transport);
		this.bare = new BareCompatibleClient(
			this.transport as never
		) as unknown as ScramjetMinimalClient["bare"];
		this.nativeFetch = global.fetch.bind(global);
		this.#direct = new Set(
			config.direct.map((origin) => new NativeURL(origin).origin)
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
		return this.config.origin ?? new NativeURL(this.base).origin;
	}

	/** Resolves a URL the way the page would, or null when it is not a URL at all */
	resolve(input: string | URL, base = this.base): URL | null {
		try {
			return new NativeURL(String(input), base);
		} catch {
			return null;
		}
	}

	route(url: URL): ScramjetMinimalRoute {
		if (!WISP_PROTOCOLS.includes(url.protocol)) return "native";
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

	report(error: unknown, url: string) {
		if ((error as Error)?.name === "AbortError") return;
		this.options.onError?.(error, url);
	}

	/** Performs a request over the transport, following redirects the way fetch does */
	async fetch(request: Request): Promise<Response> {
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
			const route = this.route(url);
			if (route === "blocked") throw new TypeError("Failed to fetch");
			if (route === "native")
				return this.nativeFetch(url.href, {
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
			const response = await this.transport.request(
				url,
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
				url = new NativeURL(location, url);
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
		kind: "script" | "style" | "other" = "other"
	): Promise<string> {
		const key = `${kind} ${url.href}`;
		let pending = this.#blobs.get(key);
		if (!pending) {
			pending = (async () => {
				const response = await this.fetch(new Request(url.href));
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

	/**
	 * Points a stylesheet's third-party references at blob URLs. A blob stylesheet has no base of
	 * its own, so `absolute` also spells out its other references in full.
	 */
	async css(text: string, base: URL, absolute = true): Promise<string> {
		const pattern =
			/url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g;
		const swaps = new NativeMap<string, Promise<string>>();
		for (const match of text.matchAll(pattern)) {
			const raw = (match[2] ?? match[4]).trim();
			if (
				swaps.has(raw) ||
				/^(data|blob|about):/i.test(raw) ||
				raw.startsWith("#")
			)
				continue;
			const url = this.resolve(raw, base.href);
			if (!url) continue;
			const imported = match[4] !== undefined;
			if (this.route(url) === "wisp")
				swaps.set(
					raw,
					this.blob(url, imported ? "style" : "other").catch((error) => {
						this.report(error, url.href);
						return url.href;
					})
				);
			else if (absolute) swaps.set(raw, Promise.resolve(url.href));
		}
		const resolved = new NativeMap<string, string>();
		for (const [raw, pending] of swaps) resolved.set(raw, await pending);
		return text.replace(pattern, (whole, quote, url, importQuote, imported) => {
			const raw = (url ?? imported).trim();
			const next = resolved.get(raw);
			if (!next) return whole;
			return imported !== undefined
				? `@import ${importQuote}${next}${importQuote}`
				: `url(${quote}${next}${quote})`;
		});
	}

	// The helpers below mirror ScramjetClient's, so interceptor modules are written the same way

	Proxy(name: string | readonly string[], handler: ProxyHooks): void {
		if (Array_isArray(name)) {
			for (const each of name) this.Proxy(each, handler);
			return;
		}
		const split = (name as string).split(".");
		const prop = split.pop();
		const target = split.reduce(
			(object, key) => object?.[key],
			this.global as any
		);
		if (!target || !prop) return;
		if (!((name as string) in this.natives))
			this.natives[name as string] = Reflect_get(target, prop);
		this.RawProxy(target, prop, handler);
	}

	RawProxy(target: any, prop: string, handler: ProxyHooks) {
		if (!target || !prop || !Reflect_has(target, prop)) return;
		const value = Reflect_get(target, prop);
		const descriptor = Object_getOwnPropertyDescriptor(target, prop);
		const traps: ProxyHandler<any> = {
			getOwnPropertyDescriptor: getOwnPropertyDescriptorHandler,
		};
		if (handler.construct)
			traps.construct = (fn: any, args: any[], newTarget: any) => {
				let result: any;
				let early = false;
				const ctx: ProxyCtx = {
					fn,
					this: null,
					args,
					newTarget,
					return: (value: any) => {
						early = true;
						result = value;
					},
					call: () => {
						early = true;
						result = Reflect_construct(ctx.fn, ctx.args, ctx.newTarget);
						return result;
					},
				};
				handler.construct!(ctx);
				return early
					? result
					: Reflect_construct(ctx.fn, ctx.args, ctx.newTarget);
			};
		if (handler.apply)
			traps.apply = (fn: any, that: any, args: any[]) => {
				let result: any;
				let early = false;
				const ctx: ProxyCtx = {
					fn,
					this: that,
					args,
					newTarget: null,
					return: (value: any) => {
						early = true;
						result = value;
					},
					call: () => {
						early = true;
						result = Reflect_apply(ctx.fn, ctx.this, ctx.args);
						return result;
					},
				};
				handler.apply!(ctx);
				return early ? result : Reflect_apply(ctx.fn, ctx.this, ctx.args);
			};
		delete target[prop];
		Object_defineProperty(target, prop, {
			value: new Proxy(value, traps),
			writable: descriptor?.writable ?? true,
			enumerable: descriptor?.enumerable ?? false,
			configurable: descriptor?.configurable ?? true,
		});
	}

	Trap(name: string | readonly string[], descriptor: TrapHooks): void {
		if (Array_isArray(name)) {
			for (const each of name) this.Trap(each, descriptor);
			return;
		}
		const split = (name as string).split(".");
		const prop = split.pop();
		const target = split.reduce(
			(object, key) => object?.[key],
			this.global as any
		);
		if (!target || !prop) return;
		this.descriptors[name as string] = Object_getOwnPropertyDescriptor(
			target,
			prop
		);
		this.RawTrap(target, prop, descriptor);
	}

	RawTrap(target: any, prop: string, descriptor: TrapHooks) {
		if (!target || !prop || !Reflect_has(target, prop)) return;
		const old = Object_getOwnPropertyDescriptor(target, prop);
		const context = (that: any): TrapCtx => ({
			this: that,
			get: () => old?.get?.call(that),
			set: (value: any) => old?.set?.call(that, value),
		});
		delete target[prop];
		const next: PropertyDescriptor = {
			enumerable: descriptor.enumerable ?? old?.enumerable ?? false,
			configurable: descriptor.configurable ?? old?.configurable ?? true,
		};
		if (descriptor.get)
			next.get = function () {
				return descriptor.get!(context(this));
			};
		else if (old?.get) next.get = old.get;
		if (descriptor.set)
			next.set = function (value: any) {
				descriptor.set!(context(this), value);
			};
		else if (old?.set) next.set = old.set;
		Object_defineProperty(target, prop, next);
	}

	/** Calls the native function a module replaced */
	native<T = any>(name: string, that: unknown, ...args: unknown[]): T {
		return Reflect_apply(this.natives[name], that, args);
	}
}
