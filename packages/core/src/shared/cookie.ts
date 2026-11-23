// thnank you node unblocker guy
import {
	JSON_parse,
	JSON_stringify,
	Number_isFinite,
	Object_keys,
	String_indexOf,
	String_split,
	String_substring,
	_Date,
	_Map,
} from "@/shared/snapshot";
import parse from "./set-cookie-parser";

export type Cookie = {
	name: string;
	value: string;
	path?: string;
	expires?: number;
	maxAge?: number;
	domain?: string;
	hostOnly?: boolean;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: string; // "strict"|"lax"|"none" or titlecase variants from parsers
	partitioned?: boolean;
};

export type SameSiteContext = "strict" | "lax" | "cross-site";

/** What a store is told about a request it is asked for a `Cookie` header for */
export type CookieRequestContext = {
	url: URL;
	fromJs: boolean;
	sameSiteContext: SameSiteContext;
	method?: string;
	destination?: string;
	mode?: RequestMode;
	credentials?: RequestCredentials;
	cache?: RequestCache;
	rawReferrer?: string | null;
	referrer?: string;
	rawClientUrl?: URL;
	clientId?: string;
	crossSiteRedirect?: boolean;
};

/** What a store is told about a response whose `Set-Cookie` headers it is handed */
export type CookieResponseContext = {
	url: URL;
	cookies: string[];
	status: number;
	method?: string;
	destination?: string;
	mode?: RequestMode;
	credentials?: RequestCredentials;
	cache?: RequestCache;
	rawReferrer?: string | null;
	referrer?: string;
	rawClientUrl?: URL;
	clientId?: string;
	crossSiteRedirect?: boolean;
};

export type DocumentCookieContext = { url: URL };
export type DocumentSetCookieContext = { url: URL; cookie: string };

/**
 * The cookie storage scramjet depends on. `CookieJar` is the built-in one; an
 * embedder hands in its own, through the controller's `cookieJar` or
 * `registerProviders({ createCookieStore })`, for partitioned, persistent or
 * otherwise differently-scoped storage.
 *
 * `getCookies` and `dump` are synchronous because `document.cookie` is a
 * synchronous accessor. A store whose authority lives elsewhere (a worker, a
 * database) keeps a local projection to read from, and may return a promise
 * from the methods that change it.
 */
export interface CookieStore {
	/**
	 * Whether scramjet persists this store, through `dump` and `load`. False
	 * for a store that keeps its own backing: the controller then never
	 * snapshots it into its own database.
	 */
	readonly ownsPersistence: boolean;
	getCookies(
		url: URL,
		fromJs: boolean,
		sameSiteContext?: SameSiteContext
	): string;
	/**
	 * The matching cookies as records, for the Cookie Store API. A store
	 * without it is read through `getCookies`, which carries no attributes.
	 */
	getCookieList?(
		url: URL,
		fromJs: boolean,
		sameSiteContext?: SameSiteContext
	): Cookie[];
	setCookies(
		cookieString: string,
		url: URL,
		fromJs?: boolean
	): unknown | Promise<unknown>;
	load(cookies: string | Record<string, Cookie>): unknown;
	clear(): unknown | Promise<unknown>;
	dump(): string;
	getRequestCookieHeader?(
		context: CookieRequestContext
	): string | Promise<string>;
	setResponseCookies?(context: CookieResponseContext): unknown | Promise<unknown>;
	getDocumentCookie?(context: DocumentCookieContext): string;
	setDocumentCookie?(
		context: DocumentSetCookieContext
	): unknown | Promise<unknown>;
}

/**
 * The cookies a store holds for `url`, as records. A store without
 * `getCookieList` answers through `getCookies`, so the records carry a name
 * and a value and nothing else.
 */
export function cookieListFor(
	store: CookieStore,
	url: URL,
	fromJs: boolean
): Cookie[] {
	if (store.getCookieList) return store.getCookieList(url, fromJs);
	const list: Cookie[] = [];
	const header = store.getCookies(url, fromJs);
	if (!header) return list;
	const pairs = String_split(header, "; ");
	for (let i = 0; i < pairs.length; i++) {
		const pair = pairs[i];
		const eq = String_indexOf(pair, "=");
		list[list.length] =
			eq === -1
				? { name: "", value: pair }
				: {
						name: String_substring(pair, 0, eq),
						value: String_substring(pair, eq + 1),
					};
	}

	return list;
}

export class CookieJar implements CookieStore {
	/** scramjet's own jar is persisted by whoever holds it, through `dump` and `load` */
	readonly ownsPersistence = true;
	private cookies: Record<string, Cookie> = {};
	// Index by domain (without leading dot)
	private byDomain: _Map<string, Cookie[]> = new _Map();

	private defaultPath(url: URL): string {
		const pathname = url.pathname;
		if (!pathname || !pathname.startsWith("/")) return "/";
		const lastSlash = pathname.lastIndexOf("/");
		if (lastSlash <= 0) return "/";
		return pathname.slice(0, lastSlash);
	}

	private pathMatches(requestPath: string, cookiePath: string): boolean {
		if (requestPath === cookiePath) return true;
		if (!requestPath.startsWith(cookiePath)) return false;
		if (cookiePath.endsWith("/")) return true;
		return requestPath.charAt(cookiePath.length) === "/";
	}

	private indexCookie(c: Cookie) {
		const key = c.domain!.slice(1);
		let bucket = this.byDomain.get(key);
		if (!bucket) {
			bucket = [];
			this.byDomain.set(key, bucket);
		}
		bucket.push(c);
	}

