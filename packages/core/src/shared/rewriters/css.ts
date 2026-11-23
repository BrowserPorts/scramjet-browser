import {
	URLMeta,
	isFragmentOnly,
	rewriteUrl,
	unrewriteUrl,
} from "@rewriters/url";
import { ScramjetContext } from "@/shared";
import { providers } from "@/shared/providers";
import { Tap } from "@/Tap";
import { RegExp_exec, String } from "@/shared/snapshot";

/**
 * The production a piece of CSS is: a whole stylesheet, a declaration list (a
 * style attribute, `cssText`) or one value (`setProperty`, a font face
 * descriptor). Scramjet's own rewriter treats them alike; a provider or a code
 * plugin that parses CSS needs to know which grammar to use.
 */
export type CssKind = "stylesheet" | "declarations" | "value";

export function rewriteCss(
	css: string,
	context: ScramjetContext,
	meta: URLMeta,
	kind: CssKind = "stylesheet"
) {
	const result = { source: handleCss("rewrite", css, context, meta, kind) };
	const hooks = context.hooks?.rewriter.code;
	if (hooks)
		Tap.dispatchSync(hooks.css, { meta, direction: "rewrite", kind }, result);

	return result.source;
}

export function unrewriteCss(
	css: string,
	context: ScramjetContext,
	kind: CssKind = "stylesheet"
) {
	const result = {
		source: handleCss("unrewrite", css, context, undefined, kind),
	};
	const hooks = context.hooks?.rewriter.code;
	if (hooks)
		Tap.dispatchSync(
			hooks.css,
			{
				meta: { base: context.prefix, origin: context.prefix } as URLMeta,
				direction: "unrewrite",
				kind,
			},
			result
		);

	return result.source;
}

/**
 * Whether `css` has anything {@link handleCss} would change: a `url(` or an
 * `@import`, as its two expressions spell them. Most of what goes through here
 * - an animation's `transform`, a `--var` - has neither, and both expressions
 * cost far more than this to run over it.
 */
const mayHoldUrl = /(?i:url)\(|@import/;

export function cssMayHoldUrl(css: string): boolean {
	return RegExp_exec(mayHoldUrl, css) !== null;
}

function handleCss(
	type: "rewrite" | "unrewrite",
	css: string,
	context: ScramjetContext,
	meta?: URLMeta,
	kind: CssKind = "stylesheet"
) {
	return rewriteCssUrls(
		String(css),
		(url) => {
			// https://drafts.csswg.org/css-values-4/#local-urls - a URL whose
			// first character is `#` is a reference to an element in the
			// document that uses the style (an SVG gradient, clip path, mask,
			// filter or marker). It is never resolved against a base, so a
			// rewritten one is an external resource that never renders
			if (isFragmentOnly(url)) return url;

			return type === "rewrite"
				? rewriteUrl(url, context, meta!)
				: unrewriteUrl(url, context);
		},
		kind
	);
}

/**
 * Every URL in CSS, `url()` values and `@import` targets, replaced with what
 * `rewrite` returns for it: through the embedder's `rewriteCssUrls` provider
 * when one is registered, or Scramjet's own
 */
export function rewriteCssUrls(
	source: string,
	rewrite: (url: string, kind?: "url" | "import") => string,
	kind: CssKind = "stylesheet"
): string {
	const provider = providers().rewriteCssUrls;
	if (provider) return provider(source, rewrite, kind);

	// regex from vk6 (https://github.com/ading2210)
	const urlRegex =
		/(?i:url)\((?:\s*"((?:\\.|[^"])+)"\s*|\s*'((?:\\.|[^'])+)'\s*|((?!\s*['"])(?!\s*\))(?:\\.|[^)])+?))\)/gm;
	const Atruleregex =
		/@import\s+((?i:url)\s*?\(.{0,9999}?\)|['"].{0,9999}?['"]|.{0,9999}?)($|\s|;)/gm;
	let css = String(source);
	if (!cssMayHoldUrl(css)) return css;
	css = css.replace(
		urlRegex,
		(
			match,
			doubleQuotedUrl: string | undefined,
			singleQuotedUrl: string | undefined,
			unquotedUrl: string | undefined
		) => {
			const url = doubleQuotedUrl ?? singleQuotedUrl ?? unquotedUrl;
			const encodedUrl = rewrite(url.trim(), "url");

			// a callback - see the @import rewrite below
			return match.replace(url, () => encodedUrl);
		}
	);
	css = css.replace(Atruleregex, (match, importStatement: string) => {
		const rewritten = importStatement.replace(
			/^(url\(['"]?|['"]|)(.+?)(['"]|['"]?\)|)$/gm,
			(match: string, firstQuote: string, url: string, endQuote: string) => {
				if (firstQuote.startsWith("url")) {
					return match;
				}
				const encodedUrl = rewrite(url.trim(), "import");

				return `${firstQuote}${encodedUrl}${endQuote}`;
			}
		);

		// a callback, not the string: a fragment is not percent-encoded, and
		// `$` in it would be read as a replacement pattern
		return match.replace(importStatement, () => rewritten);
	});

	return css;
}
