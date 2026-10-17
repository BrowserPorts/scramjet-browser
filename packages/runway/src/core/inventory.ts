/**
 * Inventory: the denominator.
 *
 * The inventory is built from suite adapters before anything executes, and it does
 * not change while a run proceeds. Comparison counts against the inventory, so a
 * test that never produced a record is reported `missing` rather than vanishing.
 */
import { RunwayError } from "./errors.ts";
import {
	arrayAt,
	assertOnlyKeys,
	booleanAt,
	enumAt,
	integerAt,
	jsonData,
	objectAt,
	optionalIntegerAt,
	optionalStringAt,
	plainObject,
	stringArrayAt,
	stringAt,
	type SchemaFail,
} from "./schema.ts";
import {
	contentHash,
	laneId as asLaneId,
	suiteId as asSuiteId,
	terminalKey,
	testId as asTestId,
	type LaneId,
	type SuiteId,
	type TestId,
} from "./ids.ts";

/** Capabilities a test needs from providers and from the runner. */
export const CAPABILITIES = {
	/** Runway's own local fixture server (harness pages, per-test servers). */
	localFixtures: "fixtures/local",
	/** An already running upstream wptserve with configured origins. */
	wptServer: "fixtures/wpt-server",
	/** A launched browser. */
	browser: "runner/browser",
	/** Direct Playwright control of pages by the test body. */
	playwrightControl: "runner/playwright-control",
	/** Runs in the Node process with no browser at all. */
	inProcess: "runner/in-process",
	/** Traffic must demonstrably take the candidate (proxy) route. */
	proxyRoute: "lane/proxy-route",
	/** An owner (plugin/candidate) must attest per test, correlated host-side. */
	ownerSignal: "lane/owner-signal",
	/** The candidate transport may dial non-loopback destinations. */
	remoteNetwork: "lane/remote-network",
	/** A real TLS origin backed by consumer-supplied certificate material. */
	fixtureTls: "fixtures/tls",
} as const;

export type CapabilityId = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

export type InventoryEntry = {
	readonly testId: TestId;
	readonly suite: SuiteId;
	/** Suite-local identifier, as the suite's own inventory names it. */
	readonly localName: string;
	readonly title: string;
	/** Lanes this test is defined for. Planning may narrow, never widen. */
	readonly lanes: readonly LaneId[];
	readonly requiredCapabilities: readonly CapabilityId[];
	/** Tests sharing a serial group never run concurrently. */
	readonly serialGroup?: string;
	readonly deadlineMs?: number;
	/**
	 * False for inventoried-but-never-executed forms (upstream manual cases).
	 * Such entries still count in the denominator and record `notRun`.
	 */
	readonly executable: boolean;
	/** Required when `executable` is false. */
	readonly notRunReason?: string;
	/** Suite-specific data the adapter needs at execution time. */
	readonly meta?: Readonly<Record<string, unknown>>;
};

export type Inventory = {
	readonly entries: readonly InventoryEntry[];
	readonly byId: ReadonlyMap<TestId, InventoryEntry>;
};

export type PlannedPair = {
	readonly testId: TestId;
	readonly laneId: LaneId;
};

/** Builds and validates an inventory. Duplicate test ids are a hard error. */
export function buildInventory(entries: readonly InventoryEntry[]): Inventory {
	const byId = new Map<TestId, InventoryEntry>();
	for (const entry of entries) {
		if (byId.has(entry.testId)) {
			throw new RunwayError(
				"suite/duplicate-test-id",
				`two inventory entries claim the test id ${entry.testId}`,
				{
					details: { testId: entry.testId, suite: entry.suite },
					remedy: "Rename one of the tests; test ids are the inventory's primary key.",
				}
			);
		}
		if (!entry.executable && !entry.notRunReason) {
			throw new RunwayError(
				"plan/invalid",
				`inventory entry ${entry.testId} is not executable but records no reason`,
				{ details: { testId: entry.testId } }
			);
		}
		if (entry.lanes.length === 0) {
			throw new RunwayError(
				"plan/invalid",
				`inventory entry ${entry.testId} declares no lanes`,
				{ details: { testId: entry.testId } }
			);
		}
		byId.set(entry.testId, Object.freeze({ ...entry }));
	}
	return Object.freeze({
		entries: Object.freeze([...byId.values()]),
		byId,
	});
}

/**
 * Expands the inventory into planned (test, lane) pairs.
 *
 * `lanes` narrows the selection; a lane a test does not declare is never added.
 */
