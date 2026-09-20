/**
 * WPT inventory: the denominator, at this boundary's declared limits.
 *
 * Two rules shape this module.
 *
 * **Nothing is dropped.** Every case the manifest lists becomes an inventory
 * entry, including the ones this boundary cannot execute. An unsupported case is
 * recorded with `executable: false` and a concrete reason, so it counts in the
 * denominator and records `notRun` instead of disappearing. Shrinking an inventory
 * to the cases a runner happens to support is how a partial implementation starts
 * looking like a complete one.
 *
 * **Nothing is inferred.** What a case *is* comes from the manifest fields
 * upstream's own parser filled in — item type, `https`, `subdomain`, testdriver,
 * timeout class — never from its file name, its title, or the shape of its URL.
 *
 * The supported kind at this boundary is deliberately small and is stated in
 * {@link SUPPORTED_KIND}: a `testharness` document over plain HTTP, on the primary
 * host, with no testdriver. Everything else — TLS, subdomains, testdriver,
 * reftests, crashtests, manual cases, print-reftests — is inventoried and refused
 * with its reason. This is a foundation, not a parity claim.
 */
import { composeTestId, laneId, type LaneId, type TestId } from "../../core/ids.ts";
import { CAPABILITIES, type CapabilityId, type InventoryEntry } from "../../core/inventory.ts";
import {
	encodeUpstreamUrl,
	harnessTimeoutMsOf,
	requiresTestDriver,
	timeoutClassOf,
	variantOf,
	wptSuiteId,
	type WptManifest,
	type WptManifestTest,
	type WptOtherCase,
	type WptOtherCaseItem,
} from "./manifest.ts";

const BARE_LANE: LaneId = laneId("bare");
const SCRAMJET_LANE: LaneId = laneId("scramjet");

/**
 * The one execution form this boundary implements.
 *
 * Stated as data so a test can assert it, and so a report can quote the limit
 * rather than paraphrase it.
 */
export const SUPPORTED_KIND = Object.freeze({
	itemType: "testharness",
	scheme: "http",
	host: "primary",
	testdriver: false,
	description:
		"a testharness document loaded over plain HTTP from the primary wptserve host, " +
		"with no testdriver, no subdomain and no TLS",
});

/**
 * Margin added to the upstream harness timeout to get the runner's deadline.
 *
 * The runner's deadline must be strictly longer than the page's own harness
 * timeout. Upstream reacts to its own timeout by producing a *real* completion:
 * harness status `TIMEOUT`, with each subtest carrying its own status. A runner
 * that gave up first would replace that observation with one of its own and report
 * an upstream-visible timeout as a runner-side failure — a different fact, logged
 * under the same word. The margin covers navigation, script load and the trip back
 * through the binding; it is a constant here so that it is visible and reviewable
 * rather than scattered across call sites.
 */
export const RUNNER_DEADLINE_MARGIN_MS = 15_000;

/**
 * Capabilities every executable case at this boundary needs.
 *
 * `proxyRoute` is declared here, and it is load-bearing rather than descriptive.
 * `core/verification.ts` `requirementsFor()` turns it into
 * `routeInstrumentation: wantsRoute && lane.role === "candidate"`, so declaring it is
 * what makes a candidate-lane WPT record require a host-side route observation in
 * order to qualify. Omitting it would silently exempt every WPT case from that gate —
 * the candidate lane would be free to serve the case off the proxy path entirely and
 * still report a qualified pass.
 *
 * This is a statement about *this adapter's* proxy contract: a WPT case executed on a
 * candidate lane must be shown to have travelled the candidate route. It is not a
 * claim about any future browser or lane in general, and the reference lane is
 * unaffected because `requirementsFor` scopes the requirement to `candidate`.
 *
 * Upstream wptserve is a separate process and does not feed `RouteObserver`.
 * Without route observation, a candidate-lane WPT case cannot
 * qualify yet — the requirement stays declared and fails, and is never relaxed or
 * satisfied with a manufactured match.
 */
const EXECUTABLE_CAPABILITIES: readonly CapabilityId[] = Object.freeze([
	CAPABILITIES.browser,
	CAPABILITIES.wptServer,
	CAPABILITIES.proxyRoute,
]);

/** Why a case is inventoried but not executable here. Never a generic string. */
export type UnsupportedReason = {
	readonly code:
		| "tls-not-established"
		| "subdomain-host-unavailable"
		| "testdriver-unavailable"
		| "unknown-timeout-class"
		| "item-type-unsupported"
		| "jsshell-unsupported"
		| "pac-unsupported"
		| "h2-required"
		| "capability-unknown";
	readonly detail: string;
};

