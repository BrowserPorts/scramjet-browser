import type { ScramjetContext } from "@/shared";
import type { RealmScriptKind, ScramjetProviders } from "@/shared/providers";
import type { URLMeta } from "@rewriters/url";

// This file holds only type imports so it can be loaded on its own, which the
// gate tests rely on.

/** The label the URL rewriter gives script text taken from a `javascript:` URL */
export const JAVASCRIPT_URL_LABEL = "(javascript: url)";

export function realmScriptKind(
	isModule: boolean,
	functionBody: boolean
): RealmScriptKind {
	if (functionBody) return "handler";
	return isModule ? "module" : "classic";
}

/**
 * Hands script text to the realm provider. A missing provider is an error: the
 * flag exists so page code never runs in this document's own realm, and
 * quietly rewriting it instead would put it there.
 */
export function realmScriptFor(
	provider: ScramjetProviders["realmScript"],
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean,
	functionBody: boolean
): string | Uint8Array {
	if (!provider) {
		// This file imports nothing at runtime so tests can load it without the
		// build's path aliases, which rules out the snapshotted Error. It is only
		// reached with realmExecution on, where page code does not run in this
		// realm to tamper with Error
		// eslint-disable-next-line scramjet-core/no-globals
		throw new Error(
			"realmExecution is on but no realmScript provider is registered"
		);
	}
	return provider(
		js,
		url,
		context,
		meta,
		realmScriptKind(isModule, functionBody)
	);
}
