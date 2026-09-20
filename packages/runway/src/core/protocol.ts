/**
 * Versioned record protocol.
 *
 * The recorder writes these shapes and nothing else. Comparison, reporters and
 * any external consumer read them back. Adding a field is allowed; changing the
 * meaning of one requires a new `PROTOCOL_VERSION`.
 */
import { RunwayError, type SerializedRunwayError } from "./errors.ts";
import { isTerminalOutcome, TERMINAL_OUTCOMES, type TerminalOutcome } from "./outcome.ts";
import {
	laneId as asLaneId,
	runId as asRunId,
	testId as asTestId,
	type LaneId,
	type RunId,
	type TestId,
} from "./ids.ts";
import {
	arrayAt,
	finiteNumberAt,
	assertOnlyKeys,
	booleanAt,
	enumAt,
	integerAt,
	jsonData,
	nullableStringAt,
	nullableTextAt,
	objectAt,
	optionalArrayAt,
	optionalIntegerAt,
	optionalStringAt,
	plainObject,
	stringArrayAt,
	stringAt,
	stringRecordAt,
	timestampAt,
	type SchemaFail,
} from "./schema.ts";

export const PROTOCOL_VERSION = "runway.v2" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** How the browser binary was chosen. `bundled` is never selection proof. */
export type BrowserSelectionKind = "executable" | "channel" | "bundled";

export type BrowserProvenance = {
	/** Playwright browser type, e.g. `chromium`. */
	readonly engine: string;
	/** Version string reported by the launched browser. */
	readonly version: string;
	readonly selection: BrowserSelectionKind;
	/** Absolute path for `executable`, channel name for `channel`, else null. */
	readonly selector: string | null;
	/** SHA-256 of the launched binary when it could be hashed. */
	readonly binarySha256: string | null;
	/**
	 * False when the binary was not explicitly selected. A run with
	 * `explicitlySelected: false` may never be reported as conformance evidence.
	 */
	readonly explicitlySelected: boolean;
};

/**
 * Chromium source-port identity. Deliberately separate from
 * {@link BrowserProvenance}: a source revision is not a launched binary.
 */
export type SourcePortProvenance = {
	readonly chromiumRevision: string;
	readonly dirtyWorkingTree: boolean;
	readonly v8Artifacts?: readonly { readonly name: string; readonly sha256: string }[];
};

export type FixtureProvenance = {
	/** `runway-local` for Runway's own fixtures, `wpt` for upstream. */
	readonly kind: string;
	/** Origin actually served, read back from the listening socket. */
	readonly origin: string | null;
	/** Upstream revision, manifest hash, or content hash. Never invented. */
	readonly identity: Readonly<Record<string, string>>;
	readonly capabilities: readonly string[];
};

export type LaneProvenance = {
	readonly laneId: LaneId;
	/** `reference` compares against, `candidate` is the subject under test. */
	readonly role: "reference" | "candidate";
	readonly adapter: string;
	/** Hashes of everything the lane loaded (plugin entries, profile, assets). */
	readonly loaded: Readonly<Record<string, string>>;
};

export type ProvenanceBundle = {
	readonly browser: BrowserProvenance;
	readonly lane: LaneProvenance;
	readonly fixtures: readonly FixtureProvenance[];
	readonly sourcePort?: SourcePortProvenance;
};

export type ArtifactRef = {
	readonly name: string;
	/** Path relative to the run directory. Absolute paths are rejected. */
	readonly path: string;
	readonly sha256: string;
	readonly bytes: number;
	readonly truncated?: boolean;
};

export type TruncationNote = {
	readonly what: string;
	readonly keptBytes: number;
	readonly droppedBytes: number;
};

export type OwnerSignal = "verified" | "absent" | "conflicting" | "notRequired";