export function planPairs(
	inventory: Inventory,
	lanes: readonly LaneId[]
): readonly PlannedPair[] {
	const selected = new Set<string>(lanes);
	const pairs: PlannedPair[] = [];
	for (const entry of inventory.entries) {
		for (const lane of entry.lanes) {
			if (!selected.has(lane)) continue;
			pairs.push(Object.freeze({ testId: entry.testId, laneId: lane }));
		}
	}
	return Object.freeze(pairs);
}

/**
 * The persisted form of one planned test.
 *
 * Only configuration is serialized. A suite adapter's executable parts (fixture
 * factories, page bodies, assertions) are closures and are deliberately absent:
 * the snapshot describes *what was planned*, and re-reading it must never be able
 * to run anything.
 */
export type PlannedTestSnapshot = {
	readonly testId: TestId;
	readonly suite: SuiteId;
	readonly localName: string;
	readonly title: string;
	/** Lanes actually planned for this test: the inventory narrowed by the plan. */
	readonly lanes: readonly LaneId[];
	readonly requiredCapabilities: readonly CapabilityId[];
	readonly executable: boolean;
	readonly notRunReason?: string;
	readonly serialGroup?: string;
	readonly deadlineMs?: number;
	/** Which channel is authoritative for this test's verdict. */
	readonly verdictSource: VerdictSource;
	/** Suite adapter's execution form, e.g. `in-page`, `page-control`, `node`. */
	readonly executionMode: string;
	/** Serializable suite/fixture configuration. Never executable. */
	readonly configuration: Readonly<Record<string, unknown>>;
};

export const VERDICT_SOURCES = ["page", "host", "playwright", "node"] as const;
export type VerdictSource = (typeof VERDICT_SOURCES)[number];

/**
 * The immutable denominator persisted with a run.
 *
 * `digest` is a canonical hash of the planned tests and pairs, and the plan hash
 * includes it, so a run's records are bound to this exact denominator. Comparison
 * reads the snapshot instead of re-discovering tests from source, which is what
 * makes an offline verdict reproducible after the suite has moved on.
 */
export type PlanInventorySnapshot = {
	readonly version: 1;
	readonly suites: readonly SuiteId[];
	readonly tests: readonly PlannedTestSnapshot[];
	readonly pairs: readonly PlannedPair[];
	readonly digest: string;
};

export const INVENTORY_SNAPSHOT_VERSION = 1 as const;

const VERDICT_SET: ReadonlySet<string> = new Set(VERDICT_SOURCES);

const snapshotInvalid: SchemaFail = (message, details) => {
	throw new RunwayError("plan/invalid", message, {
		details,
		remedy:
			"A plan's inventory snapshot is written once by `runway run`. Do not hand-edit " +
			"plan.json; create a new run instead.",
	});
};

/**
 * Reads an identifier through the constructor that mints it.
 *
 * Deliberately not `String(value)`: coercion would turn `[["runner/browser"]]`
 * into a plausible-looking id and let an edited snapshot describe a denominator
 * the run never had — while still matching the recorded digest, because the digest
 * is computed *after* normalization. The shape is therefore checked first.
 */
function snapshotId<T extends string>(
	value: unknown,
	make: (raw: string) => T,
	field: string,
	context: string
): T {
	if (typeof value !== "string" || value.length === 0) {
		snapshotInvalid(`${context}.${field} must be a non-empty string`, {
			context,
			field,
			kind: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
		});
	}
	try {
		return make(value);
	} catch (cause) {
		return snapshotInvalid(`${context}.${field} is not a valid identifier`, {
			context,
			field,
			value,
			reason: cause instanceof Error ? cause.message : String(cause),
		});
	}
}

const SNAPSHOT_KEYS = ["version", "suites", "tests", "pairs", "digest"] as const;
const SNAPSHOT_TEST_KEYS = [
	"testId",
	"suite",
	"localName",
	"title",
	"lanes",
	"requiredCapabilities",
	"executable",
	"notRunReason",
	"serialGroup",
	"deadlineMs",
	"verdictSource",
	"executionMode",
	"configuration",
] as const;
const SNAPSHOT_PAIR_KEYS = ["testId", "laneId"] as const;

/**
 * Deep-copies suite metadata, refusing anything that is not plain JSON data.
 *
 * A function, symbol or class instance in metadata means an adapter tried to
 * persist executable state. That is rejected here rather than silently dropped,
 * because a snapshot that quietly loses part of a test's identity is worse than
 * no snapshot.
 */
