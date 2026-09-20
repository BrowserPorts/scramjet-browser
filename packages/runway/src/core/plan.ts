/**
 * The resolved, immutable run plan.
 *
 * Everything a run needs is decided once, here, from already-validated inputs.
 * Nothing downstream reads the environment or mutates configuration.
 *
 * A plan has two halves. The *configuration* is what the consumer asked for and
 * can be resolved without importing a single test module. The *inventory
 * snapshot* is the denominator that configuration expanded to, captured before
 * anything executed. The plan hash covers both, and the plan is saved with its
 * run, so comparison can rebuild the exact denominator from the run directory
 * instead of re-discovering tests from a source tree that has since moved on.
 */
import { readFile, writeFile } from "node:fs/promises";
import { RunwayError } from "./errors.ts";
import {
	contentHash,
	laneId as asLaneId,
	runId as asRunId,
	suiteId as asSuiteId,
	type LaneId,
	type RunId,
	type SuiteId,
} from "./ids.ts";
import {
	validateInventorySnapshot,
	type PlanInventorySnapshot,
} from "./inventory.ts";
import { PROTOCOL_VERSION, type ProtocolVersion } from "./protocol.ts";
import {
	arrayAt,
	assertOnlyKeys,
	booleanAt,
	enumAt,
	integerAt,
	nullableStringAt,
	objectAt,
	plainObject,
	stringArrayAt,
	stringAt,
	timestampAt,
	type SchemaFail,
} from "./schema.ts";

export type BrowserSelectionPlan = {
	readonly kind: "executable" | "channel" | "bundled";
	/** Absolute path, channel name, or null for the bundled download. */
	readonly selector: string | null;
	/** True only when the consumer named the binary or channel. */
	readonly explicitlySelected: boolean;
};

export type BrowserPlan = {
	readonly selection: BrowserSelectionPlan;
	readonly headless: boolean;
	/** Launch arguments, fully resolved. Empty unless a capability required one. */
	readonly args: readonly string[];
	/**
	 * Diagnostic mode disables certificate verification. Results produced under
	 * it can never be counted as verified.
	 */
	readonly insecureDiagnostics: boolean;
};

export type LanePlan = {
	readonly laneId: LaneId;
	readonly adapter: "bare" | "scramjet";
	readonly role: "reference" | "candidate";
	/** External plugin profile manifest, resolved to an absolute path. */
	readonly pluginManifestPath: string | null;
};

export type LocalFixturePlan = {
	readonly scramjetDist: string;
	readonly controllerDist: string;
	readonly libcurlDist: string;
	/** Requested ports; 0 means "ask the OS". Actual ports are recorded at run time. */
	readonly requestedHarnessPort: number;
	readonly requestedWispPort: number;
	readonly requestedBarePort: number;
};

/**
 * Diagnostic collection.
 *
 * Diagnostics add artifacts to a run; they never change a verdict. Coverage is
 * recorded as raw V8 data so the evidence is the browser's own output rather than a
 * derived report.
 */
export type DiagnosticsPlan = {
	readonly collectCoverage: boolean;
	readonly traceConsole: boolean;
};

export type SchedulePlan = {
	readonly concurrency: number;
	readonly defaultDeadlineMs: number;
	readonly setupDeadlineMs: number;
};

export type OutputPlan = {
	/** Consumer-owned root. Never inside the installed package. */
	readonly root: string;
	readonly runDirectory: string;
};

export type SuiteSelection = {
	readonly suite: SuiteId;
	readonly filters: readonly string[];
};

/**
 * Inputs the WPT suite needs, resolved but not yet read.
 *
 * The manifest is deliberately *not* parsed during resolution. A missing or
 * malformed manifest has to become a recorded setup failure inside the run's own
 * accounted boundary — one outcome per planned pair — rather than an exception
 * thrown before the run directory, plan.json or any record exists.
 */
export type WptPlan = {
	readonly manifestPath: string;
	/** Diagnosis only. Never widens what may execute. */
	readonly allowIncomplete: boolean;
	/** Upstream checkout for the fixture server, when one was supplied. */
	readonly wptRoot: string | null;
	/** wptserve config the caller owns, when one was supplied. */
	readonly serverConfigPath: string | null;
};

