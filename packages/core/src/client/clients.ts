import type { ScramjetClient } from "./client";

// Captured at module load, before any page script runs, so a page cannot swap
// `WeakMap` out from under the registry. Mirrors `hook/hook-client.ts`.
const NativeWeakMap = globalThis.WeakMap;

/**
 * The live {@link ScramjetClient} for each global scope (and its document) this
 * bundle installed into.
 *
 * Kept in module scope rather than on the global under a registered symbol,
 * where a page script inside the sandbox could reach it with
 * `window[Symbol.for("scramjet client global")]` and, through it, the pristine
 * natives in `client.natives`, `box.unproxy` and the rest of the proxy's
 * internal state. The minimal client (minimal/install.ts) and `HookClient`
 * (hook/hook-client.ts) already keep their clients this way; the full client
 * now matches.
 *
 * A registry is per-bundle, so a lookup only resolves a global this bundle
 * hooked. Cross-realm client access (a sibling frame's client) goes through the
 * shared `SingletonBox.globals` map instead, and cross-realm *presence* (used to
 * avoid double-hooking a frame) goes through the inert marker in symbols.ts.
 */
const clients = new NativeWeakMap<object, ScramjetClient>();

/** Records the client for a global scope (or its document). */
export function setClient(key: object, client: ScramjetClient) {
	clients.set(key, client);
}

/** The client this bundle installed for a global scope (or its document), if any. */
export function getClient(key: object): ScramjetClient | undefined {
	return clients.get(key);
}

/** Whether this bundle installed a client for a global scope (or its document). */
export function hasClient(key: object): boolean {
	return clients.has(key);
}