export function serializableConfiguration(
	testId: TestId,
	meta: Readonly<Record<string, unknown>> | undefined
): Readonly<Record<string, unknown>> {
	if (!meta) return Object.freeze({});
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(meta)) {
		if (value === undefined) continue;
		// `verdict` and `executionMode` are promoted to their own snapshot fields.
		if (key === "verdict" || key === "executionMode") continue;
		result[key] = jsonData(snapshotInvalid, value, `the metadata of ${testId} at ${key}`);
	}
	return Object.freeze(result);
}

/** The suite adapter's execution form. Declared, never guessed. */
function executionModeFor(entry: InventoryEntry): string {
	const declared = entry.meta?.executionMode;
	if (typeof declared === "string" && declared.length > 0) return declared;
	return snapshotInvalid(
		`the inventory entry ${entry.testId} declares no execution mode`,
		{ testId: entry.testId, executionMode: typeof declared === "string" ? declared : null }
	);
}

function verdictSourceFor(entry: InventoryEntry): VerdictSource {
	const declared = entry.meta?.verdict;
	if (typeof declared === "string" && VERDICT_SET.has(declared)) {
		return declared as VerdictSource;
	}
	snapshotInvalid(
		`the inventory entry ${entry.testId} declares no verdict source`,
		{ testId: entry.testId, verdict: declared ?? null, known: VERDICT_SOURCES }
	);
}

/** Canonical digest of the planned denominator. Included in the plan hash. */
export function inventorySnapshotDigest(
	tests: readonly PlannedTestSnapshot[],
	pairs: readonly PlannedPair[],
	suites: readonly SuiteId[]
): string {
	return contentHash({
		version: INVENTORY_SNAPSHOT_VERSION,
		suites: [...suites].sort(),
		tests: [...tests].sort((a, b) => (a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0)),
		pairs: [...pairs.map((pair) => terminalKey(pair.testId, pair.laneId))].sort(),
	});
}

/** Freezes the planned inventory and pairs into the form persisted with the run. */
export function createInventorySnapshot(options: {
	readonly inventory: Inventory;
	readonly pairs: readonly PlannedPair[];
	readonly suites: readonly SuiteId[];
}): PlanInventorySnapshot {
	const tests: PlannedTestSnapshot[] = [];
	const plannedLanes = new Map<TestId, Set<LaneId>>();
	for (const pair of options.pairs) {
		const lanes = plannedLanes.get(pair.testId) ?? new Set<LaneId>();
		lanes.add(pair.laneId);
		plannedLanes.set(pair.testId, lanes);
	}
	for (const entry of options.inventory.entries) {
		const lanes = plannedLanes.get(entry.testId);
		if (!lanes || lanes.size === 0) continue;
		tests.push(
			Object.freeze({
				testId: entry.testId,
				suite: entry.suite,
				localName: entry.localName,
				title: entry.title,
				lanes: Object.freeze(entry.lanes.filter((lane) => lanes.has(lane))),
				requiredCapabilities: Object.freeze([...entry.requiredCapabilities]),
				executable: entry.executable,
				...(entry.notRunReason ? { notRunReason: entry.notRunReason } : {}),
				...(entry.serialGroup ? { serialGroup: entry.serialGroup } : {}),
				...(entry.deadlineMs === undefined ? {} : { deadlineMs: entry.deadlineMs }),
				verdictSource: verdictSourceFor(entry),
				executionMode: executionModeFor(entry),
				configuration: serializableConfiguration(entry.testId, entry.meta),
			})
		);
	}
	const pairs = Object.freeze(
		[...options.pairs]
			.map((pair) => Object.freeze({ testId: pair.testId, laneId: pair.laneId }))
			.sort((a, b) => {
				const left = terminalKey(a.testId, a.laneId);
				const right = terminalKey(b.testId, b.laneId);
				return left < right ? -1 : left > right ? 1 : 0;
			})
	);
	const suites = Object.freeze([...new Set(options.suites)]);
	const frozenTests = Object.freeze(tests);
	return Object.freeze({
		version: INVENTORY_SNAPSHOT_VERSION,
		suites,
		tests: frozenTests,
		pairs,
		digest: inventorySnapshotDigest(frozenTests, pairs, suites),
	});
}

