import { CookieJar, type CookieStore } from "@/shared/cookie";
import type { ScramjetContext } from "@/shared";
import type { URLMeta } from "@rewriters/url";
import {
	isHtmlMimeType,
	isJavascriptMimeType,
	parseMimeType,
} from "@/shared/mime";
import {
	bomSniff,
	extractCharsetFromContentType,
	getEncoding,
	sniffEncoding,
} from "@/shared/sniffEncoding";
import { String, _TextDecoder } from "@/shared/snapshot";

/**
 * Replaceable implementations of behavior Scramjet needs but does not have to
 * own.
 *
 * Scramjet's built-ins are small and dependency free, which is the right
 * default. An embedder that needs stricter parsing or differently-scoped
 * storage registers replacements here instead of forking this package.
 *
 * The parsing methods are synchronous because every call site sits inside a
 * synchronous rewrite path. An embedder whose implementation needs async setup
 * must finish that setup before calling registerProviders.
 */
export interface ContentType {
	mimeType: string;
	charset: string;
	hadCharset: boolean;
	boundary: string;
}

export interface TextDecodeResult {
	text: string;
	encoding: string;
	sawError: boolean;
}

export interface TextDecoderFacts {
	defaultEncoding: string;
	responseCharset: string;
	parentCharset: string;
}

export interface ScramjetProviders {
	/** A standards-aware embedder can share its event attribute table with the HTML rewriter */
	isEventHandlerAttribute?(name: string): boolean;
	/**
   * Rewrites every URL in a stylesheet, including `url()` values and
   * `@import` targets, returning the stylesheet with each URL replaced by
   * the value `rewrite` returns for it.
   */
	rewriteCssUrls(
		source: string,
		rewrite: (url: string, kind?: "url" | "import") => string,
		kind?: "stylesheet" | "declarations" | "value",
	): string;

	/**
   * Rewrites every candidate URL in a `srcset` attribute value, preserving
   * the descriptors attached to each candidate.
   */
	rewriteSrcsetUrls(source: string, rewrite: (url: string) => string): string;

	/**
   * Rewrites every URL inside a `Link` header (or any string using the
   * `<url>` form), returning the header with each URL replaced by the
   * value `rewrite` returns for it.
   */
	rewriteLinkHeaderUrls(
		source: string,
		rewrite: (url: string) => string,
	): string;

	/**
   * Returns the value of `requestedName` from a raw response-header block,
   * or `null` if that header is absent.
   */
	xhrResponseHeaderValue(source: string, requestedName: string): string | null;

	/**
   * Rewrites `Link` URLs inside a raw XHR header block.
   */
	rewriteXhrLinkHeaders(
		source: string,
		rewrite: (url: string) => string,
	): string;

	parseContentType(contentType: string): ContentType;
	contentTypeIsHtml(contentType: string): boolean;
	contentTypeIsSupportedJavascript(contentType: string): boolean;

	decodeTextResource(
		content: Uint8Array,
		url: string,
		mimeType: string,
		facts: TextDecoderFacts,
	): TextDecodeResult;
	decodeCssResource(
		content: Uint8Array,
		defaultEncoding: string,
		responseCharset: string,
	): TextDecodeResult;
	decodePlainTextResource(
		content: Uint8Array,
		defaultEncoding: string,
		responseCharset: string,
	): TextDecodeResult;
	decodeUtf8Resource(content: Uint8Array): TextDecodeResult;
	decodeWorkerClassicResource(
		content: Uint8Array,
		responseEncoding: string,
	): TextDecodeResult;

	/**
   * Builds the cookie store for a browsing context. Called once per context,
   * so a partitioned implementation can key storage off whatever scope it
   * cares about.
   */
	createCookieStore(): CookieStore;