	private unindexCookie(c: Cookie) {
		const key = c.domain!.slice(1);
		const bucket = this.byDomain.get(key);
		if (!bucket) return;
		const i = bucket.indexOf(c);
		if (i >= 0) bucket.splice(i, 1);
		if (bucket.length === 0) this.byDomain.delete(key);
	}

	private removeById(id: string) {
		const prev = this.cookies[id];
		if (prev) this.unindexCookie(prev);
		delete this.cookies[id];
	}

	setCookies(cookieString: string, url: URL) {
		const parsedCookies = parse(cookieString);

		for (const parsedCookie of parsedCookies) {
			const lowerName = parsedCookie.name.toLowerCase();

			if (lowerName.startsWith("__secure-")) {
				if (!parsedCookie.secure) continue;
			} else if (lowerName.startsWith("__host-")) {
				if (!parsedCookie.secure) continue;
				if (parsedCookie.domain) continue;
				if (parsedCookie.path !== "/") continue;
			}

			const hostOnly = !parsedCookie.domain;
			const expiresTime = parsedCookie.expires?.getTime();
			const expires = Number_isFinite(expiresTime) ? expiresTime : undefined;
			const cookie: Cookie = {
				...parsedCookie,
				hostOnly,
				expires,
			};

			if (!cookie.domain) cookie.domain = url.hostname;
			if (!cookie.domain.startsWith(".")) cookie.domain = "." + cookie.domain;
			if (!cookie.path || !cookie.path.startsWith("/")) {
				cookie.path = this.defaultPath(url);
			}
			if (!cookie.sameSite) cookie.sameSite = "lax";

			const id = `${cookie.domain}@${cookie.path}@${cookie.name}`;

			if (typeof cookie.maxAge === "number") {
				if (!Number_isFinite(cookie.maxAge)) {
					delete cookie.maxAge;
				} else if (cookie.maxAge <= 0) {
					this.removeById(id);
					continue;
				} else {
					cookie.expires = _Date.now() + cookie.maxAge * 1000;
				}
			}

			const prev = this.cookies[id];
			if (prev) this.unindexCookie(prev);
			this.cookies[id] = cookie;
			this.indexCookie(cookie);
		}
	}

	// SameSite enforcement context passed to getCookieList / getCookies.
	// "strict"     – same-site request; all cookies allowed
	// "lax"        – cross-site top-level GET/HEAD navigation; Strict blocked, Lax+None allowed
	// "cross-site" – cross-site subresource or non-GET navigation; only None allowed
	//
	// The cookies matching `url`, as the stored records. `getCookies` serializes
	// these for a Cookie header or `document.cookie`; the Cookie Store API needs
	// the attributes too, so the matching lives here and the two share it.
	getCookieList(
		url: URL,
		fromJs: boolean,
		sameSiteContext: "strict" | "lax" | "cross-site" = "strict"
	): Cookie[] {
		const now = _Date.now();
		const hostname = url.hostname;
		const pathname = url.pathname;
		const validCookies: Cookie[] = [];

		// Walk the hostname's domain suffix chain
		let key: string | undefined = hostname;
		while (key !== undefined) {
			const bucket = this.byDomain.get(key);
			if (bucket) {
				for (const cookie of bucket) {
					if (cookie.expires !== undefined && cookie.expires < now) continue;

					if (cookie.hostOnly && key !== hostname) continue;

					// Scramjet proxies all origins as HTTPS (including those served over HTTP),
					// so we don't enforce the Secure attribute based on protocol here.
					// if (cookie.secure && url.protocol !== "https:") continue;
					if (cookie.httpOnly && fromJs) continue;
					if (!this.pathMatches(pathname, cookie.path!)) continue;

					// SameSite enforcement — compare case-insensitively since parsers may
					// return "Strict"/"Lax"/"None" (titlecase) or "strict"/"lax"/"none".
					const cs = (cookie.sameSite ?? "lax").toLowerCase();
					if (sameSiteContext === "cross-site") {
						// Only SameSite=None cookies are sent cross-site
						if (cs !== "none") continue;
					} else if (sameSiteContext === "lax") {
						// Lax top-level navigation: block Strict, allow Lax and None
						if (cs === "strict") continue;
					}
					// "strict" context: all cookies allowed (no filtering)

					validCookies.push(cookie);
				}
			}
			const dot = key.indexOf(".");
			key = dot === -1 ? undefined : key.slice(dot + 1);
		}

		return validCookies;
	}

	getCookies(
		url: URL,
		fromJs: boolean,
		sameSiteContext: "strict" | "lax" | "cross-site" = "strict"
	): string {
		return this.getCookieList(url, fromJs, sameSiteContext)
			.map((cookie) =>
				cookie.name ? `${cookie.name}=${cookie.value}` : cookie.value
			)
			.join("; ");
	}

	load(cookies: string | Record<string, Cookie>) {
		if (typeof cookies === "object") {
			dbg.error("CookieJar.load was handed an object, not a serialized jar");
			return;
		}
		const parsed: Record<string, Cookie> = JSON_parse(cookies);
		this.cookies = {};
		this.byDomain.clear();
		const ids = Object_keys(parsed);
		for (let i = 0; i < ids.length; i++) {
			const id = ids[i];
			const c = parsed[id];
			if (typeof c.expires === "string") {
				const t = _Date.parse(c.expires as unknown as string);
				c.expires = Number_isFinite(t) ? t : undefined;
			}
			this.cookies[id] = c;
			this.indexCookie(c);
		}
	}

	clear() {
		this.cookies = {};
		this.byDomain.clear();
	}

	dump(): string {
		return JSON_stringify(this.cookies);
	}
}
