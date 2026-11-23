import type { CookieJar } from "@/shared/cookie";
import type { rewriteJs } from "@rewriters/js";

/**
 * Replaceable implementations of behavior Scramjet needs but does not have to
 * own.
 *
 * Scramjet's built-ins are the right default. An embedder that needs a
 * stricter parser, or one table shared with its own code, registers a
 * replacement here instead of forking the package.
 *
 * Every method is synchronous because every call site sits inside a
 * synchronous rewrite path. An embedder whose implementation needs async setup
 * finishes it before calling `registerProviders`.
 */
export interface ScramjetProviders {
	/**
	 * Whether an attribute is an event handler content attribute, for an
	 * embedder that keeps its own table. Unset, the HTML rewriter uses
	 * Scramjet's list.
	 */
	isEventHandlerAttribute?(name: string): boolean;

	/**
	 * Rewrites every URL in CSS: `url()` values and `@import` targets,
	 * replacing each with what `rewrite` returns for it. `kind` is the
	 * production the text is: a whole stylesheet, a declaration list (a style
	 * attribute, `cssText`) or a single value (`setProperty`, a font face
	 * descriptor). Unset, Scramjet's own CSS rewriter runs.
	 */
	rewriteCssUrls?(
		source: string,
		rewrite: (url: string, kind?: "url" | "import") => string,
		kind?: "stylesheet" | "declarations" | "value"
	): string;

	/**
	 * Builds the cookie store a browsing context starts with. Unset, each
	 * context gets a fresh `CookieJar`.
	 */
	createCookieStore?(): CookieJar;

	/**
	 * Rewrites script text: inline scripts, event handler attributes and
	 * `javascript:` URLs met while rewriting HTML and URLs. The full builds
	 * register Scramjet's wasm rewriter. Without one script text is left as it
	 * is, which suits a runtime that keeps the page's own URL and only maps
	 * where its files load from
	 */
	rewriteJs?: typeof rewriteJs;
}

let active: ScramjetProviders = {};

/**
 * Replaces some or all providers. Entries left out keep the implementation in
 * effect. Call it before the behavior it replaces is first used.
 */
export function registerProviders(
	replacements: Partial<ScramjetProviders>
): void {
	active = { ...active, ...replacements };
}

/** Restores Scramjet's own implementations. */
export function resetProviders(): void {
	active = {};
}

export function providers(): ScramjetProviders {
	return active;
}
