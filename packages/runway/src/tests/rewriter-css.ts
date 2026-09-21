/**
 * CSS rewriter conformance, executed in the realm the CSS rewriter is published
 * for.
 *
 * `rewriteCss`, `rewriteUrl` and `unrewriteCss` belong to Scramjet's *browser*
 * bundle. The proxy injects that bundle into every proxied document itself (the
 * controller's inject list starts with `config.scramjetPath`), which is what
 * publishes it there as the `$scramjet` global and what the page-side shims call
 * these same entry points through. A proxied document is therefore where this
 * API runs in production.
 *
 * These cases used to import that browser bundle into the runner and call it in
 * Node. Discovery already refuses to do that for a vendored fixture — see the
 * exclusion in `suites/native.ts`, whose reason is that importing browser code
 * would evaluate it in the runner — and this module was doing it through a
 * static import instead. It failed exactly that way: the published bundle spells
 * its `url()` matcher with an inline `(?i:url)` modifier group, Chromium accepts
 * it, Node 22's V8 (12.4) rejects it while compiling the module, and the
 * resulting SyntaxError escaped from the import before a single test ran. An
 * installed consumer's `preflight` reported `suite/discovery-failed` and lost
 * the whole native inventory, not just this module. Calling the rewriter in the
 * document removes the runner's dependency on browser syntax altogether, rather
 * than pinning a Node version or a published bundle revision.
 *
 * The exercise itself is unchanged: the same synthetic context and meta, the
 * same vectors, the same expectations and the same test names. A vector names
 * the author's URL once and refers to its rewritten form as `{encoded}`. `{url}`
 * is substituted here, where it is already known; `{encoded}` is substituted in
 * the document, from what `rewriteUrl` returns there, because the rewritten form
 * is the rewriter's own output and no host-side copy of it would be evidence of
 * anything.
 */
import { scriptTest, type NativeTest } from "../testkit.ts";

/** The author's URL, as written in a vector. Substituted host-side. */
const URL_PLACEHOLDER = "{url}";
/** That URL's rewritten form. Substituted in the document, by the rewriter. */
const ENCODED_PLACEHOLDER = "{encoded}";

/**
 * Preamble shared by every case: the rewriter entry points as a proxied document
 * sees them, and the synthetic context the vectors are written against. The
 * prefix, codec and meta are the same values these cases have always used, so a
 * vector's expected output does not depend on the harness's own configuration.
 */
const PREAMBLE = `
	const rewriteCss = $scramjet.rewriteCss;
	const rewriteUrl = $scramjet.rewriteUrl;
	const unrewriteCss = $scramjet.unrewriteCss;
	const context = {
		config: {},
		prefix: new URL("https://proxy.test/service/"),
		interface: {
			codecEncode: encodeURIComponent,
			codecDecode: decodeURIComponent,
			getInjectScripts: () => [],
		},
		cookieJar: {},
	};
	const meta = {
		origin: new URL("https://example.com"),
		base: new URL("https://example.com/css/app.css"),
	};
`;

/**
 * One case, executed in the proxied document.
 *
 * `$scramjet` is the proxy's own injected bundle, so the reference lane has
 * nothing to compare against: these are candidate-only, exactly as they were
 * when they ran in the runner and were attributed to the candidate.
 */
function cssTest(props: { readonly name: string; readonly js: string }): NativeTest {
	return scriptTest({
		name: props.name,
		candidateOnly: true,
		js: `${PREAMBLE}${props.js}`,
	});
}

/**
 * Renders a vector as a document-side expression.
 *
 * The author's URL is substituted here; the rewritten form stays a placeholder
 * until the document has it.
 */
function vector(template: string, url: string): string {
	const text = template.split(URL_PLACEHOLDER).join(url);
	return `${JSON.stringify(text)}.split(${JSON.stringify(ENCODED_PLACEHOLDER)}).join(encoded)`;
}

function cssRewriteTest(props: {
	readonly name: string;
	readonly url: string;
	readonly input: string;
	readonly expected: string;
}): NativeTest {
	const { name, url, input, expected } = props;
	return cssTest({
		name,
		js: `
			const encoded = rewriteUrl(${JSON.stringify(url)}, context, meta);
			const input = ${vector(input, url)};
			const expected = ${vector(expected, url)};
			const rewritten = rewriteCss(input, context, meta);
			assertEqual(
				rewritten,
				expected,
				${JSON.stringify(`${name}: `)} + input + " should be rewritten to " + expected
			);
		`,
	});
}

function cssRewriteMultiTest(props: {
	readonly name: string;
	readonly input: string;
	readonly urls: readonly string[];
}): NativeTest {
	const { name, input, urls } = props;
	return cssTest({
		name,
		js: `
			const input = ${JSON.stringify(input)};
			const urls = ${JSON.stringify(urls)};
			let expected = input;
			for (const u of urls) {
				const enc = rewriteUrl(u, context, meta);
				expected = expected.split(u).join(enc);
			}
			assertEqual(
				rewriteCss(input, context, meta),
				expected,
				${JSON.stringify(`${name}: multi-url rewrite`)}
			);
		`,
	});
}