	/**
	 * Rewrites script text: inline scripts, event handler attributes and
	 * `javascript:` URLs met while rewriting HTML and URLs. The full builds
	 * register Scramjet's wasm rewriter. Without one, script text is left as it
	 * is, which suits a runtime that keeps the page's own URL and only maps where
	 * its files load from.
	 */
	rewriteJs?(
		js: string | Uint8Array,
		url: string | null,
		context: ScramjetContext,
		meta: URLMeta,
		isModule?: boolean,
		functionBody?: boolean,
	): string | Uint8Array;

	/**
	 * Takes the place of `rewriteJs` while the `realmExecution` flag is on. The
	 * embedder keeps the original source and runs it in its own realm, and this
	 * returns the text the page carries in its place. That text must never hold
	 * page code, because it runs in this document's own realm. `handler` is a
	 * function body (event handler attributes), `module` is a module, and script
	 * text from a `javascript:` URL arrives as `classic` with `url` set to
	 * JAVASCRIPT_URL_LABEL. With the flag on and no provider registered,
	 * rewriting fails instead of falling back to the wasm rewriter.
	 */
	realmScript?(
		js: string | Uint8Array,
		url: string | null,
		context: ScramjetContext,
		meta: URLMeta,
		kind: RealmScriptKind,
	): string | Uint8Array;
}

/** What a piece of script text is, as far as running it in a realm goes */
export type RealmScriptKind = "classic" | "module" | "handler";

// regex from vk6 (https://github.com/ading2210)
const urlRegex =
	/url\((?:\s*"((?:\\.|[^"])+)"\s*|\s*'((?:\\.|[^'])+)'\s*|((?!\s*['"])(?!\s*\))(?:\\.|[^)])+?))\)/gim;