/** What the consumer asked for, before any test module has been imported. */
export type RunConfigurationDraft = {
	readonly runId: RunId;
	readonly createdAt: string;
	readonly browser: BrowserPlan;
	readonly lanes: readonly LanePlan[];
	readonly suites: readonly SuiteSelection[];
	/**
	 * Present only when the `wpt` suite was selected.
	 *
	 * Optional on the draft, and normalized to `null` by `createRunConfiguration`:
	 * additive, so every existing caller that never heard of WPT keeps compiling and
	 * keeps producing exactly the configuration it did before.
	 */
	readonly wpt?: WptPlan | null;
	readonly localFixtures: LocalFixturePlan;
	readonly schedule: SchedulePlan;
	readonly diagnostics: DiagnosticsPlan;
	readonly output: OutputPlan;
	/** Expectations are a comparison input, never part of raw evidence. */
	readonly expectationsPath: string | null;
};

export type RunConfiguration = Omit<RunConfigurationDraft, "wpt"> & {
	/** Always present on a resolved configuration; `null` when no WPT was selected. */
	readonly wpt: WptPlan | null;
	readonly protocolVersion: ProtocolVersion;
	/**
	 * False when anything about this configuration disqualifies it as conformance
	 * evidence (unselected browser, diagnostics mode). The reason list is kept.
	 */
	readonly conformanceEligible: boolean;
	readonly ineligibilityReasons: readonly string[];
};

export type RunPlan = RunConfiguration & {
	/** Hash of the configuration and the inventory digest. Not of `runId`/`createdAt`. */
	readonly planHash: string;
	/** The frozen denominator this run was planned against. */
	readonly inventory: PlanInventorySnapshot;
};

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const item of Object.values(value as Record<string, unknown>)) {
			deepFreeze(item);
		}
	}
	return value;
}

/** Derives the reasons a plan cannot produce conformance evidence. */
export function ineligibilityReasons(draft: RunConfigurationDraft): readonly string[] {
	const reasons: string[] = [];
	if (!draft.browser.selection.explicitlySelected) {
		reasons.push(
			"no browser was explicitly selected; the bundled download was used, " +
				"which records what ran but is not selection proof"
		);
	}
	if (draft.browser.insecureDiagnostics) {
		reasons.push(
			"insecure diagnostics mode disables certificate verification, so no " +
				"result from this run is verified"
		);
	}
	return reasons;
}

/** Completes a draft into an immutable configuration. Imports nothing. */
export function createRunConfiguration(draft: RunConfigurationDraft): RunConfiguration {
	if (draft.lanes.length === 0) {
		throw new RunwayError("plan/invalid", "a run plan needs at least one lane", {
			remedy: "Pass --lanes bare,scramjet (or a subset).",
		});
	}
	const laneIds = new Set(draft.lanes.map((lane) => lane.laneId));
	if (laneIds.size !== draft.lanes.length) {
		throw new RunwayError("plan/invalid", "duplicate lane ids in the plan", {
			details: { lanes: draft.lanes.map((lane) => lane.laneId) },
		});
	}
	if (draft.schedule.concurrency < 1) {
		throw new RunwayError("plan/invalid", "concurrency must be at least 1", {
			details: { concurrency: draft.schedule.concurrency },
		});
	}
	const reasons = ineligibilityReasons(draft);
	return deepFreeze({
		...draft,
		// Normalized once, here, so no consumer below this line has to distinguish
		// "absent" from "no WPT selection".
		wpt: draft.wpt ?? null,
		protocolVersion: PROTOCOL_VERSION,
		conformanceEligible: reasons.length === 0,
		ineligibilityReasons: reasons,
	});
}

/** The canonical hash input: configuration plus the denominator's digest. */
function planHashInput(
	configuration: RunConfiguration,
	inventoryDigest: string
): Readonly<Record<string, unknown>> {
	return {
		protocolVersion: PROTOCOL_VERSION,
		browser: configuration.browser,
		lanes: configuration.lanes,
		suites: configuration.suites,
		localFixtures: configuration.localFixtures,
		schedule: configuration.schedule,
		diagnostics: configuration.diagnostics,
		expectationsPath: configuration.expectationsPath,
		inventoryDigest,
	};
}

