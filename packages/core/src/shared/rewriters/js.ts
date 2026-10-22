import { flagEnabled, ScramjetContext } from "@/shared";
import { URLMeta } from "@rewriters/url";

import { getRewriter, JsRewriterOutput } from "@rewriters/wasm";
import { realmScriptFor } from "@rewriters/realm";
import { providers } from "@/shared/providers";
import { Tap } from "@/Tap";
import { QP } from "@/fetch/qp";
import {
	Array_from,
	TextDecoder_decode,
	_RegExp,
	_Uint8Array,
	Object_keys,
	Performance_now,
} from "../snapshot";

// eslint-disable-next-line scramjet-core/no-globals
Error.stackTraceLimit = 50;

type RewriterResult = {
	js: string | Uint8Array;
	map: Uint8Array | null;
	tag: string;
	errors: string[];
};
function rewriteJsWasm(
	input: string | Uint8Array,
	source: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean
): RewriterResult {
	const [rewriter, ret] = getRewriter(context, meta);

	const flagsobj = {};
	for (const flag of Object_keys(context.config.flags)) {
		flagsobj[flag] = flagEnabled(flag as any, context, meta.base);
	}

	try {
		let out: JsRewriterOutput;
		const before = Performance_now();
		// try {
		if (typeof input === "string") {
			out = rewriter.rewrite_js(
				{
					...context.config.globals,
					prefix: context.prefix.pathname,
					moduleparam: QP.isModule,
					originparam: QP.initiatorOrigin,
				},
				flagsobj,
				context.interface.codecEncode,
				input,
				meta.base.href,
				source || "(unknown)",
				isModule
			);
		} else {
			out = rewriter.rewrite_js_bytes(
				{
					...context.config.globals,
					prefix: context.prefix.pathname,
					moduleparam: QP.isModule,
					originparam: QP.initiatorOrigin,
				},
				flagsobj,
				context.interface.codecEncode,
				input,
				meta.base.href,
				source || "(unknown)",
				isModule
			);
		}
		// } catch (err) {
		// 	const err1 = err as Error;
		// 	console.warn(
		// 		"failed rewriting js for",
		// 		source,
		// 		err1.message,
		// 		input instanceof Uint8Array ? textDecoder.decode(input) : input
		// 	);

		// 	return { js: input, tag: "", map: null };
		// }
		if (flagEnabled("rewriterLogs", context, meta.base)) {
			dbg.time(meta, before, `oxc rewrite for "${source || "(unknown)"}"`);
		}

		const { js, map, scramtag, errors } = out;

		return {
			js: typeof input === "string" ? TextDecoder_decode(js) : js,
			tag: scramtag,
			map,
			errors,
		};
	} finally {
		ret();
	}
}

export function rewriteJsInner(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false
) {
	return rewriteJsWasm(js, url, context, meta, isModule);
}

export function rewriteJs(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false,
	functionBody = false
): string | Uint8Array {
	// In realm mode the page's script is not rewritten at all. The wasm rewriter,
	// the sourcemap push and the code hooks below are skipped, so nothing parses
	// or alters the page's source.
	if (flagEnabled("realmExecution", context, meta.base)) {
		return realmScriptFor(
			providers().realmScript,
			js,
			url,
			context,
			meta,
			isModule,
			functionBody
		);
	}

	let rewritten = false;
	try {
		const res = rewriteJsInner(js, url, context, meta, isModule);
		let newjs = res.js;

		if (flagEnabled("sourcemaps", context, meta.base)) {
			const pushmap = globalThis[context.config.globals.pushsourcemapfn];
			if (pushmap) {
				pushmap(Array_from(res.map), res.tag);
			} else {
				// TODO: how do we check instanceof here?
				if (typeof newjs !== "string") {
					// `TextDecoder_decode` is a bound snapshot, so without
					// `strictBindCallApply` its return type is `any` — annotating the
					// assignment is what keeps `newjs` narrowed to `string` for the
					// source-map splicing below.
					newjs = TextDecoder_decode(newjs) as string;
				}
				const sourcemapfn = `${context.config.globals.pushsourcemapfn}([${res.map.join(",")}], "${res.tag}");`;

				// don't put the sourcemap call before "use strict"
				const strictMode = new _RegExp(/^\s*(['"])use strict\1;?/);
				if (strictMode.test(newjs)) {
					newjs = newjs.replace(strictMode, `$&\n${sourcemapfn}`);
				} else {
					newjs = `${sourcemapfn}\n${newjs}`;
				}
			}
		}

		if (flagEnabled("rewriterLogs", context, meta.base)) {
			for (const error of res.errors) {
				dbg.error("oxc parse error", error);
			}
		}

		rewritten = true;
		const hooks = context.hooks?.rewriter.code;
		if (hooks) {
			const result = { source: typeof newjs === "string" ? newjs : TextDecoder_decode(newjs) as string };
			Tap.dispatchSync(hooks.javascript, { url, meta, isModule, functionBody }, result);
			return result.source;
		}
		return newjs;
	} catch (err) {
		if (rewritten) throw err;
		dbg.warn(
			"failed rewriting js for",
			url || "(unknown)",
			err.message,
			typeof js !== "string" ? TextDecoder_decode(js) : js
		);
		if (flagEnabled("allowInvalidJs", context, meta.base)) {
			return js;
		} else {
			throw err;
		}
	}
}
