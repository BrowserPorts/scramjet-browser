import { Tap } from "@/Tap";
import type { CodeRewriterHooks, ScramjetContext } from "@/shared";
import type { URLMeta } from "@rewriters/url";

/** Runtime bootstraps use code taps without applying the guest rewriter */
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
	// Obfuscator helpers share the bootstrap's lifetime without becoming guest globals
	return `(() => {\n${props.source}\n})();`;
}