/**
 * Decides whether a testharness case is executable at this boundary.
 *
 * Every branch names an actual manifest field. The order is deliberate: the
 * strongest environmental prerequisite first, so a case that is blocked by several
 * things reports the one a consumer would have to solve first.
 */
export function unsupportedReasonFor(test: WptManifestTest): UnsupportedReason | null {
	// Unknown before unsupported. A flag the producer never recorded is not a flag
	// that is false, and planning a case whose transport requirement is unknown as
	// a plain-HTTP case is how an h2 case gets served by the wrong listener. The
	// case is retained with this reason rather than dropped or guessed.
	if (test.h2 === null) {
		return {
			code: "capability-unknown",
			detail:
				"this manifest's producer does not declare that it records upstream's h2 flag " +
				"(provenance.inventory.recordedTestFlags omits \"h2\"), so whether this case requires " +
				"HTTP/2 is unknown. It is retained in the denominator and not executed, because an " +
				"unrecorded flag is not the same as a flag that is false. Regenerate the manifest " +
				"with a producer that records h2.",
		};
	}
	if (test.h2) {
		return {
			code: "h2-required",
			detail:
				"upstream flags this case h2, so it must be served by wptserve's HTTP/2 listener. " +
				"This boundary serves plain HTTP/1.1 only and will not substitute it: the protocol " +
				"is part of what the case tests.",
		};
	}
	if (test.https) {
		return {
			code: "tls-not-established",
			detail:
				"upstream marks this case https. This boundary establishes no TLS or secure-context " +
				"parity, and it will not be downgraded to http: rewriting the scheme would change " +
				"what the case tests.",
		};
	}
	if (test.subdomain) {
		return {
			code: "subdomain-host-unavailable",
			detail:
				"upstream marks this case as needing an alternate subdomain host, which requires " +
				"name resolution this boundary does not configure.",
		};
	}
	if (requiresTestDriver(test)) {
		return {
			code: "testdriver-unavailable",
			detail:
				"upstream declares testdriver.js for this case (via the testdriver flag, " +
				"testdriverFeatures, or a META script include). testdriver needs browser automation " +
				"wiring that this boundary does not own.",
		};
	}
	if (test.jsshell === true) {
		return {
			code: "jsshell-unsupported",
			detail: "upstream marks this case jsshell; it is not a browser document.",
		};
	}
	if (test.pac !== undefined) {
		return {
			code: "pac-unsupported",
			detail: `upstream declares a PAC script (${test.pac}) this boundary does not install.`,
		};
	}
	if (timeoutClassOf(test) === "unknown") {
		return {
			code: "unknown-timeout-class",
			detail:
				`upstream declares the timeout class ${JSON.stringify(test.timeout)}, which this ` +
				"build has no harness timeout for. A deadline is never invented for an unknown class.",
		};
	}
	return null;
}

export type WptInventoryOptions = {
	/**
	 * Lanes each case is defined for.
	 *
	 * Defaults to both lanes, because a WPT case is only evidence when the same
	 * unchanged case runs in the reference lane and the candidate lane.
	 */
	readonly lanes?: readonly LaneId[];
	/** Added to the upstream harness timeout. Defaults to {@link RUNNER_DEADLINE_MARGIN_MS}. */
	readonly deadlineMarginMs?: number;
};

export type WptInventoryEntry = InventoryEntry & {
	/** The manifest URL this entry came from, verbatim. */
	readonly upstreamUrl: string;
};

/**
 * Incompleteness marker carried by **every** entry, not only the summary.
 *
 * An entry travels further than its summary does: it becomes a planned test, a
 * snapshot row and eventually a record, and at each of those points the question
 * "was this built on a complete denominator?" has to be answerable without going
 * back to the manifest. So the marker is stamped into `meta` on every entry.
 *
 * `manifestIncomplete: true` means the entry came from a manifest that does not
 * describe its whole selection (read in diagnostic mode). Nothing here can enforce
 * what a planner does with that — this is a foundation module with no planner
 * integration — so the contract is deliberately narrow and stated as such: the fact
 * is carried and is machine-readable, and gating on it is an integration gate the
 * run/config owner still has to wire. Reading manifests defaults to refusing an
 * incomplete one precisely so that this path is opt-in rather than ambient.
 */
export type IncompletenessMarker = {
	readonly manifestIncomplete: boolean;
	readonly manifestIncompletenessReasons: readonly string[];
};

