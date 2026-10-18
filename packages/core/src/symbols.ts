import { identityName } from "./runtime-identity";
/**
 * @fileoverview
 * See `types.ts` for context on these symbols.
 */

import { Symbol_for } from "@/shared/snapshot";

export const SCRAMJETCLIENTNAME = identityName("scramjet client global");

/**
 * Brand for the registered-symbol key below.
 *
 * The runtime identity is `Symbol.for(SCRAMJETCLIENTNAME)`, shared by every
 * realm that asks the registry for the same name — that is the whole point of
 * using a registered symbol, and it is unchanged. But a computed property in an
 * interface needs a key whose type is `unique symbol`, and `Symbol_for` (the
 * snapshotted `Symbol.for`) is typed to return the widened `symbol`. Declaring
 * the brand and asserting the snapshotted call to it keeps both halves: the
 * value is still the registered symbol, and `Window`/`Document` can declare
 * `[SCRAMJETCLIENT]` in `global.d.ts` in a form that survives declaration emit.
 *
 * `tsc` emits this `declare const` into `dist/types/symbols.d.ts` next to the
 * export that uses it, so a consumer resolves the property key by importing
 * `SCRAMJETCLIENT` from the package — no ambient stub and no separate tag to
 * import.
 *
 * NOTE: this symbol no longer carries the live `ScramjetClient`. The client is
 * held in a module-level `WeakMap` (client/clients.ts) that a page script
 * cannot reach. What remains on the global under this key is the inert
 * {@link SCRAMJETMARKER} — a cross-realm, cross-bundle presence flag that lets
 * one Scramjet realm avoid double-hooking another without exposing any internal
 * state. Nothing reachable from it leads back to the client, its `natives` or
 * the `SingletonBox`.
 */
declare const SCRAMJETCLIENTBRAND: unique symbol;

export const SCRAMJETCLIENT: typeof SCRAMJETCLIENTBRAND = Symbol_for(
	SCRAMJETCLIENTNAME
) as typeof SCRAMJETCLIENTBRAND;

/**
 * The value stored on a hooked global under {@link SCRAMJETCLIENT}. It exposes
 * nothing: its only job is to answer the `SCRAMJETCLIENT in global` /
 * `global[SCRAMJETCLIENT]` presence checks that one realm uses to tell whether a
 * related window (parent, opener, a nested frame it is about to hook) is already
 * a Scramjet realm. Truthy and shared across bundles by value, never by
 * identity.
 */
export const SCRAMJETMARKER = true;
