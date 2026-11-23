import { Tap } from "@/Tap";
import type { CodeRewriterHooks, ScramjetContext } from "@/shared";
import type { URLMeta } from "@rewriters/url";

/**
 * Code scramjet injects itself - a document's bootstrap, a worker's prelude,
 * the wasm payload - handed to the `injectedJavascript` code hook. It is not
 * guest javascript, so the guest rewriter does not run over it.
 */
export function rewriteInjectedJs(
	source: string,
	kind: CodeRewriterHooks["injectedJavascript"]["context"]["kind"],
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false
): string {
	const hook = context.hooks?.rewriter.code?.injectedJavascript;
	if (!hook) return source;
	const props = { source };
	Tap.dispatchSync(hook, { kind, meta, isModule }, props);

	// what a plugin adds shares the bootstrap's lifetime without becoming a
	// global of the page
	return `(() => {\n${props.source}\n})();`;
}