export type WptInventorySummary = {
	readonly suite: string;
	readonly revision: string;
	/** Entries produced from `tests[]`. */
	readonly testharnessCases: number;
	/** Entries produced from `otherCases[].items[]`. */
	readonly otherCases: number;
	readonly executable: number;
	readonly retainedUnsupported: number;
	/** Unsupported counts by reason code, so a limit is always quantified. */
	readonly unsupportedByReason: Readonly<Record<string, number>>;
	/**
	 * Support files the manifest inventoried.
	 *
	 * Carried, not turned into entries: a support file is not a case, and making
	 * one an entry would inflate the denominator with something that can never
	 * produce a result. Reported so the number is never simply absent.
	 */
	readonly supportFiles: number;
	/** Colliding URLs mapped to the sources that produced them. */
	readonly duplicateTestUrls: ReadonlyMap<string, readonly string[]>;
	/** Cases dropped to those collisions: `sum(sources.length - 1)`. */
	readonly droppedDuplicateCount: number;
	readonly manifestUnrecognizedFields: readonly string[];
	/**
	 * Selected files the producer could not parse.
	 *
	 * Carried into the summary because those upstream sources contributed no cases
	 * at all: they are missing from the denominator and cannot be retained as
	 * entries, since the producer never learned what cases they contain.
	 */
	readonly unparsableSourceFileCount: number;
	readonly allSelectedFilesParsed: boolean;
	/**
	 * Non-empty when this inventory is built on a short denominator.
	 *
	 * Anything derived from it is unqualified: it may be reported, but it may not
	 * be quoted as covering the selection it names.
	 */
	readonly incompleteness: readonly string[];
	/** Per-test flags the producer declared it recorded. */
	readonly recordedTestFlags: readonly string[];
};

export type WptInventory = {
	readonly entries: readonly WptInventoryEntry[];
	readonly summary: WptInventorySummary;
};

function deadlineFor(test: WptManifestTest, marginMs: number): number | null {
	const harness = harnessTimeoutMsOf(test);
	if (harness === null) return null;
	return harness + marginMs;
}

function incompletenessMarker(manifest: WptManifest): IncompletenessMarker {
	return {
		manifestIncomplete: manifest.incompleteness.length > 0,
		manifestIncompletenessReasons: manifest.incompleteness,
	};
}

function entryForTest(
	manifest: WptManifest,
	test: WptManifestTest,
	options: Required<Pick<WptInventoryOptions, "lanes" | "deadlineMarginMs">>
): WptInventoryEntry {
	const suite = wptSuiteId(manifest.suite);
	const reason = unsupportedReasonFor(test);
	const deadlineMs = deadlineFor(test, options.deadlineMarginMs);
	const variant = variantOf(test);
	return Object.freeze({
		testId: composeTestId(suite, encodeUpstreamUrl(test.url)) as TestId,
		suite,
		// Suite-local identity is the upstream URL itself, unmodified: the id is an
		// encoding of it, and this is the value a consumer matches against a
		// checkout. It is never a basename and never a title.
		localName: test.url,
		title: test.url,
		lanes: options.lanes,
		requiredCapabilities: reason === null ? EXECUTABLE_CAPABILITIES : Object.freeze([]),
		executable: reason === null,
		...(reason === null ? {} : { notRunReason: `${reason.code}: ${reason.detail}` }),
		...(reason === null && deadlineMs !== null ? { deadlineMs } : {}),
		meta: Object.freeze({
			...incompletenessMarker(manifest),
			executionMode: "wpt-testharness",
			verdict: "page",
			itemType: "testharness",
			upstreamUrl: test.url,
			upstreamSource: test.source,
			upstreamRevision: manifest.revision,
			https: test.https,
			subdomain: test.subdomain,
			// Tri-state, preserved: null means the producer did not record it.
			h2: test.h2,
			testdriver: test.testdriver,
			testdriverRequired: requiresTestDriver(test),
			timeoutClass: timeoutClassOf(test),
			harnessTimeoutMs: harnessTimeoutMsOf(test),
			...(variant === null ? {} : { variant }),
			...(reason === null ? {} : { unsupportedCode: reason.code }),
		}),
		upstreamUrl: test.url,
	});
}

/**
 * A non-testharness case: inventoried, never executed here.
 *
 * Some item types carry no URL at all (upstream records `url` only when the item
 * has one), so identity falls back to the source path plus the item's index. That
 * keeps the entry unique without inventing a URL the case does not have.
 */