/**
 * Validates an untrusted snapshot read back from a saved plan.
 *
 * Structure first, digest second. Every field must already be the type the
 * contract declares — arrays stay arrays, objects stay objects, ids are minted by
 * the id constructors, and a key this version does not declare is refused — before
 * anything is canonicalized. The digest is then recomputed, so an edited
 * denominator cannot pass itself off as the one a set of records was produced
 * against; but the digest is a consistency check, never a substitute for
 * validating the shape.
 */
export function validateInventorySnapshot(
	value: unknown,
	options: { readonly knownLanes?: readonly LaneId[] } = {}
): PlanInventorySnapshot {
	const raw = plainObject(snapshotInvalid, value, "the plan's inventory snapshot");
	assertOnlyKeys(snapshotInvalid, raw, SNAPSHOT_KEYS, "the inventory snapshot");
	if (raw.version !== INVENTORY_SNAPSHOT_VERSION) {
		snapshotInvalid(
			`the inventory snapshot uses version ${JSON.stringify(raw.version)}, this build reads ${INVENTORY_SNAPSHOT_VERSION}`,
			{ version: typeof raw.version === "number" ? raw.version : null }
		);
	}
	const digest = stringAt(snapshotInvalid, raw, "digest", "the inventory snapshot");
	const knownLanes = options.knownLanes ? new Set<string>(options.knownLanes) : null;
	const suites = arrayAt(snapshotInvalid, raw, "suites", "the inventory snapshot").map((suite, index) =>
		snapshotId(suite, asSuiteId, `suites[${index}]`, "the inventory snapshot")
	);

	const tests: PlannedTestSnapshot[] = [];
	const byId = new Map<TestId, PlannedTestSnapshot>();
	for (const [index, item] of arrayAt(
		snapshotInvalid,
		raw,
		"tests",
		"the inventory snapshot"
	).entries()) {
		const context = `the inventory snapshot entry tests[${index}]`;
		const entry = plainObject(snapshotInvalid, item, context);
		assertOnlyKeys(snapshotInvalid, entry, SNAPSHOT_TEST_KEYS, context);
		const id = snapshotId(entry.testId, asTestId, "testId", context);
		if (byId.has(id)) {
			snapshotInvalid(`the inventory snapshot lists ${id} twice`, { testId: id });
		}
		const laneValues = arrayAt(snapshotInvalid, entry, "lanes", context);
		if (laneValues.length === 0) {
			snapshotInvalid(`the snapshot entry ${id} declares no lanes`, { testId: id });
		}
		const lanes = laneValues.map((lane, laneIndex) =>
			snapshotId(lane, asLaneId, `lanes[${laneIndex}]`, context)
		);
		if (new Set<string>(lanes).size !== lanes.length) {
			snapshotInvalid(`the snapshot entry ${id} lists a lane twice`, { testId: id, lanes });
		}
		for (const lane of lanes) {
			if (knownLanes && !knownLanes.has(lane)) {
				snapshotInvalid(
					`the snapshot entry ${id} names the lane ${lane}, which this plan does not run`,
					{ testId: id, lane, knownLanes: [...knownLanes] }
				);
			}
		}
		const capabilities = stringArrayAt(snapshotInvalid, entry, "requiredCapabilities", context);
		const executable = booleanAt(snapshotInvalid, entry, "executable", context);
		const notRunReason = optionalStringAt(snapshotInvalid, entry, "notRunReason", context);
		if (!executable && notRunReason === undefined) {
			snapshotInvalid(`the snapshot entry ${id} is not executable but records no reason`, {
				testId: id,
			});
		}
		const serialGroup = optionalStringAt(snapshotInvalid, entry, "serialGroup", context);
		const deadlineMs = optionalIntegerAt(snapshotInvalid, entry, "deadlineMs", context, { min: 1 });
		const snapshot: PlannedTestSnapshot = Object.freeze({
			testId: id,
			suite: snapshotId(entry.suite, asSuiteId, "suite", context),
			localName: stringAt(snapshotInvalid, entry, "localName", context),
			title: stringAt(snapshotInvalid, entry, "title", context),
			lanes: Object.freeze(lanes),
			requiredCapabilities: Object.freeze([...capabilities] as CapabilityId[]),
			executable,
			...(notRunReason === undefined ? {} : { notRunReason }),
			...(serialGroup === undefined ? {} : { serialGroup }),
			...(deadlineMs === undefined ? {} : { deadlineMs }),
			verdictSource: enumAt(snapshotInvalid, entry, "verdictSource", context, VERDICT_SOURCES),
			executionMode: stringAt(snapshotInvalid, entry, "executionMode", context),
			// Configuration is validated as data, not normalized into data: an array
			// is not an empty object, and a class instance is not configuration.
			configuration: jsonData(
				snapshotInvalid,
				objectAt(snapshotInvalid, entry, "configuration", context),
				`${context}.configuration`
			) as Readonly<Record<string, unknown>>,
		});
		byId.set(id, snapshot);
		tests.push(snapshot);
	}

	const pairs: PlannedPair[] = [];
	const seenPairs = new Set<string>();
	for (const [index, item] of arrayAt(
		snapshotInvalid,
		raw,
		"pairs",
		"the inventory snapshot"
	).entries()) {
		const context = `the inventory snapshot pair pairs[${index}]`;
		const pair = plainObject(snapshotInvalid, item, context);
		assertOnlyKeys(snapshotInvalid, pair, SNAPSHOT_PAIR_KEYS, context);
		const test = snapshotId(pair.testId, asTestId, "testId", context);
		const lane = snapshotId(pair.laneId, asLaneId, "laneId", context);
		const key = terminalKey(test, lane);
		if (seenPairs.has(key)) {
			snapshotInvalid(`the inventory snapshot plans ${test} on ${lane} twice`, {
				testId: test,
				laneId: lane,
			});
		}
		const entry = byId.get(test);
		if (!entry) {
			snapshotInvalid(
				`the inventory snapshot plans ${test}, which is not one of its tests`,
				{ testId: test, laneId: lane }
			);
		}
		if (!entry.lanes.includes(lane)) {
			snapshotInvalid(
				`the inventory snapshot plans ${test} on ${lane}, a lane that test does not declare`,
				{ testId: test, laneId: lane, declared: entry.lanes }
			);
		}
		seenPairs.add(key);
		pairs.push(Object.freeze({ testId: test, laneId: lane }));
	}
	for (const entry of tests) {
		for (const lane of entry.lanes) {
			if (!seenPairs.has(terminalKey(entry.testId, lane))) {
				snapshotInvalid(
					`the inventory snapshot declares ${entry.testId} on ${lane} but plans no such pair`,
					{ testId: entry.testId, laneId: lane }
				);
			}
		}
	}

	const frozenTests = Object.freeze(tests);
	const frozenPairs = Object.freeze(pairs);
	const frozenSuites = Object.freeze(suites);
	const recomputed = inventorySnapshotDigest(frozenTests, frozenPairs, frozenSuites);
	if (recomputed !== digest) {
		throw new RunwayError(
			"plan/hash-mismatch",
			"the inventory snapshot's digest does not match its contents",
			{
				details: { recorded: digest, recomputed },
				remedy: "Do not hand-edit a saved plan; the denominator is part of the plan hash.",
			}
		);
	}
	return Object.freeze({
		version: INVENTORY_SNAPSHOT_VERSION,
		suites: frozenSuites,
		tests: frozenTests,
		pairs: frozenPairs,
		digest: recomputed,
	});
}

