import { URLMeta, rewriteUrl, unrewriteUrl } from "@rewriters/url";
import type { ScramjetContext } from "@/shared";
import { providers } from "@/shared/providers";
import { String } from "@/shared/snapshot";
import { Tap } from "@/Tap";

export function rewriteCss(
	css: string,
	context: ScramjetContext,
	meta: URLMeta,
	kind: "stylesheet" | "declarations" | "value" = "stylesheet"
) {
	const result = { source: handleCss("rewrite", css, context, meta) };
	const hooks = context.hooks?.rewriter.code;
	if (hooks)
		Tap.dispatchSync(hooks.css, { meta, direction: "rewrite", kind }, result);
	return result.source;
}

export function unrewriteCss(
	css: string,
	context: ScramjetContext,
	kind: "stylesheet" | "declarations" | "value" = "stylesheet"
) {
	const result = { source: handleCss("unrewrite", css, context) };
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

function handleCss(
	type: "rewrite" | "unrewrite",
	css: string,
	context: ScramjetContext,
	meta?: URLMeta
) {
	const rewrite = (url: string) =>
		type === "rewrite"
			? rewriteUrl(url, context, meta!)
			: unrewriteUrl(url, context);

	return providers().rewriteCssUrls(String(css), rewrite);
}