function entryForOtherCase(
	manifest: WptManifest,
	other: WptOtherCase,
	item: WptOtherCaseItem,
	index: number,
	lanes: readonly LaneId[]
): WptInventoryEntry {
	const suite = wptSuiteId(manifest.suite);
	const identity = item.url ?? `${other.path}#item${index}`;
	const detail =
		`upstream's manifest records this case as item type ${JSON.stringify(item.type)}. ` +
		`This boundary implements ${SUPPORTED_KIND.description}, so the case is inventoried and ` +
		"not executed. It is retained in the denominator rather than dropped.";
	return Object.freeze({
		testId: composeTestId(suite, encodeUpstreamUrl(identity)) as TestId,
		suite,
		localName: identity,
		title: identity,
		lanes,
		requiredCapabilities: Object.freeze([]),
		executable: false,
		notRunReason: `item-type-unsupported: ${detail}`,
		meta: Object.freeze({
			...incompletenessMarker(manifest),
			executionMode: "wpt-inventory-only",
			verdict: "page",
			itemType: item.type,
			upstreamSource: other.path,
			upstreamRevision: manifest.revision,
			runnerSupportedType: other.runnerSupportedType,
			unsupportedCode: "item-type-unsupported",
			...(item.url === undefined ? {} : { upstreamUrl: item.url }),
			...(item.timeout === undefined ? {} : { upstreamTimeout: item.timeout }),
			...(item.references === undefined
				? {}
				: { references: item.references.map((pair) => [...pair]) }),
		}),
		upstreamUrl: item.url ?? identity,
	});
}

/**
 * Builds the inventory for one manifest.
 *
 * Duplicate ids are not resolved here: `buildInventory` in the core rejects them,
 * and it should — two entries claiming one id means the manifest described two
 * cases this build cannot tell apart, and picking one would hide the other.
 */
export function buildWptInventory(
	manifest: WptManifest,
	options: WptInventoryOptions = {}
): WptInventory {
	const lanes = Object.freeze([...(options.lanes ?? [BARE_LANE, SCRAMJET_LANE])]);
	if (lanes.length === 0) {
		throw new RangeError("a WPT inventory must be built for at least one lane");
	}
	const deadlineMarginMs = options.deadlineMarginMs ?? RUNNER_DEADLINE_MARGIN_MS;
	if (!Number.isInteger(deadlineMarginMs) || deadlineMarginMs < 0) {
		throw new RangeError("deadlineMarginMs must be a non-negative whole number of milliseconds");
	}

	const entries: WptInventoryEntry[] = [];
	const unsupportedByReason: Record<string, number> = {};
	let executable = 0;

	for (const test of manifest.tests) {
		const entry = entryForTest(manifest, test, { lanes, deadlineMarginMs });
		entries.push(entry);
		if (entry.executable) {
			executable += 1;
			continue;
		}
		const code = String(entry.meta?.unsupportedCode ?? "unknown");
		unsupportedByReason[code] = (unsupportedByReason[code] ?? 0) + 1;
	}

	let otherCount = 0;
	for (const other of manifest.otherCases) {
		for (const [index, item] of other.items.entries()) {
			entries.push(entryForOtherCase(manifest, other, item, index, lanes));
			otherCount += 1;
			unsupportedByReason["item-type-unsupported"] =
				(unsupportedByReason["item-type-unsupported"] ?? 0) + 1;
		}
	}

	return Object.freeze({
		entries: Object.freeze(entries),
		summary: Object.freeze({
			suite: manifest.suite,
			revision: manifest.revision,
			testharnessCases: manifest.tests.length,
			otherCases: otherCount,
			executable,
			retainedUnsupported: entries.length - executable,
			unsupportedByReason: Object.freeze(unsupportedByReason),
			supportFiles: manifest.provenance.supportFiles,
			duplicateTestUrls: manifest.provenance.duplicateTestUrls,
			droppedDuplicateCount: manifest.provenance.droppedDuplicateCount,
			manifestUnrecognizedFields: manifest.unrecognizedFields,
			unparsableSourceFileCount: manifest.provenance.unparsableSourceFileCount,
			allSelectedFilesParsed: manifest.provenance.allSelectedFilesParsed,
			incompleteness: manifest.incompleteness,
			recordedTestFlags: manifest.provenance.recordedTestFlags,
		}),
	});
}

/**
 * Builds the absolute URL for a case against a running server's origin.
 *
 * The origin comes from the launched fixture, read back from its listening socket;
 * the path comes from the manifest. Neither is derived from the other, and the
 * upstream URL is appended without re-encoding, because upstream already produced
 * a URL and normalizing it here would change the request the case asked for.
 */
export function caseUrl(origin: string, upstreamUrl: string): string {
	if (!upstreamUrl.startsWith("/")) {
		throw new RangeError(`an upstream URL must be server-absolute: ${upstreamUrl}`);
	}
	return `${origin.replace(/\/+$/, "")}${upstreamUrl}`;
}
