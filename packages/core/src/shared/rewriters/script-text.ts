import type { ScramjetContext } from "@/shared";
import { flagEnabled } from "@/shared/flags";
import { providers, type ScramjetProviders } from "@/shared/providers";
import { realmScriptFor } from "@rewriters/realm";
import type { URLMeta } from "@rewriters/url";

/**
 * What rewrites script text met in markup and URLs: inline scripts, event
 * handler attributes and `javascript:` URLs. Builds without the wasm rewriter
 * register none, and then that text stays as it is. In realm mode the built-in
 * stubs answer whether or not a rewriter is registered, because script text
 * left as it is would run in this document's own realm.
 */
export function scriptTextRewriter(
	context: ScramjetContext,
	meta: URLMeta
): ScramjetProviders["rewriteJs"] {
	if (!flagEnabled("realmExecution", context, meta.base)) {
		return providers().rewriteJs;
	}
	return (js, url, scriptContext, _scriptMeta, isModule = false, functionBody = false) =>
		realmScriptFor(scriptContext.config, js, url, isModule, functionBody);
}
