/**
 * @fileoverview
 * See `types.ts` for context on these symbols.
 */

import { Symbol_for } from "@/shared/snapshot";

export const SCRAMJETCLIENTNAME = "scramjet client global";

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
 */
declare const SCRAMJETCLIENTBRAND: unique symbol;

export const SCRAMJETCLIENT: typeof SCRAMJETCLIENTBRAND = Symbol_for(
	SCRAMJETCLIENTNAME
) as typeof SCRAMJETCLIENTBRAND;
