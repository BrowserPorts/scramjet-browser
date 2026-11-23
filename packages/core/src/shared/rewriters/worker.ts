import { flagEnabled, ScramjetContext } from "@/shared";
import { rewriteJs } from "@rewriters/js";
import { URLMeta } from "@rewriters/url";
import { TextDecoder_decode } from "@/shared/snapshot";
import { base64Encode } from "@/shared/util";
import { rewriteInjectedJs } from "./injected";

export function rewriteWorkers(
	js: string | Uint8Array,
	url: string,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean
) {
	const script = (script: string) => {
		if (isModule) {
			return `import "${script}"\n`;
		}
		return `importScripts("${script}");\n`;
	};
	const b64 = (script: string) =>
		`data:text/javascript;charset=utf-8;base64,${base64Encode(script)}`;
	// a plugin's worker prelude runs before any of scramjet's worker runtime
	// does, so what it installs is in place before the runtime's imports
	const prelude = rewriteInjectedJs("", "workerPrelude", context, meta, isModule);
	let str = prelude ? script(b64(prelude)) : "";
	str += context.interface.getWorkerInjectScripts(meta, isModule, script, (source) =>
		rewriteInjectedJs(source, "worker", context, meta, isModule)
	);

	let rewritten = rewriteJs(js, url, context, meta, isModule);
	if (typeof rewritten !== "string") {
		rewritten = TextDecoder_decode(rewritten);
	}

	if (flagEnabled("encapsulateWorkers", context)) {
		// TODO: check if there's already a sourceURL/sourcemap before appending another?
		rewritten += `//# sourceURL=${url}`;
		str += script(b64(rewritten as string));
	} else {
		str += rewritten;
	}
	return str;
}
