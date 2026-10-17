/**
 * WPT suite adapter: discovery and inventory, in the canonical shape.
 *
 * This is the WPT counterpart of `suites/native.ts`. It produces
 * {@link InventoryEntry} values and nothing else — no scheduling, no browser, no
 * record. The canonical run owns all of that, exactly as it does for the native
 * suite.
 *
 * The one structural difference from the native suite is where cases come from.
 * Native discovery imports test modules from a directory. WPT discovery reads a
 * manifest produced from a real upstream checkout by WPT's own parser, because the
 * denominator has to be upstream's, not this runner's idea of it.
 */
import { readFile } from "node:fs/promises";
import { RunwayError } from "../../core/errors.ts";
import type { SuiteId } from "../../core/ids.ts";
import { CAPABILITIES, type CapabilityId, type InventoryEntry } from "../../core/inventory.ts";
import {
	buildWptInventory,
	type WptInventory,
	type WptInventoryOptions,
} from "./inventory.ts";
import {
	manifestIdentityRecord,
	parseWptManifest,
	wptSuiteId,
	type ReadManifestOptions,
	type WptManifest,
} from "./manifest.ts";

export type WptDiscoveryRequest = {
	/** Absolute path to a manifest produced by `generate-wpt.py`. */
	readonly manifestPath: string;
	readonly inventory?: WptInventoryOptions;
	/**
	 * Accept a manifest that does not describe its whole selection.
	 *
	 * Off by default. See {@link ReadManifestOptions.allowIncomplete}: the resulting
	 * entries carry `manifestIncomplete: true` and are refused execution by
	 * {@link assertExecutable}.
	 */
	readonly allowIncomplete?: boolean;
};

export type WptDiscovery = {
	readonly suite: SuiteId;
	readonly entries: readonly InventoryEntry[];
	readonly manifest: WptManifest;
	readonly inventory: WptInventory;
	/** Identity of the upstream sources this denominator was built from. */
	readonly identity: Readonly<Record<string, string>>;
};

/**
 * Reads a manifest and produces the suite's inventory.
 *
 * Fails rather than returning a partial inventory: a suite that silently discovers
 * fewer cases than the manifest lists is the accounting bug the inventory exists to
 * prevent, and `buildWptInventory` already retains every unsupported case with a
 * reason instead of dropping it.
 */
export async function discoverWptCases(request: WptDiscoveryRequest): Promise<WptDiscovery> {
	let text: string;
	try {
		text = await readFile(request.manifestPath, "utf8");
	} catch (cause) {
		throw new RunwayError(
			"suite/discovery-failed",
			`the WPT manifest could not be read: ${request.manifestPath}`,
			{
				details: { manifestPath: request.manifestPath },
				remedy:
					"Generate one with scripts/generate-wpt.py against the upstream " +
					"checkout you intend to run, and pass its absolute path.",
				cause,
			}
		);
	}
	const options: ReadManifestOptions = { allowIncomplete: request.allowIncomplete === true };
	const manifest = parseWptManifest(text, request.manifestPath, options);
	const inventory = buildWptInventory(manifest, request.inventory ?? {});
	return Object.freeze({
		suite: wptSuiteId(manifest.suite),
		entries: inventory.entries,
		manifest,
		inventory,
		identity: manifestIdentityRecord(manifest),
	});
}

/**
 * Capabilities the *suite* requires of a run, beyond the per-entry ones.
 *
 * Per-entry capabilities live on the inventory entry, as the native suite does it.
 * This is the suite-level statement a preflight can check once.
 */
export const WPT_SUITE_CAPABILITIES: readonly CapabilityId[] = Object.freeze([
	CAPABILITIES.browser,
	CAPABILITIES.wptServer,
]);

/**
 * Gate every entry must pass before the run may execute it.
 *
 * Called by the executor before it touches a lane, and deliberately not only by a
 * reporter: an entry travels further than its summary, so the check has to sit on
 * the path that would otherwise produce a record.
 *
 * Two refusals, both fail-closed:
 *
 * 1. A non-executable entry (`executable: false`) is inventory-only. It is recorded
 *    as `notRun` with the reason the inventory gave it, and no lane is opened.
 * 2. An entry from an incomplete manifest is refused execution outright. Diagnostic
 *    mode may *read* such a manifest, but a record produced from it would be
 *    indistinguishable from one produced against a complete denominator, and no
 *    downstream consumer could tell. Refusing here is what keeps "diagnostic" from
 *    quietly becoming "qualified".
 */
export type ExecutabilityVerdict =
	| { readonly executable: true }
	| {
			readonly executable: false;
			/** `notRun` for inventory-only cases; `setupError` for a short denominator. */
			readonly outcome: "notRun" | "setupError";
			readonly reason: string;
	  };

export function assertExecutable(entry: InventoryEntry): ExecutabilityVerdict {
	if (entry.meta?.manifestIncomplete === true) {
		const reasons = entry.meta?.manifestIncompletenessReasons;
		const detail = Array.isArray(reasons) && reasons.length > 0 ? reasons.join("; ") : "unstated";
		return {
			executable: false,
			// Not `notRun`: the case was not declined, the *denominator* is unsound, and
			// that is a setup problem with the run rather than a property of the case.
			outcome: "setupError",
			reason:
				"this case comes from a manifest that does not describe its whole selection, so a " +
				`record for it could not be read as covering that selection: ${detail}`,
		};
	}
	if (!entry.executable) {
		return {
			executable: false,
			outcome: "notRun",
			reason: entry.notRunReason ?? "this case is inventoried but not executable at this boundary",
		};
	}
	return { executable: true };
}