export type LaneEvidence = {
	/** The in-page code echoed this attempt's nonce. */
	readonly nonceEcho: boolean;
	/** Owner (plugin/candidate) attestation state, correlated host-side. */
	readonly ownerSignal: OwnerSignal;
	/**
	 * How this attempt produced its terminal result.
	 *
	 * Host-fixture verdicts are Node callbacks owned by the attempt; they do not
	 * echo a page nonce. Page bindings must echo the nonce. Playwright control
	 * has neither.
	 */
	readonly resultChannel: "page" | "host" | "playwright" | "node";
	/** True when host pass/fail hooks belonged to this attempt's fixture instance. */
	readonly hostOwned: boolean;
	/**
	 * Host-side observation that traffic actually took the candidate route.
	 *
	 * Handshake and idle TCP streams are diagnostic. `matchedTarget` for a local
	 * fixture is true only when an HTTP request for the expected target arrived
	 * on the same accepted TCP connection as this attempt's wisp upstream.
	 */
	readonly routeInstrumentation?: {
		readonly handshakeUpgrades: number;
		readonly rejectedUpgrades: number;
		readonly acceptedStreamsToTarget: number;
		readonly httpOnAcceptedStream: number;
		readonly ignoredRequests: number;
		readonly unmatchedHttp: number;
		readonly matchedTarget: boolean;
		readonly mode: "local-http" | "remote-stream";
	};
	readonly artifacts: readonly ArtifactRef[];
	readonly truncations: readonly TruncationNote[];
	/** Self-reported claims. Never authoritative on their own. */
	readonly selfReported?: Readonly<Record<string, unknown>>;
};

export type SubtestRecord = {
	readonly name: string;
	readonly status: "pass" | "fail" | "timeout" | "notRun" | "preconditionFailed";
	readonly message: string | null;
	/** Authoritative upstream numeric status when the suite defines one. */
	readonly upstreamStatus?: number;
};

export type TerminalRecord = {
	readonly protocolVersion: ProtocolVersion;
	readonly runId: RunId;
	readonly planHash: string;
	readonly testId: TestId;
	readonly laneId: LaneId;
	/** Monotonic per run, assigned by the recorder. */
	readonly sequence: number;
	readonly nonce: string;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly durationMs: number;
	readonly outcome: TerminalOutcome;
	readonly summary: string | null;
	readonly failure?: SerializedRunwayError | { readonly message: string; readonly stack?: string };
	readonly subtests?: readonly SubtestRecord[];
	readonly evidence: LaneEvidence;
	readonly provenance: ProvenanceBundle;
	/** Capabilities this test required, as declared by its suite adapter. */
	readonly requiredCapabilities: readonly string[];
};

export type RunStartedEvent = {
	readonly type: "runStarted";
	readonly protocolVersion: ProtocolVersion;
	readonly runId: RunId;
	readonly planHash: string;
	readonly at: string;
	readonly plannedPairs: number;
};

export type DiagnosticEvent = {
	readonly type: "diagnostic";
	readonly runId: RunId;
	readonly at: string;
	readonly level: "info" | "warning" | "error";
	readonly message: string;
	readonly testId?: TestId;
	readonly laneId?: LaneId;
	readonly details?: Readonly<Record<string, unknown>>;
};

export type TerminalEvent = {
	readonly type: "terminal";
	readonly record: TerminalRecord;
};

export type RunFinishedEvent = {
	readonly type: "runFinished";
	readonly runId: RunId;
	readonly at: string;
	readonly reason: "completed" | "aborted" | "failed";
	readonly terminalCount: number;
};

export type RunEvent =
	| RunStartedEvent
	| DiagnosticEvent
	| TerminalEvent
	| RunFinishedEvent;

const malformed: SchemaFail = (message, details) => {
	throw new RunwayError("record/malformed", message, { details });
};