/** Hash a configuration would produce for a given denominator. */
export function planHashFor(
	configuration: RunConfiguration,
	inventoryDigest: string
): string {
	return contentHash(planHashInput(configuration, inventoryDigest));
}

/**
 * Binds a configuration to the denominator it expanded to.
 *
 * The result is the object records are written against: every terminal record
 * carries this `runId` and `planHash`, and comparison refuses records that carry
 * anything else.
 */
export function createRunPlan(
	configuration: RunConfiguration,
	/**
	 * Untyped on purpose: this is a validating boundary. The snapshot may come
	 * from a file this process did not write, so it is checked structurally here
	 * rather than trusted because a caller asserted its type.
	 */
	inventory: unknown
): RunPlan {
	const snapshot = validateInventorySnapshot(inventory, {
		knownLanes: configuration.lanes.map((lane) => lane.laneId),
	});
	return deepFreeze({
		...configuration,
		planHash: planHashFor(configuration, snapshot.digest),
		inventory: snapshot,
	});
}

/** Writes the plan next to its run, for reproduction and offline comparison. */
export async function savePlan(file: string, plan: RunPlan): Promise<void> {
	await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

const PLAN_KEYS = [
	"protocolVersion",
	"runId",
	"createdAt",
	"browser",
	"lanes",
	"suites",
	"wpt",
	"localFixtures",
	"schedule",
	"diagnostics",
	"output",
	"expectationsPath",
	"conformanceEligible",
	"ineligibilityReasons",
	"planHash",
	"inventory",
] as const;

/**
 * Validates a saved configuration field by field.
 *
 * A saved plan is untrusted input: it decides which browser is launched, which
 * directories are served and which ports are bound, so every value is checked
 * against its declared type instead of being cast. Nothing is coerced — a port is
 * an integer in range, not `"8080"`; `headless` is a boolean, not a truthy string;
 * a lane adapter is one of the adapters this build implements — and a key this
 * contract does not declare is refused rather than carried along.
 */
function validateSavedConfiguration(
	raw: Record<string, unknown>,
	fail: SchemaFail
): RunConfigurationDraft {
	const browserRaw = objectAt(fail, raw, "browser", "the saved plan");
	assertOnlyKeys(
		fail,
		browserRaw,
		["selection", "headless", "args", "insecureDiagnostics"],
		"the saved plan's browser"
	);
	const selectionRaw = objectAt(fail, browserRaw, "selection", "the saved plan's browser");
	assertOnlyKeys(
		fail,
		selectionRaw,
		["kind", "selector", "explicitlySelected"],
		"the saved plan's browser selection"
	);
	const browser: BrowserPlan = {
		selection: {
			kind: enumAt(fail, selectionRaw, "kind", "the saved plan's browser selection", [
				"executable",
				"channel",
				"bundled",
			] as const),
			selector: nullableStringAt(
				fail,
				selectionRaw,
				"selector",
				"the saved plan's browser selection"
			),
			explicitlySelected: booleanAt(
				fail,
				selectionRaw,
				"explicitlySelected",
				"the saved plan's browser selection"
			),
		},
		headless: booleanAt(fail, browserRaw, "headless", "the saved plan's browser"),
		args: stringArrayAt(fail, browserRaw, "args", "the saved plan's browser"),
		insecureDiagnostics: booleanAt(
			fail,
			browserRaw,
			"insecureDiagnostics",
			"the saved plan's browser"
		),
	};

	const lanes = arrayAt(fail, raw, "lanes", "the saved plan").map((item, index) => {
		const context = `the saved plan's lanes[${index}]`;
		const lane = plainObject(fail, item, context);
		assertOnlyKeys(fail, lane, ["laneId", "adapter", "role", "pluginManifestPath"], context);
		return {
			laneId: planId(fail, lane.laneId, asLaneId, "laneId", context),
			adapter: enumAt(fail, lane, "adapter", context, ["bare", "scramjet"] as const),
			role: enumAt(fail, lane, "role", context, ["reference", "candidate"] as const),
			pluginManifestPath: nullableStringAt(fail, lane, "pluginManifestPath", context),
		} satisfies LanePlan;
	});

	const suites = arrayAt(fail, raw, "suites", "the saved plan").map((item, index) => {
		const context = `the saved plan's suites[${index}]`;
		const suite = plainObject(fail, item, context);
		assertOnlyKeys(fail, suite, ["suite", "filters"], context);
		return {
			suite: planId(fail, suite.suite, asSuiteId, "suite", context),
			filters: stringArrayAt(fail, suite, "filters", context),
		} satisfies SuiteSelection;
	});

	const fixturesRaw = objectAt(fail, raw, "localFixtures", "the saved plan");
	assertOnlyKeys(
		fail,
		fixturesRaw,
		[
			"scramjetDist",
			"controllerDist",
			"libcurlDist",
			"requestedHarnessPort",
			"requestedWispPort",
			"requestedBarePort",
		],
		"the saved plan's localFixtures"
	);
	const port = (key: string): number =>
		integerAt(fail, fixturesRaw, key, "the saved plan's localFixtures", { min: 0, max: 65535 });
	const localFixtures: LocalFixturePlan = {
		scramjetDist: stringAt(fail, fixturesRaw, "scramjetDist", "the saved plan's localFixtures"),
		controllerDist: stringAt(fail, fixturesRaw, "controllerDist", "the saved plan's localFixtures"),
		libcurlDist: stringAt(fail, fixturesRaw, "libcurlDist", "the saved plan's localFixtures"),
		requestedHarnessPort: port("requestedHarnessPort"),
		requestedWispPort: port("requestedWispPort"),
		requestedBarePort: port("requestedBarePort"),
	};

	const scheduleRaw = objectAt(fail, raw, "schedule", "the saved plan");
	assertOnlyKeys(
		fail,
		scheduleRaw,
		["concurrency", "defaultDeadlineMs", "setupDeadlineMs"],
		"the saved plan's schedule"
	);
	const schedule: SchedulePlan = {
		concurrency: integerAt(fail, scheduleRaw, "concurrency", "the saved plan's schedule", {
			min: 1,
			max: 1024,
		}),
		defaultDeadlineMs: integerAt(
			fail,
			scheduleRaw,
			"defaultDeadlineMs",
			"the saved plan's schedule",
			{ min: 1 }
		),
		setupDeadlineMs: integerAt(fail, scheduleRaw, "setupDeadlineMs", "the saved plan's schedule", {
			min: 1,
		}),
	};

	const diagnosticsRaw = objectAt(fail, raw, "diagnostics", "the saved plan");
	assertOnlyKeys(
		fail,
		diagnosticsRaw,
		["collectCoverage", "traceConsole"],
		"the saved plan's diagnostics"
	);
	const diagnostics: DiagnosticsPlan = {
		collectCoverage: booleanAt(
			fail,
			diagnosticsRaw,
			"collectCoverage",
			"the saved plan's diagnostics"
		),
		traceConsole: booleanAt(fail, diagnosticsRaw, "traceConsole", "the saved plan's diagnostics"),
	};

	const outputRaw = objectAt(fail, raw, "output", "the saved plan");
	assertOnlyKeys(fail, outputRaw, ["root", "runDirectory"], "the saved plan's output");
	const output: OutputPlan = {
		root: stringAt(fail, outputRaw, "root", "the saved plan's output"),
		runDirectory: stringAt(fail, outputRaw, "runDirectory", "the saved plan's output"),
	};

	/*
	 * `wpt` is optional so a plan saved before the suite existed still loads: an
	 * absent block means "no WPT selection", which is exactly what those plans
	 * describe. Replay of such a plan is byte-identical to what it always was.
	 */
	let wpt: WptPlan | null = null;
	if (raw.wpt !== undefined && raw.wpt !== null) {
		const wptRaw = objectAt(fail, raw, "wpt", "the saved plan");
		assertOnlyKeys(
			fail,
			wptRaw,
			["manifestPath", "allowIncomplete", "wptRoot", "serverConfigPath"],
			"the saved plan's wpt block"
		);
		wpt = {
			manifestPath: stringAt(fail, wptRaw, "manifestPath", "the saved plan's wpt block"),
			allowIncomplete: booleanAt(fail, wptRaw, "allowIncomplete", "the saved plan's wpt block"),
			wptRoot: nullableStringAt(fail, wptRaw, "wptRoot", "the saved plan's wpt block"),
			serverConfigPath: nullableStringAt(
				fail,
				wptRaw,
				"serverConfigPath",
				"the saved plan's wpt block"
			),
		};
	}

	return {
		runId: planId(fail, raw.runId, asRunId, "runId", "the saved plan"),
		createdAt: timestampAt(fail, raw, "createdAt", "the saved plan"),
		browser,
		lanes,
		suites,
		wpt,
		localFixtures,
		schedule,
		diagnostics,
		output,
		expectationsPath: nullableStringAt(fail, raw, "expectationsPath", "the saved plan"),
	};
}

/** Reads an identifier through its constructor rather than coercing it. */
function planId<T extends string>(
	fail: SchemaFail,
	value: unknown,
	make: (raw: string) => T,
	field: string,
	context: string
): T {
	if (typeof value !== "string" || value.length === 0) {
		fail(`${context}.${field} must be a non-empty string`, {
			context,
			field,
			kind: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
		});
	}
	try {
		return make(value);
	} catch (cause) {
		return fail(`${context}.${field} is not a valid identifier`, {
			context,
			field,
			value,
			reason: cause instanceof Error ? cause.message : String(cause),
		});
	}
}

/**
 * Loads a saved plan and re-verifies it end to end.
 *
 * Three independent checks, in order: the saved configuration is validated field
 * by field, the inventory snapshot is re-validated and its digest recomputed, and
 * the plan hash is recomputed from the result. The hash is the last of the three,
 * never a stand-in for the first two — a document that hashes correctly but
 * describes something this build cannot interpret is still refused.
 */
export async function loadPlan(file: string): Promise<RunPlan> {
	const invalid: SchemaFail = (message, details) => {
		throw new RunwayError("plan/invalid", message, {
			details: { file, ...details },
			remedy: "Do not hand-edit a saved plan; create a new run instead.",
		});
	};
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch (cause) {
		throw new RunwayError("plan/invalid", `the saved plan ${file} could not be read as JSON`, {
			details: { file },
			cause,
		});
	}
	const raw = plainObject(invalid, parsed, `the saved plan ${file}`);
	assertOnlyKeys(invalid, raw, PLAN_KEYS, `the saved plan ${file}`);
	if (raw.protocolVersion !== PROTOCOL_VERSION) {
		throw new RunwayError(
			"record/protocol-mismatch",
			`saved plan uses protocol ${JSON.stringify(raw.protocolVersion)}, this build reads ${PROTOCOL_VERSION}`,
			{ details: { file } }
		);
	}
	const recordedHash = stringAt(invalid, raw, "planHash", `the saved plan ${file}`);
	const recordedEligible = booleanAt(invalid, raw, "conformanceEligible", `the saved plan ${file}`);
	const recordedReasons = stringArrayAt(
		invalid,
		raw,
		"ineligibilityReasons",
		`the saved plan ${file}`
	);
	const configuration = createRunConfiguration(validateSavedConfiguration(raw, invalid));
	if (
		configuration.conformanceEligible !== recordedEligible ||
		configuration.ineligibilityReasons.join("\n") !== recordedReasons.join("\n")
	) {
		throw new RunwayError(
			"plan/hash-mismatch",
			"the saved plan's conformance eligibility does not follow from its contents",
			{
				details: {
					file,
					recorded: recordedEligible,
					recordedReasons,
					recomputed: configuration.conformanceEligible,
					recomputedReasons: configuration.ineligibilityReasons,
				},
				remedy: "Do not hand-edit a saved plan; create a new run instead.",
			}
		);
	}
	const recomputed = createRunPlan(configuration, raw.inventory);
	if (recomputed.planHash !== recordedHash) {
		throw new RunwayError(
			"plan/hash-mismatch",
			"the saved plan's hash does not match its contents",
			{
				details: { file, recorded: recordedHash, recomputed: recomputed.planHash },
				remedy: "Do not hand-edit a saved plan; create a new run instead.",
			}
		);
	}
	return recomputed;
}
