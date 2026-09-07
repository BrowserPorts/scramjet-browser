// thnank you node unblocker guy
import { JSON_parse, JSON_stringify } from "@/shared/snapshot";
import type { ScramjetDestination } from "@/types";
import { _Date } from "./snapshot";
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
};

export type SameSiteContext = "strict" | "lax" | "cross-site";

export type CookieRequestContext = {
  url: URL;
  fromJs: boolean;
  sameSiteContext: SameSiteContext;
  method?: string;
  destination?: ScramjetDestination;
  mode?: RequestMode;
  credentials?: RequestCredentials;
  cache?: RequestCache;
  rawReferrer?: string | null;
  referrer?: string;
  rawClientUrl?: URL;
  clientId?: string;
  crossSiteRedirect?: boolean;
};

export type CookieResponseContext = {
  url: URL;
  cookies: string[];
  status: number;
  method?: string;
  destination?: ScramjetDestination;
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
 * The cookie storage contract Scramjet depends on. `CookieJar` is the built-in
 * implementation; an embedder can supply its own through
 * `registerProviders({ createCookieStore })` to get partitioned, persistent, or
 * otherwise differently-scoped storage.
 *
 * `getCookies` and `dump` are synchronous because `document.cookie` is a
 * synchronous accessor. A store whose authority lives elsewhere (a worker, a
 * database) must therefore keep a local projection to read from, and may
 * return a promise from the mutating methods.
 */
export interface CookieStore {
  /**
   * When true, Scramjet owns dump/load persistence for this store. When
   * false, the store keeps its own backing (a database, a CookieMonster)
   * and the controller must not snapshot it into local storage.
   */
  readonly ownsPersistence: boolean;
  getCookies(
    url: URL,
    fromJs: boolean,
    sameSiteContext?: SameSiteContext,
  ): string;
  setCookies(
    cookieString: string,
    url: URL,
    fromJs?: boolean,
  ): boolean | Promise<boolean>;
  load(cookies: string | Record<string, Cookie>): boolean;
  clear(): boolean | Promise<boolean | number>;
  dump(): string;
  getRequestCookieHeader?(
    context: CookieRequestContext,
  ): string | Promise<string>;
  setResponseCookies?(
    context: CookieResponseContext,
  ): boolean | Promise<boolean>;
  getDocumentCookie?(context: DocumentCookieContext): string;
  setDocumentCookie?(
    context: DocumentSetCookieContext,
  ): boolean | Promise<boolean>;
}

export class CookieJar implements CookieStore {
  readonly ownsPersistence = true;
  private cookies: Record<string, Cookie> = {};
  // Index by domain (without leading dot)
  private byDomain: Map<string, Cookie[]> = new Map();

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

  setCookies(cookieString: string, url: URL): boolean {
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
      const expires = Number.isFinite(expiresTime) ? expiresTime : undefined;
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
        if (!Number.isFinite(cookie.maxAge)) {
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
    return true;
  }

  // SameSite enforcement context passed to getCookies.
  // "strict"     – same-site request; all cookies allowed
  // "lax"        – cross-site top-level GET/HEAD navigation; Strict blocked, Lax+None allowed
  // "cross-site" – cross-site subresource or non-GET navigation; only None allowed
  getCookies(
    url: URL,
    fromJs: boolean,
    sameSiteContext: SameSiteContext = "strict",
  ): string {
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

    return validCookies
      .map((cookie) =>
        cookie.name ? `${cookie.name}=${cookie.value}` : cookie.value,
      )
      .join("; ");
  }

  getRequestCookieHeader(context: CookieRequestContext): string {
    return this.getCookies(
      context.url,
      context.fromJs,
      context.sameSiteContext,
    );
  }

  setResponseCookies(context: CookieResponseContext): boolean {
    for (const cookie of context.cookies) {
      this.setCookies(cookie, context.url);
    }
    return true;
  }

  getDocumentCookie(context: DocumentCookieContext): string {
    return this.getCookies(context.url, true);
  }

  setDocumentCookie(context: DocumentSetCookieContext): boolean {
    this.setCookies(context.cookie, context.url);
    return true;
  }

  load(cookies: string | Record<string, Cookie>): boolean {
    if (typeof cookies === "object") {
      console.error("??");
      return false;
    }
    const parsed: Record<string, Cookie> = JSON_parse(cookies);
    this.cookies = {};
    this.byDomain.clear();
    const ids = Object.keys(parsed);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const c = parsed[id];
      if (typeof c.expires === "string") {
        const t = Date.parse(c.expires as unknown as string);
        c.expires = Number.isFinite(t) ? t : undefined;
      }
      this.cookies[id] = c;
      this.indexCookie(c);
    }
    return true;
  }

  clear(): boolean {
    this.cookies = {};
    this.byDomain.clear();
    return true;
  }

  dump(): string {
    return JSON_stringify(this.cookies);
  }
}
