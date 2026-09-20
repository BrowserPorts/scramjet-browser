/**
 * Loads the patched libcurl fork as an OPTIONAL, dynamically imported dependency
 * and hands back a gated transport.
 *
 * The import is dynamic and the specifier is supplied by the caller, so nothing
 * here creates a static dependency on the fork: a build that never calls this
 * never pulls libcurl in, which is what keeps the LGPL component optional.
 *
 * There is no fallback. If the module is missing, or is the unpatched upstream
 * build, this throws. Rerouting to a default-trust transport would quietly test
 * something other than what the run asked for.
 */
import {
	ForkUnavailable,
	ScopedLibcurlTransport,
	type ForkModule,
	type ScopedLibcurlOptions,
} from "./scoped-libcurl-transport.ts";

/** Where the built fork lives, and how to reach it. */
export type ForkLoadConfig = {
	/**
	 * Module specifier for the built fork's ESM entry, e.g. a URL served by the
	 * harness page. Resolved by the host's dynamic import.
	 */
	readonly moduleUrl: string;
	/** Named export holding the libcurl object. Defaults to "libcurl". */
	readonly exportName?: string;
};

/**
 * Imports the fork and returns its libcurl object without gating it.
 *
 * @param config - Where to load from.
 * @returns The module's libcurl object.
 * @throws ForkUnavailable when the module cannot be loaded or has no such export.
 */
export async function loadForkModule(config: ForkLoadConfig): Promise<ForkModule> {
	if (!config || typeof config.moduleUrl !== "string" || config.moduleUrl.length === 0) {
		throw new TypeError("moduleUrl is required");
	}
	const exportName = config.exportName ?? "libcurl";
	let namespace: Record<string, unknown>;
	try {
		namespace = (await import(/* @vite-ignore */ config.moduleUrl)) as Record<string, unknown>;
	} catch (cause) {
		throw new ForkUnavailable(
			`could not import ${config.moduleUrl} (${(cause as Error).message})`
		);
	}
	const candidate = namespace[exportName] ?? namespace.default;
	if (candidate === undefined || candidate === null) {
		throw new ForkUnavailable(`${config.moduleUrl} has no "${exportName}" export`);
	}
	return candidate as ForkModule;
}

/**
 * Loads the fork, constructs the transport (which gates the ABI) and initialises
 * it.
 *
 * @param config - Where to load the fork from.
 * @param options - Immutable run options including the scoped trust.
 * @returns An initialised transport.
 */
export async function openScopedLibcurlTransport(
	config: ForkLoadConfig,
	options: ScopedLibcurlOptions
): Promise<ScopedLibcurlTransport> {
	const module_ = await loadForkModule(config);
	const transport = new ScopedLibcurlTransport(module_, options);
	await transport.init();
	return transport;
}
