import { URLMeta, rewriteUrl, unrewriteUrl } from "@rewriters/url";
import { ScramjetContext } from "@/shared";
import { providers } from "@/shared/providers";
import { String } from "@/shared/snapshot";

export function rewriteCss(
	css: string,
	context: ScramjetContext,
	meta: URLMeta
) {
	return handleCss("rewrite", css, context, meta);
}

export function unrewriteCss(css: string, context: ScramjetContext) {
	return handleCss("unrewrite", css, context);
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