/**
 * Rebuilds the comparison-side inventory from a persisted snapshot.
 *
 * This is the offline path: no suite module is imported, nothing is discovered
 * from source, and the entries carry exactly the identity, requirements and
 * verdict source the run was planned with.
 */
export function inventoryFromSnapshot(snapshot: PlanInventorySnapshot): Inventory {
	return buildInventory(
		snapshot.tests.map((test) => ({
			testId: test.testId,
			suite: test.suite,
			localName: test.localName,
			title: test.title,
			lanes: test.lanes,
			requiredCapabilities: test.requiredCapabilities,
			executable: test.executable,
			...(test.notRunReason ? { notRunReason: test.notRunReason } : {}),
			...(test.serialGroup ? { serialGroup: test.serialGroup } : {}),
			...(test.deadlineMs === undefined ? {} : { deadlineMs: test.deadlineMs }),
			meta: Object.freeze({
				...test.configuration,
				verdict: test.verdictSource,
				executionMode: test.executionMode,
			}),
		}))
	);
}

/** Filters entries by substring match on the test id or title. */
export function filterEntries(
	entries: readonly InventoryEntry[],
	filters: readonly string[]
): readonly InventoryEntry[] {
	if (filters.length === 0) return entries;
	return entries.filter((entry) =>
		filters.some(
			(filter) =>
				entry.testId.includes(filter) ||
				entry.localName.includes(filter) ||
				entry.title.includes(filter)
		)
	);
}