const atRuleRegex =
	/@import\s+(url\s*?\(.{0,9999}?\)|['"].{0,9999}?['"]|.{0,9999}?)($|\s|;)/gim;
const angleBracketUrlRegex = /<([^>]+)>/gi;
const boundaryParameterRegex = /;\s*boundary=("?)([^";]+)\1/i;

function rewriteAngleBracketUrls(
	source: string,
	rewrite: (url: string) => string,
): string {
	return source.replace(angleBracketUrlRegex, (_match, url: string) => {
		return `<${rewrite(url)}>`;
	});
}

function nativeParseContentType(contentType: string): ContentType {
	const parsed = parseMimeType(contentType);
	const charset = extractCharsetFromContentType(contentType);
	const boundaryMatch = contentType.match(boundaryParameterRegex);
	return {
		boundary: boundaryMatch ? boundaryMatch[2] : "",
		charset: charset ?? "",
		hadCharset: charset !== null,
		mimeType: parsed ? parsed.essence : "",
	};
}

function decodeWithSniffedEncoding(
	content: Uint8Array,
	contentType: string | null,
): TextDecodeResult {
	const encoding = sniffEncoding(content, contentType);
	return {
		encoding,
		sawError: false,
		text: new _TextDecoder(encoding).decode(content),
	};
}

function decodeLabeledBytes(
	content: Uint8Array,
	responseCharset: string,
	defaultEncoding: string,
): TextDecodeResult {
	const bom = bomSniff(content);
	const labeled =
		responseCharset.length > 0
			? getEncoding(responseCharset)
			: defaultEncoding.length > 0
				? getEncoding(defaultEncoding)
				: null;
	const encoding = bom ?? labeled ?? "UTF-8";
	return {
		encoding,
		sawError: false,
		text: new _TextDecoder(encoding).decode(content),
	};
}

function contentTypeHeader(
	mimeType: string,
	responseCharset: string,
	defaultEncoding: string,
): string | null {
	if (responseCharset.length > 0) {
		return `${mimeType}; charset=${responseCharset}`;
	}
	if (defaultEncoding.length > 0) {
		return `${mimeType}; charset=${defaultEncoding}`;
	}
	return mimeType.length > 0 ? mimeType : null;
}

export const nativeProviders: ScramjetProviders = {
	rewriteCssUrls(source, rewrite) {
		let css = String(source);
		css = css.replace(
			urlRegex,
			(
				match,
				doubleQuotedUrl: string | undefined,
				singleQuotedUrl: string | undefined,
				unquotedUrl: string | undefined,
			) => {
				const url = doubleQuotedUrl ?? singleQuotedUrl ?? unquotedUrl;

				return match.replace(url, rewrite(url.trim(), "url"));
			},
		);
		css = css.replace(atRuleRegex, (match, importStatement: string) => {
			return match.replace(
				importStatement,
				importStatement.replace(
					/^(url\(['"]?|['"]|)(.+?)(['"]|['"]?\)|)$/gm,
					(
						match: string,
						firstQuote: string,
						url: string,
						endQuote: string,
					) => {
						if (firstQuote.startsWith("url")) {
							return match;
						}

						return `${firstQuote}${rewrite(url.trim(), "import")}${endQuote}`;
					},
				),
			);
		});

		return css;
	},

	rewriteSrcsetUrls(source, rewrite) {
		const sources = source.split(/ .*,/).map((src) => src.trim());
		const rewrittenSources = sources.map((candidate) => {
			// Split into URLs and descriptors (if any)
			// e.g. url0, url1 1.5x, url2 2x
			const [url, ...descriptors] = candidate.split(/\s+/);

			const rewrittenUrl = rewrite(url.trim());

			return descriptors.length > 0
				? `${rewrittenUrl} ${descriptors.join(" ")}`
				: rewrittenUrl;
		});

		return rewrittenSources.join(", ");
	},

	rewriteLinkHeaderUrls(source, rewrite) {
		return rewriteAngleBracketUrls(source, rewrite);
	},

	xhrResponseHeaderValue(source, requestedName) {
		const requestedLower = requestedName.toLowerCase();
		const lines = source.split("\r\n");
		for (const line of lines) {
			const colon = line.indexOf(":");
			if (colon <= 0) {
				continue;
			}
			if (line.slice(0, colon).trim().toLowerCase() !== requestedLower) {
				continue;
			}
			return line.slice(colon + 1).trim();
		}
		return null;
	},

	rewriteXhrLinkHeaders(source, rewrite) {
		if (source.length === 0) {
			return source;
		}
		return rewriteAngleBracketUrls(source, rewrite);
	},

	parseContentType(contentType) {
		return nativeParseContentType(contentType);
	},

	contentTypeIsHtml(contentType) {
		return isHtmlMimeType(contentType);
	},

	contentTypeIsSupportedJavascript(contentType) {
		return isJavascriptMimeType(contentType);
	},

	decodeTextResource(content, _url, mimeType, facts) {
		return decodeWithSniffedEncoding(
			content,
			contentTypeHeader(mimeType, facts.responseCharset, facts.defaultEncoding),
		);
	},

	decodeCssResource(content, defaultEncoding, responseCharset) {
		return decodeLabeledBytes(content, responseCharset, defaultEncoding);
	},

	decodePlainTextResource(content, defaultEncoding, responseCharset) {
		return decodeLabeledBytes(content, responseCharset, defaultEncoding);
	},

	decodeUtf8Resource(content) {
		return {
			encoding: "UTF-8",
			sawError: false,
			text: new _TextDecoder("UTF-8").decode(content),
		};
	},

	decodeWorkerClassicResource(content, responseEncoding) {
		const encoding = responseEncoding.length > 0 ? responseEncoding : "UTF-8";
		return {
			encoding,
			sawError: false,
			text: new _TextDecoder(encoding).decode(content),
		};
	},

	createCookieStore() {
		return new CookieJar();
	},
};

let active: ScramjetProviders = nativeProviders;

/**
 * Replaces some or all providers. Unspecified entries keep the implementation
 * currently in effect. Must be called before the behavior it replaces is first
 * used, which for `createCookieStore` means before any context is created.
 */
export function registerProviders(
	replacements: Partial<ScramjetProviders>,
): void {
	active = { ...active, ...replacements };
}

/** Restores Scramjet's own implementations. Intended for tests. */
export function resetProviders(): void {
	active = nativeProviders;
}

export function providers(): ScramjetProviders {
	return active;
}