function cssUnrewriteTest(props: {
	readonly name: string;
	readonly url: string;
	readonly input: string;
	readonly expected: string;
}): NativeTest {
	const { name, url, input, expected } = props;
	return cssTest({
		name,
		js: `
			const encoded = rewriteUrl(${JSON.stringify(url)}, context, meta);
			const input = ${vector(input, url)};
			const expected = ${vector(expected, url)};
			const unrewritten = unrewriteCss(input, context);
			assertEqual(
				unrewritten,
				expected,
				${JSON.stringify(`${name}: `)} + input + " should be unrewritten to " + expected
			);
		`,
	});
}

export default [
	cssRewriteTest({
		name: "rewriter-css-url",
		url: "/assets/bg.png",
		input: `body{background:url("{url}")}`,
		expected: `body{background:url("{encoded}")}`,
	}),
	cssRewriteTest({
		name: "rewriter-css-import-string",
		url: "/styles/theme.css",
		input: `@import "{url}";`,
		expected: `@import "{encoded}";`,
	}),
	cssRewriteTest({
		name: "rewriter-css-import-url",
		url: "/styles/theme.css",
		input: `@import url("{url}");`,
		expected: `@import url("{encoded}");`,
	}),
	// below tests were llm generated
	cssRewriteTest({
		name: "rewriter-css-import-quoted-string-layer-block",
		url: "/tokens.css",
		input: `@import "{url}" layer(design);`,
		expected: `@import "{encoded}" layer(design);`,
	}),
	cssRewriteTest({
		name: "rewriter-css-import-url-function-layer-block",
		url: "/base.css",
		input: `@import url("{url}") layer(base);`,
		expected: `@import url("{encoded}") layer(base);`,
	}),
	cssRewriteTest({
		name: "rewriter-css-import-url-function-layer-keyword",
		url: "/reset.css",
		input: `@import url("{url}") layer;`,
		expected: `@import url("{encoded}") layer;`,
	}),
	cssRewriteTest({
		name: "rewriter-css-import-url-function-supports",
		url: "/grid.css",
		input: `@import url("{url}") supports(display: grid);`,
		expected: `@import url("{encoded}") supports(display: grid);`,
	}),
	cssRewriteTest({
		name: "rewriter-css-import-url-function-media-list",
		url: "/narrow.css",
		input: `@import url("{url}") screen and (min-width: 400px);`,
		expected: `@import url("{encoded}") screen and (min-width: 400px);`,
	}),
	cssRewriteTest({
		name: "rewriter-css-import-url-layer-supports-media",
		url: "/bundle.css",
		input: `@import url("{url}") layer(theme) supports(display: grid) screen, print;`,
		expected: `@import url("{encoded}") layer(theme) supports(display: grid) screen, print;`,
	}),
	cssRewriteTest({
		name: "rewriter-css-import-single-quoted-url-layer",
		url: "/alt.css",
		input: `@import url('{url}') layer(alt);`,
		expected: `@import url('{encoded}') layer(alt);`,
	}),
	cssRewriteTest({
		name: "rewriter-css-import-quoted-string-layer-keyword",
		url: "/legacy.css",
		input: `@import "{url}" layer;`,
		expected: `@import "{encoded}" layer;`,
	}),
	cssRewriteTest({
		name: "rewriter-css-import-url-supports-with-or-condition",
		url: "/flex.css",
		input: `@import url("{url}") supports((display: flex) or (display: grid));`,
		expected: `@import url("{encoded}") supports((display: flex) or (display: grid));`,
	}),
	cssRewriteTest({
		name: "rewriter-css-url-single-quotes",
		url: "/assets/icon.svg",
		input: `li{list-style:url('{url}')}`,
		expected: `li{list-style:url('{encoded}')}`,
	}),
	cssRewriteTest({
		name: "rewriter-css-url-unquoted",
		url: "/img/x.png",
		input: `p{background-image:url({url})}`,
		expected: `p{background-image:url({encoded})}`,
	}),
	cssRewriteTest({
		name: "rewriter-css-url-whitespace-trimmed",
		url: "/w.png",
		input: `a{background:url(  {url}  )}`,
		expected: `a{background:url({encoded})}`,
	}),
	cssRewriteMultiTest({
		name: "rewriter-css-multiple-url-same-rule",
		input: "a{background:url(/a.png), url(/b.png) 1x, url(/c.png) 2x;}",
		urls: ["/a.png", "/b.png", "/c.png"],
	}),
	cssRewriteTest({
		name: "rewriter-css-double-quoted-url-close-paren-in-string",
		url: "https://example.com/asset)name.png",
		input: `x{background:url("{url}")}`,
		expected: `x{background:url("{encoded}")}`,
	}),
	cssRewriteTest({
		name: "rewriter-css-import-single-quoted",
		url: "/styles/other.css",
		input: `@import '{url}';`,
		expected: `@import '{encoded}';`,
	}),
	cssRewriteTest({
		name: "rewriter-css-import-string-trailing-space",
		url: "/late.css",
		input: `@import "{url}" ;`,
		expected: `@import "{encoded}" ;`,
	}),
	cssTest({
		name: "rewriter-css-data-url-prefixed-not-corrupted",
		js: `
			const data =
				'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"></svg>';
			const enc = rewriteUrl(data, context, meta);
			const input = "i{background:url(" + data + ")}";
			assertEqual(
				rewriteCss(input, context, meta),
				"i{background:url(" + enc + ")}",
				"data: URLs must survive rewrite (commas/quotes inside payload)"
			);
		`,
	}),
	cssTest({
		name: "rewriter-css-quoted-data-url-close-paren-rewritten",
		js: `
			const data = "data:image/svg+xml,<svg><text>hello)</text></svg>";
			const enc = rewriteUrl(data, context, meta);
			const input = 'i{background:url("' + data + '")}';
			assertEqual(
				rewriteCss(input, context, meta),
				'i{background:url("' + enc + '")}'
			);
		`,
	}),
	cssTest({
		name: "rewriter-css-multiple-quoted-url-same-rule-not-overmatched",
		js: `
			const first = "https://example.com/asset)one.png";
			const second = "/asset-two.png";
			const input = 'a{background:url("' + first + '"), url("' + second + '")}';
			assertEqual(
				rewriteCss(input, context, meta),
				'a{background:url("' +
					rewriteUrl(first, context, meta) +
					'"), url("' +
					rewriteUrl(second, context, meta) +
					'")}'
			);
		`,
	}),
	cssTest({
		name: "rewriter-css-about-url-left-unproxied",
		js: `
			const input = "f{behavior:url(about:blank)}";
			assertEqual(rewriteCss(input, context, meta), input);
		`,
	}),
	cssRewriteTest({
		name: "rewriter-css-uppercase-url-function-should-rewrite",
		url: "/z.png",
		input: `b{background:URL("{url}")}`,
		expected: `b{background:URL("{encoded}")}`,
	}),
	cssRewriteTest({
		name: "rewriter-css-mixed-case-url-function-should-rewrite",
		url: "/z.png",
		input: `b{background:uRl("{url}")}`,
		expected: `b{background:uRl("{encoded}")}`,
	}),
	cssTest({
		name: "rewriter-css-block-comment-should-not-rewrite-url",
		js: `
			const path = "/ghost.png";
			const input = "/* hint url(" + path + ") */ .x{}";
			assertEqual(rewriteCss(input, context, meta), input);
		`,
	}),
	cssRewriteTest({
		name: "rewriter-css-unquoted-https-url-encoded",
		url: "https://example.com/a.png?x=1",
		input: `body{background:url({url})}`,
		expected: `body{background:url({encoded})}`,
	}),
	cssTest({
		name: "rewriter-css-empty-url-call-unchanged",
		js: `
			const input = "e{background:url()}";
			assertEqual(rewriteCss(input, context, meta), input);
		`,
	}),
	cssTest({
		name: "rewriter-css-empty-url-var-fallback-unchanged",
		js: `
			const input = ".f{image:var(--custom-image, url())}";
			assertEqual(rewriteCss(input, context, meta), input);
		`,
	}),
	cssTest({
		name: "rewriter-css-empty-quoted-url-calls-unchanged",
		js: `
			const input = "e{background:url(\\"\\"); mask:url('')}";
			assertEqual(rewriteCss(input, context, meta), input);
		`,
	}),
	cssUnrewriteTest({
		name: "rewriter-css-unrewrite-url",
		url: "/assets/bg.png",
		input: `body{background:url("{encoded}")}`,
		expected: `body{background:url("{url}")}`,
	}),
	cssUnrewriteTest({
		name: "rewriter-css-unrewrite-import-string",
		url: "/styles/theme.css",
		input: `@import "{encoded}";`,
		expected: `@import "{url}";`,
	}),
	cssUnrewriteTest({
		name: "rewriter-css-unrewrite-import-url",
		url: "/styles/theme.css",
		input: `@import url("{encoded}");`,
		expected: `@import url("{url}");`,
	}),
	cssUnrewriteTest({
		name: "rewriter-css-unrewrite-uppercase-url-function",
		url: "/z.png",
		input: `b{background:URL("{encoded}")}`,
		expected: `b{background:URL("{url}")}`,
	}),
	cssTest({
		name: "rewriter-css-unrewrite-regression-import-layer-supports-media",
		js: `
			const input =
				'@import url("/bundle.css") layer(theme) supports(display: grid) screen, print;';
			const rewritten = rewriteCss(input, context, meta);
			assertEqual(unrewriteCss(rewritten, context), input);
		`,
	}),
];