function requireString(
	source: Record<string, unknown>,
	key: string,
	context: string
): string {
	return stringAt(malformed, source, key, context);
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function sha256At(
	source: Record<string, unknown>,
	key: string,
	context: string
): string {
	const value = stringAt(malformed, source, key, context);
	if (!SHA256_PATTERN.test(value)) {
		malformed(`${context}.${key} must be 64 lowercase hex characters`, {
			context,
			key,
			value,
		});
	}
	return value;
}

/**
 * A branded identifier, validated by the same constructor the rest of the runtime
 * uses. A record may not name a test, lane or run whose id this build would refuse
 * to mint.
 */
function idAt(
	source: Record<string, unknown>,
	key: string,
	context: string,
	make: (value: string) => string
): string {
	const raw = stringAt(malformed, source, key, context);
	try {
		return make(raw);
	} catch (cause) {
		return malformed(`${context}.${key} is not a valid identifier`, {
			context,
			key,
			value: raw,
			reason: cause instanceof Error ? cause.message : String(cause),
		});
	}
}

function nullableSha256At(
	source: Record<string, unknown>,
	key: string,
	context: string
): string | null {
	const value = nullableStringAt(malformed, source, key, context);
	if (value === null) return null;
	if (!SHA256_PATTERN.test(value)) {
		malformed(`${context}.${key} must be 64 lowercase hex characters or null`, {
			context,
			key,
			value,
		});
	}
	return value;
}

/**
 * Artifact paths are read back and hashed later, so their shape is constrained
 * here: relative to the run directory, no traversal, no absolute or drive-letter
 * path, no empty or `.` segment, no NUL. Where the bytes actually live is checked
 * separately when the artifact is verified.
 */
export function assertRunRelativePath(value: string): void {
	if (value.includes("\0")) {
		malformed("artifact paths must not contain NUL", { path: value });
	}
	if (value.startsWith("/") || value.startsWith("\\") || /^[a-zA-Z]:/.test(value)) {
		malformed("artifact paths must be relative to the run directory", { path: value });
	}
	const segments = value.split(/[/\\]/);
	for (const segment of segments) {
		if (segment === "" || segment === "." || segment === "..") {
			malformed(
				"artifact paths must be relative to the run directory without traversal or empty segments",
				{ path: value, segment }
			);
		}
	}
}

function requireObject(
	source: Record<string, unknown>,
	key: string,
	context: string
): Record<string, unknown> {
	return objectAt(malformed, source, key, context);
}

const RESULT_CHANNELS = ["page", "host", "playwright", "node"] as const;
const OWNER_SIGNALS = ["verified", "absent", "conflicting", "notRequired"] as const;
const SELECTION_KINDS = ["executable", "channel", "bundled"] as const;
const LANE_ROLES = ["reference", "candidate"] as const;
const SUBTEST_STATUSES = ["pass", "fail", "timeout", "notRun", "preconditionFailed"] as const;
const ROUTE_MODES = ["local-http", "remote-stream"] as const;
const ROUTE_COUNTERS = [
	"handshakeUpgrades",
	"rejectedUpgrades",
	"acceptedStreamsToTarget",
	"httpOnAcceptedStream",
	"ignoredRequests",
	"unmatchedHttp",
] as const;
const PLUGIN_ASSERTION_STATUSES = ["none", "satisfied", "violated", "unavailable"] as const;

/**
 * Validates a host-side route observation.
 *
 * This is the only evidence that can turn a candidate lane's raw pass into a
 * qualified one, so its shape is checked exactly: every counter is a non-negative
 * integer, `matchedTarget` is a boolean and nothing else, and `mode` is one of the
 * two modes this build can interpret. A record carrying `matchedTarget: "false"`
 * or `mode: "unknown"` is malformed — it is not an observation this runner made,
 * and reading it as one is how a proxy test starts passing without proxying.
 */
export function validateRouteInstrumentation(
	value: unknown,
	context = "evidence.routeInstrumentation"
): NonNullable<LaneEvidence["routeInstrumentation"]> {
	const route = plainObject(malformed, value, context);
	assertOnlyKeys(malformed, route, [...ROUTE_COUNTERS, "matchedTarget", "mode"], context);
	const counters: Record<string, number> = {};
	for (const counter of ROUTE_COUNTERS) {
		counters[counter] = integerAt(malformed, route, counter, context, { min: 0 });
	}
	return Object.freeze({
		handshakeUpgrades: counters.handshakeUpgrades!,
		rejectedUpgrades: counters.rejectedUpgrades!,
		acceptedStreamsToTarget: counters.acceptedStreamsToTarget!,
		httpOnAcceptedStream: counters.httpOnAcceptedStream!,
		ignoredRequests: counters.ignoredRequests!,
		unmatchedHttp: counters.unmatchedHttp!,
		matchedTarget: booleanAt(malformed, route, "matchedTarget", context),
		mode: enumAt(malformed, route, "mode", context, ROUTE_MODES),
	});
}

/**
 * True when this value is a route observation this build can interpret.
 *
 * Used by qualification, which must refuse to read a malformed observation as
 * proof even when it is handed a record directly rather than through a log.
 */
export function isValidRouteInstrumentation(value: unknown): boolean {
	try {
		validateRouteInstrumentation(value);
		return true;
	} catch {
		return false;
	}
}

function validateArtifacts(evidence: Record<string, unknown>): readonly ArtifactRef[] {
	const items = arrayAt(malformed, evidence, "artifacts", "evidence");
	return Object.freeze(
		items.map((item, index) => {
			const context = `evidence.artifacts[${index}]`;
			const entry = plainObject(malformed, item, context);
			assertOnlyKeys(malformed, entry, ["name", "path", "sha256", "bytes", "truncated"], context);
			const artifactPath = stringAt(malformed, entry, "path", context);
			assertRunRelativePath(artifactPath);
			const truncated = entry.truncated === undefined
				? undefined
				: booleanAt(malformed, entry, "truncated", context);
			return Object.freeze({
				name: stringAt(malformed, entry, "name", context),
				path: artifactPath,
				sha256: sha256At(entry, "sha256", context),
				bytes: integerAt(malformed, entry, "bytes", context, { min: 0 }),
				...(truncated === undefined ? {} : { truncated }),
			});
		})
	);
}

function validateTruncations(evidence: Record<string, unknown>): readonly TruncationNote[] {
	const items = arrayAt(malformed, evidence, "truncations", "evidence");
	return Object.freeze(
		items.map((item, index) => {
			const context = `evidence.truncations[${index}]`;
			const note = plainObject(malformed, item, context);
			assertOnlyKeys(malformed, note, ["what", "keptBytes", "droppedBytes"], context);
			return Object.freeze({
				what: stringAt(malformed, note, "what", context),
				keptBytes: integerAt(malformed, note, "keptBytes", context, { min: 0 }),
				droppedBytes: integerAt(malformed, note, "droppedBytes", context, { min: 0 }),
			});
		})
	);
}

/**
 * Validates a lane's self-report.
 *
 * Self-reports are data, not contract: a lane adapter may add counters, and this
 * reader must not decide which ones are legitimate. So the whole structure is
 * required to be plain JSON data, and the one field that carries a *verdict-shaped
 * claim* — the configured plugin verifiers' own status — must use a status this
 * build understands. Nothing here can grant evidence; it can only be honest or
 * malformed.
 */
function validateSelfReported(
	evidence: Record<string, unknown>
): Readonly<Record<string, unknown>> | undefined {
	if (evidence.selfReported === undefined) return undefined;
	const report = jsonData(malformed, evidence.selfReported, "evidence.selfReported") as Readonly<
		Record<string, unknown>
	>;
	if (!isPlainRecord(report)) {
		malformed("evidence.selfReported must be a JSON object", {});
	}
	const plugin = report.pluginAssertions;
	if (plugin !== undefined) {
		const context = "evidence.selfReported.pluginAssertions";
		const claim = plainObject(malformed, plugin, context);
		enumAt(malformed, claim, "status", context, PLUGIN_ASSERTION_STATUSES);
		arrayAt(malformed, claim, "failures", context);
		if (claim.unavailableReason !== undefined) {
			stringAt(malformed, claim, "unavailableReason", context);
		}
		if (claim.targets !== undefined) {
			const targets = arrayAt(malformed, claim, "targets", context);
			for (const [index, item] of targets.entries()) {
				const targetContext = `${context}.targets[${index}]`;
				const target = plainObject(malformed, item, targetContext);
				nullableStringAt(malformed, target, "target", targetContext);
				enumAt(malformed, target, "status", targetContext, PLUGIN_ASSERTION_STATUSES);
				// `invoked` is the list of verifier modules the harness reported it
				// actually ran, exactly as the lane produces it. It is checked as a
				// string array and never coerced — an absent list is not "invoked",
				// and a boolean would be a claim the producer does not make.
				stringArrayAt(malformed, target, "invoked", targetContext);
			}
		}
	}
	return report;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateEvidence(record: Record<string, unknown>): LaneEvidence {
	const evidence = requireObject(record, "evidence", "terminal record");
	assertOnlyKeys(
		malformed,
		evidence,
		[
			"nonceEcho",
			"ownerSignal",
			"resultChannel",
			"hostOwned",
			"routeInstrumentation",
			"artifacts",
			"truncations",
			"selfReported",
		],
		"evidence"
	);
	const selfReported = validateSelfReported(evidence);
	const route =
		evidence.routeInstrumentation === undefined
			? undefined
			: validateRouteInstrumentation(evidence.routeInstrumentation);
	return Object.freeze({
		nonceEcho: booleanAt(malformed, evidence, "nonceEcho", "evidence"),
		ownerSignal: enumAt(malformed, evidence, "ownerSignal", "evidence", OWNER_SIGNALS),
		resultChannel: enumAt(malformed, evidence, "resultChannel", "evidence", RESULT_CHANNELS),
		hostOwned: booleanAt(malformed, evidence, "hostOwned", "evidence"),
		...(route === undefined ? {} : { routeInstrumentation: route }),
		artifacts: validateArtifacts(evidence),
		truncations: validateTruncations(evidence),
		...(selfReported === undefined ? {} : { selfReported }),
	});
}

function validateProvenance(record: Record<string, unknown>): ProvenanceBundle {
	const provenance = requireObject(record, "provenance", "terminal record");
	assertOnlyKeys(
		malformed,
		provenance,
		["browser", "lane", "fixtures", "sourcePort"],
		"provenance"
	);

	const browserRaw = requireObject(provenance, "browser", "provenance");
	assertOnlyKeys(
		malformed,
		browserRaw,
		["engine", "version", "selection", "selector", "binarySha256", "explicitlySelected"],
		"provenance.browser"
	);
	const browser: BrowserProvenance = Object.freeze({
		engine: stringAt(malformed, browserRaw, "engine", "provenance.browser"),
		version: stringAt(malformed, browserRaw, "version", "provenance.browser"),
		selection: enumAt(
			malformed,
			browserRaw,
			"selection",
			"provenance.browser",
			SELECTION_KINDS
		),
		selector: nullableStringAt(malformed, browserRaw, "selector", "provenance.browser"),
		binarySha256: nullableSha256At(browserRaw, "binarySha256", "provenance.browser"),
		explicitlySelected: booleanAt(
			malformed,
			browserRaw,
			"explicitlySelected",
			"provenance.browser"
		),
	});

	const laneRaw = requireObject(provenance, "lane", "provenance");
	assertOnlyKeys(malformed, laneRaw, ["laneId", "role", "adapter", "loaded"], "provenance.lane");
	const lane: LaneProvenance = Object.freeze({
		laneId: stringAt(malformed, laneRaw, "laneId", "provenance.lane") as LaneId,
		role: enumAt(malformed, laneRaw, "role", "provenance.lane", LANE_ROLES),
		adapter: stringAt(malformed, laneRaw, "adapter", "provenance.lane"),
		loaded: stringRecordAt(malformed, laneRaw, "loaded", "provenance.lane"),
	});

	const fixturesRaw = arrayAt(malformed, provenance, "fixtures", "provenance");
	const fixtures: readonly FixtureProvenance[] = Object.freeze(
		fixturesRaw.map((item, index) => {
			const context = `provenance.fixtures[${index}]`;
			const entry = plainObject(malformed, item, context);
			assertOnlyKeys(malformed, entry, ["kind", "origin", "identity", "capabilities"], context);
			return Object.freeze({
				kind: stringAt(malformed, entry, "kind", context),
				origin: nullableStringAt(malformed, entry, "origin", context),
				identity: stringRecordAt(malformed, entry, "identity", context),
				capabilities: stringArrayAt(malformed, entry, "capabilities", context),
			});
		})
	);

	let sourcePort: SourcePortProvenance | undefined;
	if (provenance.sourcePort !== undefined) {
		const context = "provenance.sourcePort";
		const raw = plainObject(malformed, provenance.sourcePort, context);
		assertOnlyKeys(malformed, raw, ["chromiumRevision", "dirtyWorkingTree", "v8Artifacts"], context);
		const artifacts = optionalArrayAt(malformed, raw, "v8Artifacts", context);
		sourcePort = Object.freeze({
			chromiumRevision: stringAt(malformed, raw, "chromiumRevision", context),
			dirtyWorkingTree: booleanAt(malformed, raw, "dirtyWorkingTree", context),
			...(artifacts === undefined
				? {}
				: {
						v8Artifacts: Object.freeze(
							artifacts.map((item, index) => {
								const artifactContext = `${context}.v8Artifacts[${index}]`;
								const entry = plainObject(malformed, item, artifactContext);
								assertOnlyKeys(malformed, entry, ["name", "sha256"], artifactContext);
								return Object.freeze({
									name: stringAt(malformed, entry, "name", artifactContext),
									sha256: sha256At(entry, "sha256", artifactContext),
								});
							})
						),
					}),
		});
	}

	return Object.freeze({
		browser,
		lane,
		fixtures,
		...(sourcePort === undefined ? {} : { sourcePort }),
	});
}

function validateSubtests(record: Record<string, unknown>): readonly SubtestRecord[] | undefined {
	if (record.subtests === undefined) return undefined;
	const items = arrayAt(malformed, record, "subtests", "terminal record");
	return Object.freeze(
		items.map((item, index) => {
			const context = `subtests[${index}]`;
			const entry = plainObject(malformed, item, context);
			assertOnlyKeys(malformed, entry, ["name", "status", "message", "upstreamStatus"], context);
			const upstreamStatus = optionalIntegerAt(malformed, entry, "upstreamStatus", context, {
				min: 0,
			});
			return Object.freeze({
				name: stringAt(malformed, entry, "name", context),
				status: enumAt(malformed, entry, "status", context, SUBTEST_STATUSES),
				// A subtest's message is text the subject wrote. An assertion that
				// failed with an empty message said something — that it failed and
				// explained nothing — which is not the same as having no message at
				// all, so `""` is kept and `null` stays available for the absence.
				message: nullableTextAt(malformed, entry, "message", context),
				...(upstreamStatus === undefined ? {} : { upstreamStatus }),
			});
		})
	);
}

/**
 * Validates a failure payload.
 *
 * Two shapes are legitimate: a serialized {@link RunwayError} and a bare message
 * (what an adapter reports when the subject itself failed). Both must carry a
 * message; a structured error must also carry its code, because a failure without
 * one cannot be acted on.
 */
function validateFailure(record: Record<string, unknown>): TerminalRecord["failure"] {
	if (record.failure === undefined) return undefined;
	const context = "terminal record failure";
	const failure = plainObject(malformed, record.failure, context);
	assertOnlyKeys(
		malformed,
		failure,
		["name", "code", "message", "details", "remedy", "cause", "stack"],
		context
	);
	stringAt(malformed, failure, "message", context);
	if (failure.name !== undefined) {
		stringAt(malformed, failure, "name", context);
		if (failure.name === "RunwayError") {
			stringAt(malformed, failure, "code", context);
			objectAt(malformed, failure, "details", context);
		}
	}
	optionalStringAt(malformed, failure, "stack", context);
	optionalStringAt(malformed, failure, "remedy", context);
	return jsonData(malformed, failure, context) as TerminalRecord["failure"];
}

/**
 * Validates an untrusted record.
 *
 * A payload that fails validation is never accepted as a pass; callers record it
 * as `invalidRecord` instead. Validation is structural and total: every nested
 * enum, boolean, counter and identifier is checked, and nothing is coerced, so a
 * record that "almost" describes an observation is refused rather than read as
 * one.
 */
export function validateTerminalRecord(value: unknown): TerminalRecord {
	const record = plainObject(malformed, value, "terminal record");
	assertOnlyKeys(
		malformed,
		record,
		[
			"protocolVersion",
			"runId",
			"planHash",
			"testId",
			"laneId",
			"sequence",
			"nonce",
			"startedAt",
			"finishedAt",
			"durationMs",
			"outcome",
			"summary",
			"failure",
			"subtests",
			"evidence",
			"provenance",
			"requiredCapabilities",
		],
		"terminal record"
	);
	const version = requireString(record, "protocolVersion", "terminal record");
	if (version !== PROTOCOL_VERSION) {
		throw new RunwayError(
			"record/protocol-mismatch",
			`terminal record uses protocol ${version}, this build reads ${PROTOCOL_VERSION}`,
			{
				details: { found: version, expected: PROTOCOL_VERSION },
				remedy:
					"Read the run with a matching Runway version, or convert it with an " +
					"explicit version adapter. Old records are never accepted as new ones.",
			}
		);
	}
	if (!isTerminalOutcome(record.outcome)) {
		malformed(
			`terminal record has an unknown outcome; this build knows ${TERMINAL_OUTCOMES.join(", ")}`,
			{ outcome: typeof record.outcome === "string" ? record.outcome : null }
		);
	}
	const subtests = validateSubtests(record);
	const failure = validateFailure(record);
	return Object.freeze({
		protocolVersion: PROTOCOL_VERSION,
		runId: idAt(record, "runId", "terminal record", asRunId) as RunId,
		planHash: sha256At(record, "planHash", "terminal record"),
		testId: idAt(record, "testId", "terminal record", asTestId) as TestId,
		laneId: idAt(record, "laneId", "terminal record", asLaneId) as LaneId,
		sequence: integerAt(malformed, record, "sequence", "terminal record", { min: 1 }),
		nonce: requireString(record, "nonce", "terminal record"),
		startedAt: timestampAt(malformed, record, "startedAt", "terminal record"),
		finishedAt: timestampAt(malformed, record, "finishedAt", "terminal record"),
		durationMs: finiteNumberAt(malformed, record, "durationMs", "terminal record", { min: 0 }),
		outcome: record.outcome,
		// Free text, for the same reason as a subtest's message: `""` is an empty
		// summary and `null` is no summary, and a reader that folded one into the
		// other would be editing the record it is supposed to be checking.
		summary: nullableTextAt(malformed, record, "summary", "terminal record"),
		...(failure === undefined ? {} : { failure }),
		...(subtests === undefined ? {} : { subtests }),
		evidence: validateEvidence(record),
		provenance: validateProvenance(record),
		requiredCapabilities: stringArrayAt(
			malformed,
			record,
			"requiredCapabilities",
			"terminal record"
		),
	});
}

/** Validates an untrusted event read back from a run log. */
export function validateRunEvent(value: unknown): RunEvent {
	const event = plainObject(malformed, value, "run event");
	switch (event.type) {
		case "runStarted": {
			const context = "runStarted event";
			assertOnlyKeys(
				malformed,
				event,
				["type", "protocolVersion", "runId", "planHash", "at", "plannedPairs"],
				context
			);
			const version = requireString(event, "protocolVersion", context);
			if (version !== PROTOCOL_VERSION) {
				throw new RunwayError(
					"record/protocol-mismatch",
					`run log uses protocol ${version}, this build reads ${PROTOCOL_VERSION}`,
					{ details: { found: version, expected: PROTOCOL_VERSION } }
				);
			}
			return Object.freeze({
				type: "runStarted",
				protocolVersion: PROTOCOL_VERSION,
				runId: idAt(event, "runId", context, asRunId) as RunId,
				planHash: sha256At(event, "planHash", context),
				at: timestampAt(malformed, event, "at", context),
				plannedPairs: integerAt(malformed, event, "plannedPairs", context, { min: 0 }),
			});
		}
		case "runFinished": {
			const context = "runFinished event";
			assertOnlyKeys(malformed, event, ["type", "runId", "at", "reason", "terminalCount"], context);
			return Object.freeze({
				type: "runFinished",
				runId: idAt(event, "runId", context, asRunId) as RunId,
				at: timestampAt(malformed, event, "at", context),
				reason: enumAt(malformed, event, "reason", context, [
					"completed",
					"aborted",
					"failed",
				] as const),
				terminalCount: integerAt(malformed, event, "terminalCount", context, { min: 0 }),
			});
		}
		case "diagnostic": {
			const context = "diagnostic event";
			assertOnlyKeys(
				malformed,
				event,
				["type", "runId", "at", "level", "message", "testId", "laneId", "details"],
				context
			);
			const testId = event.testId === undefined ? undefined : idAt(event, "testId", context, asTestId);
			const laneId = event.laneId === undefined ? undefined : idAt(event, "laneId", context, asLaneId);
			const details =
				event.details === undefined
					? undefined
					: (jsonData(malformed, objectAt(malformed, event, "details", context), `${context}.details`) as Readonly<
							Record<string, unknown>
						>);
			return Object.freeze({
				type: "diagnostic",
				runId: idAt(event, "runId", context, asRunId) as RunId,
				at: timestampAt(malformed, event, "at", context),
				level: enumAt(malformed, event, "level", context, ["info", "warning", "error"] as const),
				message: requireString(event, "message", context),
				...(testId === undefined ? {} : { testId: testId as TestId }),
				...(laneId === undefined ? {} : { laneId: laneId as LaneId }),
				...(details === undefined ? {} : { details }),
			});
		}
		case "terminal": {
			assertOnlyKeys(malformed, event, ["type", "record"], "terminal event");
			return Object.freeze({
				type: "terminal",
				record: validateTerminalRecord(event.record),
			});
		}
		default:
			return malformed("run event has an unknown type", {
				type: typeof event.type === "string" ? event.type : null,
			});
	}
}
