/**
 * Deterministic comparison over recorded evidence.
 *
 * This module is pure: it takes a plan, a loaded run and the separately stored
 * expectations, and returns a report. It performs no I/O and launches nothing, so
 * a verdict can be recomputed offline from an immutable run directory and must
 * come out identical.
 *
 * The denominator and every requirement come from the plan, not from the records
 * and not from the caller: the inventory and the planned pairs are rebuilt from
 * `plan.inventory` here, and a record that carries another run id or plan hash,
 * names a pair the plan never planned, or duplicates a pair is refused outright
 * rather than indexed.
 *
 * Rules it enforces:
 *   * expectations explain failures, they never create passes;
 *   * identical failures in both lanes are recorded as shared failures, which is
 *     never reported as parity success;
 *   * a planned pair with no record is `missing`, and a malformed record is
 *     `invalidRecord`; neither can be a pass;
 *   * qualification misses downgrade a raw pass and affect the exit code;
 *   * an artifact a record named but that is missing or altered fails the pair,
 *     even when the raw outcome was expected;
 *   * records that disagree about the browser identity or a lane's loaded assets
 *     are an incoherent run, not a set of comparable results;
 *   * a plan the configuration already made ineligible (certificate bypass, an
 *     unselected browser) yields zero qualified passes and a failing exit code,
 *     while its raw outcomes are still reported exactly as recorded;
 *   * a run that did not finish, or finished `failed`/`aborted`, cannot report
 *     success however its pairs came out.
 */
import type { ArtifactIssue, ArtifactVerification } from "./artifacts.ts";
import { RunwayError } from "./errors.ts";
import { canonicalJson, terminalKey, type LaneId, type TestId } from "./ids.ts";
import { inventoryFromSnapshot, type PlannedPair } from "./inventory.ts";
import {
	isFailureForExit,
	isRawPass,
	type TerminalOutcome,
} from "./outcome.ts";
import type { LanePlan, RunPlan } from "./plan.ts";
import type { TerminalRecord } from "./protocol.ts";
import {
	admissionIntegrityMiss,
	qualifyPair,
	type AdmissionIntegrityFault,
	type QualificationMiss,
} from "./verification.ts";

/** Outcomes an expectation may name. Everything else is runner state and cannot be expected away. */
export const EXPECTABLE_OUTCOMES = ["assertionFailure"] as const;
export type ExpectableOutcome = (typeof EXPECTABLE_OUTCOMES)[number];

export type ExpectationEntry = {
	/** Required. An expectation that omits lanes is rejected at load. */
	readonly lanes: readonly LaneId[];
	/** Required. Only assertion failures may be expected. */
	readonly outcomes: readonly ExpectableOutcome[];
	readonly reason: string;
};

export type Expectations = {
	readonly version: 1;
	/** Keyed by test id. Stored apart from raw evidence, by design. */
	readonly expectedFailures: Readonly<Record<string, ExpectationEntry>>;
};

export const EMPTY_EXPECTATIONS: Expectations = Object.freeze({
	version: 1,
	expectedFailures: Object.freeze({}),
});

export type PairVerdict = {
	readonly testId: TestId;
	readonly laneId: LaneId;
	readonly outcome: TerminalOutcome;
	readonly qualified: boolean;
	readonly misses: readonly QualificationMiss[];
	readonly expected: boolean;
	readonly expectationReason: string | null;
	readonly summary: string | null;
	/**
	 * False when an artifact this record named is missing, altered, or outside the
	 * run root. Broken evidence is never a pass and never expectable.
	 */
	readonly evidenceIntact: boolean;
	readonly artifactIssues: readonly {
		readonly name: string;
		readonly path: string;
		readonly code: string;
		readonly detail: string;
	}[];
	/** True when this pair makes the run fail. */
	readonly countsAsFailure: boolean;
};

/** A run-level incoherence: the records do not describe one configuration. */
export type IntegrityIssue = {
	readonly code: "integrity/browser-identity" | "integrity/lane-assets";
	readonly detail: string;
};

export type TestVerdict = {
	readonly testId: TestId;
	readonly lanes: readonly PairVerdict[];
	/**
	 * `regression` means the reference lane passed and a candidate lane did not.
	 * `sharedFailure` means every lane failed: explicitly not parity success.
	 */
	readonly relation:
		| "allQualifiedPass"
		| "passWithMissingEvidence"
		| "regression"
		| "candidateOnlyPass"
		| "sharedFailure"
		| "notRun"
		| "incomplete";
};

export type ComparisonReport = {
	readonly protocolVersion: string;
	readonly runId: string | null;
	readonly planHash: string | null;
	readonly plannedPairs: number;
	readonly conformance: {
		readonly eligible: boolean;
		readonly reasons: readonly string[];
	};
	/** Identity of the denominator the records were bound to. */
	readonly inventoryDigest: string;
	readonly totals: {
		readonly byOutcome: Readonly<Record<string, number>>;
		readonly qualifiedPasses: number;
		readonly rawPassesMissingEvidence: number;
		readonly expectedFailures: number;
		readonly unexpectedFailures: number;
		readonly missing: number;
		readonly rejectedRecords: number;
		readonly sharedFailures: number;
		readonly regressions: number;
		readonly artifactFailures: number;
		readonly integrityFailures: number;
	};
	/**
	 * How the run itself ended, as its own log declared. A partial run is not a
	 * partial pass: an unfinished or failed run cannot report success, however its
	 * individual pairs came out.
	 */
	readonly completion: {
		readonly finished: boolean;
		readonly reason: "completed" | "aborted" | "failed" | null;
		readonly successful: boolean;
	};
	readonly evidence: {
		readonly artifactsDeclared: number;
		readonly artifactsVerified: number;
		readonly artifactIssues: readonly ArtifactIssue[];
		/** Browser identities observed across every record. More than one is incoherent. */
		readonly browserIdentities: readonly string[];
		readonly integrityIssues: readonly IntegrityIssue[];
		/** True when no artifact was checked because none was declared. */
		readonly artifactsUnverified: boolean;
	};
	readonly tests: readonly TestVerdict[];
	readonly rejectedRecords: readonly {
		readonly line: number;
		readonly code: string;
		readonly message: string;
	}[];
	readonly notes: readonly string[];
	readonly exitCode: number;
};

/** How the run log said the run ended. */
export type RunCompletion = {
	readonly finished: boolean;
	readonly reason: "completed" | "aborted" | "failed" | null;
};

export type ComparisonInput = {
	/**
	 * The plan is the only source of the denominator. The inventory and the
	 * planned pairs are derived from `plan.inventory` here, so a caller cannot
	 * hand in a narrower set of pairs, a different inventory, or requirements
	 * taken from the records themselves.
	 */
	readonly plan: RunPlan;
	readonly records: readonly TerminalRecord[];
	readonly rejectedRecords?: readonly {
		readonly line: number;
		readonly code: string;
		readonly message: string;
	}[];
	readonly expectations?: Expectations;
	/**
	 * Result of reading every declared artifact back from the run root. Comparison
	 * stays pure: the I/O happens in `core/artifacts.ts` and its findings are an
	 * input here.
	 */
	readonly artifacts?: ArtifactVerification;
	/**
	 * How the run ended, taken from its log. Required: "the caller did not say"
	 * must not be readable as "the run completed".
	 */
	readonly completion: RunCompletion;
	/**
	 * Pairs whose admissions the run could not close, read back from its own
	 * diagnostics.
	 *
	 * Required, for the same reason `completion` is: this gate exists because an
	 * optimistic default once let the runner vouch for a record it could not place,
	 * and an optional field whose absence means "there were none" would rebuild that
	 * mistake at the API boundary. A caller that has nothing to report says so with
	 * an empty array.
	 *
	 * Narrow by construction: only the named pairs lose qualification. A failed run
	 * does *not* disqualify every pair in it — the existing contract already handles
	 * a failed run by refusing to call the run successful, and widening this into
	 * "any failure invalidates everything" would throw away independent, properly
	 * admitted results for no gain in truthfulness.
	 */
	readonly admissionIntegrityFaults: readonly AdmissionIntegrityFault[];
	/** Context the caller already knows, e.g. a converted expectations file. */
	readonly notes?: readonly string[];
};

function expectationFor(
	expectations: Expectations,
	testId: TestId,
	laneId: LaneId,
	outcome: TerminalOutcome
): ExpectationEntry | null {
	const entry = expectations.expectedFailures[testId];
	if (!entry) return null;
	if (!entry.lanes.includes(laneId)) return null;
	if (!entry.outcomes.includes(outcome as ExpectableOutcome)) return null;
	if (isRawPass(outcome)) return null;
	return entry;
}

function laneById(plan: RunPlan, laneId: LaneId): LanePlan | undefined {
	return plan.lanes.find((lane) => lane.laneId === laneId);
}

/** How a record identifies the actual browser artifact it ran on. */
function browserIdentity(record: TerminalRecord): string {
	const browser = record.provenance.browser;
	return (
		`${browser.engine} ${browser.version} ` +
		`sha256:${browser.binarySha256 ?? "unhashed"} ` +
		`(${browser.selection}:${browser.selector ?? "none"})`
	);
}

/**
 * Checks that the records describe one coherent configuration.
 *
 * Both lanes must have run on the same actual browser artifact: an input identity
 * that differs between lanes means the two sides are not comparable, whatever the
 * outcomes say. The same holds for a lane's loaded assets within one adapter.
 * Plugin material is only required when a lane declares it, so a builtin profile
 * that loads nothing extra is coherent, not incomplete.
 */
function coherenceIssues(records: readonly TerminalRecord[]): {
	readonly browserIdentities: readonly string[];
	readonly issues: readonly IntegrityIssue[];
} {
	const issues: IntegrityIssue[] = [];
	const identities = new Map<string, Set<string>>();
	const laneAssets = new Map<string, Map<string, string>>();
	for (const record of records) {
		const identity = browserIdentity(record);
		const lanes = identities.get(identity) ?? new Set<string>();
		lanes.add(record.laneId);
		identities.set(identity, lanes);

		const lane = record.provenance.lane;
		const group = `${lane.laneId}/${lane.adapter}`;
		const loaded = canonicalJson(lane.loaded ?? {});
		const perGroup = laneAssets.get(group) ?? new Map<string, string>();
		if (!perGroup.has(loaded)) perGroup.set(loaded, record.testId);
		laneAssets.set(group, perGroup);
	}
	if (identities.size > 1) {
		issues.push({
			code: "integrity/browser-identity",
			detail:
				"records disagree about the browser that produced them: " +
				[...identities]
					.map(([identity, lanes]) => `${identity} on ${[...lanes].sort().join(", ")}`)
					.join(" | ") +
				". Both lanes must run the same actual binary for their results to be comparable.",
		});
	}
	for (const [group, variants] of laneAssets) {
		if (variants.size <= 1) continue;
		issues.push({
			code: "integrity/lane-assets",
			detail:
				`lane ${group} loaded different assets within one run (${variants.size} variants, ` +
				`first seen on ${[...variants.values()].sort().join(", ")})`,
		});
	}
	return {
		browserIdentities: Object.freeze([...identities.keys()].sort()),
		issues: Object.freeze(issues),
	};
}

function invalidInput(message: string, details: Record<string, unknown>): never {
	throw new RunwayError("compare/invalid-input", message, {
		details,
		remedy:
			"Load a run with `loadRun(directory, binding)` built from the same plan. " +
			"Records that do not answer this plan are reported as rejected lines; the " +
			"comparator never picks a winner between them.",
	});
}

/**
 * Indexes the records this plan's pairs will be judged by.
 *
 * Every record must carry this run id and this plan hash and name a pair the plan
 * planned, and each pair may be answered once. A record that satisfies none of
 * that is not "extra": it is a record from somewhere else, and silently keeping
 * the last one for a pair would let a foreign or replayed result decide a verdict.
 * So this refuses rather than choosing.
 */
function indexRecords(
	plan: RunPlan,
	records: readonly TerminalRecord[],
	plannedKeys: ReadonlySet<string>
): Map<string, TerminalRecord> {
	const byKey = new Map<string, TerminalRecord>();
	for (const record of records) {
		const key = terminalKey(record.testId, record.laneId);
		if (record.runId !== plan.runId) {
			invalidInput(
				`a record for ${record.testId} on ${record.laneId} belongs to run ${record.runId}, ` +
					`but the plan being compared is run ${plan.runId}`,
				{ testId: record.testId, laneId: record.laneId, recordRunId: record.runId, planRunId: plan.runId }
			);
		}
		if (record.planHash !== plan.planHash) {
			invalidInput(
				`a record for ${record.testId} on ${record.laneId} was produced under plan ` +
					`${record.planHash}, not ${plan.planHash}`,
				{
					testId: record.testId,
					laneId: record.laneId,
					recordPlanHash: record.planHash,
					planHash: plan.planHash,
				}
			);
		}
		if (!plannedKeys.has(key)) {
			invalidInput(
				`a record for ${record.testId} on ${record.laneId} is not one of this plan's ` +
					"planned pairs, so there is nothing in the denominator for it to answer",
				{ testId: record.testId, laneId: record.laneId }
			);
		}
		if (byKey.has(key)) {
			invalidInput(
				`two records answer ${record.testId} on ${record.laneId}; a pair has exactly one ` +
					"terminal outcome and the comparator does not choose between duplicates",
				{ testId: record.testId, laneId: record.laneId }
			);
		}
		byKey.set(key, record);
	}
	return byKey;
}

/** Computes the full report. Pure. */
export function compareRun(input: ComparisonInput): ComparisonReport {
	const expectations = input.expectations ?? EMPTY_EXPECTATIONS;
	const inventory = inventoryFromSnapshot(input.plan.inventory);
	const plannedPairs: readonly PlannedPair[] = input.plan.inventory.pairs;
	const plannedKeys = new Set(
		plannedPairs.map((pair) => terminalKey(pair.testId, pair.laneId))
	);
	const byKey = indexRecords(input.plan, input.records, plannedKeys);

	const byOutcome: Record<string, number> = {};
	let qualifiedPasses = 0;
	let rawPassesMissingEvidence = 0;
	let expectedFailures = 0;
	let unexpectedFailures = 0;
	let missing = 0;
	let artifactFailures = 0;

	const artifactIssuesByPair = input.artifacts?.issuesByPair ?? new Map();
	// Only pairs the run actually named. A fault for a pair this plan never planned
	// is not silently promoted to anything: `plannedPairs` is still the denominator.
	const admissionFaultsByPair = new Map<string, AdmissionIntegrityFault>();
	for (const fault of input.admissionIntegrityFaults) {
		const key = terminalKey(fault.testId, fault.laneId);
		if (!admissionFaultsByPair.has(key)) admissionFaultsByPair.set(key, fault);
	}
	const perTest = new Map<TestId, PairVerdict[]>();
	for (const pair of plannedPairs) {
		const entry = inventory.byId.get(pair.testId);
		const lane = laneById(input.plan, pair.laneId);
		const record = byKey.get(terminalKey(pair.testId, pair.laneId));
		let verdict: PairVerdict;

		if (!record) {
			missing += 1;
			byOutcome.missing = (byOutcome.missing ?? 0) + 1;
			verdict = {
				testId: pair.testId,
				laneId: pair.laneId,
				outcome: "missing",
				qualified: false,
				misses: [],
				expected: false,
				expectationReason: null,
				summary: "planned but no terminal record was written",
				evidenceIntact: true,
				artifactIssues: [],
				countsAsFailure: true,
			};
			unexpectedFailures += 1;
		} else {
			if (!entry || !lane) {
				// The pair came from the plan's own snapshot, which is validated
				// against the plan's lanes when the plan is built. Reaching here means
				// the plan contradicts itself, which is not something to paper over
				// with a synthetic miss.
				invalidInput(
					`the plan plans ${pair.testId} on ${pair.laneId} but does not describe ` +
						`${entry ? "that lane" : "that test"}`,
					{ testId: pair.testId, laneId: pair.laneId }
				);
			}
			// Requirements come from the plan's inventory snapshot and the plan's lane
			// definition — never from the record, which must not be able to describe
			// the standard it is judged by.
			const qualification = qualifyPair(record, entry, lane, input.plan);
			const expectation = expectationFor(
				expectations,
				record.testId,
				record.laneId,
				record.outcome
			);
			byOutcome[record.outcome] = (byOutcome[record.outcome] ?? 0) + 1;
			const pairArtifactIssues: readonly ArtifactIssue[] =
				artifactIssuesByPair.get(terminalKey(record.testId, record.laneId)) ?? [];
			const evidenceIntact = pairArtifactIssues.length === 0;
			if (!evidenceIntact) artifactFailures += 1;
			const rawPass = isRawPass(record.outcome);
			// A pair whose admissions could not be closed keeps its record — the raw
			// observation is evidence of what happened and is never rewritten — but the
			// run cannot say whether that record was admitted before or after the pair
			// lost its claim, so it cannot be counted as a qualified pass. The miss is
			// appended so the report says exactly which pair and why.
			const admissionFault = admissionFaultsByPair.get(
				terminalKey(record.testId, record.laneId)
			);
			const misses: readonly QualificationMiss[] = admissionFault
				? Object.freeze([...qualification.misses, admissionIntegrityMiss(admissionFault.detail)])
				: qualification.misses;
			// Broken artifact evidence is never a qualified pass, and it is not
			// something an expectation can cover: the record no longer stands for
			// what it claimed.
			const qualified = qualification.qualified && evidenceIntact && !admissionFault;
			if (rawPass && qualified) qualifiedPasses += 1;
			if (rawPass && !qualified) rawPassesMissingEvidence += 1;
			const failingOutcome = isFailureForExit(record.outcome);
			const expected = expectation !== null && evidenceIntact;
			if (failingOutcome && expected) expectedFailures += 1;
			const countsAsFailure =
				(failingOutcome && !expected) || (rawPass && !qualified) || !evidenceIntact;
			if (countsAsFailure) unexpectedFailures += 1;
			verdict = {
				testId: record.testId,
				laneId: record.laneId,
				outcome: record.outcome,
				qualified,
				misses,
				expected,
				expectationReason: expectation?.reason ?? null,
				summary: record.summary,
				evidenceIntact,
				artifactIssues: Object.freeze(
					pairArtifactIssues.map((issue) => ({
						name: issue.name,
						path: issue.path,
						code: issue.code,
						detail: issue.detail,
					}))
				),
				countsAsFailure,
			};
		}

		const list = perTest.get(pair.testId) ?? [];
		list.push(verdict);
		perTest.set(pair.testId, list);
	}

	let sharedFailures = 0;
	let regressions = 0;
	const tests: TestVerdict[] = [];
	for (const [testId, lanes] of perTest) {
		const referenceLanes = lanes.filter(
			(pair) => laneById(input.plan, pair.laneId)?.role === "reference"
		);
		const candidateLanes = lanes.filter(
			(pair) => laneById(input.plan, pair.laneId)?.role === "candidate"
		);
		const passing = (pair: PairVerdict) => isRawPass(pair.outcome);
		const allNotRun = lanes.every(
			(pair) => pair.outcome === "notRun" || pair.outcome === "unsupported"
		);
		let relation: TestVerdict["relation"];
		if (allNotRun) {
			relation = "notRun";
		} else if (lanes.some((pair) => pair.outcome === "missing")) {
			relation = "incomplete";
		} else if (lanes.every((pair) => passing(pair) && pair.qualified && pair.evidenceIntact)) {
			relation = "allQualifiedPass";
		} else if (lanes.every(passing)) {
			relation = "passWithMissingEvidence";
		} else if (
			referenceLanes.length > 0 &&
			referenceLanes.every(passing) &&
			candidateLanes.some((pair) => !passing(pair))
		) {
			relation = "regression";
			regressions += 1;
		} else if (
			candidateLanes.length > 0 &&
			candidateLanes.every(passing) &&
			referenceLanes.some((pair) => !passing(pair))
		) {
			relation = "candidateOnlyPass";
		} else {
			// Every lane failed. Agreement between failures is not success.
			relation = "sharedFailure";
			sharedFailures += 1;
		}
		tests.push({ testId, lanes, relation });
	}

	const rejected = input.rejectedRecords ?? [];
	const coherence = coherenceIssues(input.records);
	const integrityIssues: IntegrityIssue[] = [...coherence.issues];
	const notes: string[] = [...(input.notes ?? [])];
	if (sharedFailures > 0) {
		notes.push(
			`${sharedFailures} test(s) failed in every lane; identical failures are ` +
				"recorded as shared failures and are never parity success"
		);
	}
	if (rawPassesMissingEvidence > 0) {
		notes.push(
			`${rawPassesMissingEvidence} raw pass(es) lack required evidence and are ` +
				"not counted as qualified passes"
		);
	}
	if (!input.plan.conformanceEligible) {
		notes.push(
			"this run is not conformance evidence, so no pass in it is counted as " +
				`qualified: ${input.plan.ineligibilityReasons.join("; ")}`
		);
	}
	if (admissionFaultsByPair.size > 0) {
		// Named, and counted, so the scope of the doubt is visible rather than
		// implied. Pairs outside this list are unaffected and keep their standing.
		//
		// Formatted from the pair itself, never from `terminalKey`: that key joins with
		// U+0000 because it only ever has to be a Map key, and putting it in a note
		// would put a NUL byte in `report.json` and in the printed summary.
		const named = [...admissionFaultsByPair.values()]
			.map((fault) => `${fault.testId} on ${fault.laneId}`)
			.sort();
		notes.push(
			`${admissionFaultsByPair.size} pair(s) could not have their admissions closed by ` +
				`the run; their records stand as raw observations but are not qualified: ${named.join(", ")}`
		);
	}
	const completionSuccessful = input.completion.finished && input.completion.reason === "completed";
	if (!input.completion.finished) {
		notes.push(
			"the run log has no completion event; the run was interrupted and this " +
				"report describes a partial run, which is not proof of anything it does not contain"
		);
	} else if (!completionSuccessful) {
		notes.push(
			`the run itself ended ${input.completion.reason}; a run that did not complete ` +
				"successfully cannot report success, whatever its individual pairs recorded"
		);
	}
	const artifactIssues = input.artifacts?.issues ?? [];
	if (artifactIssues.length > 0) {
		notes.push(
			`${artifactIssues.length} declared artifact(s) failed verification; the affected ` +
				"results are not evidence, whatever their recorded outcome"
		);
	}
	for (const issue of integrityIssues) notes.push(`${issue.code}: ${issue.detail}`);
	if (input.artifacts === undefined) {
		notes.push("artifacts were not verified for this report");
	}

	const exitCode =
		unexpectedFailures > 0 ||
		rejected.length > 0 ||
		artifactIssues.length > 0 ||
		integrityIssues.length > 0 ||
		!completionSuccessful
			? 1
			: 0;

	return Object.freeze({
		protocolVersion: input.plan.protocolVersion,
		runId: input.plan.runId,
		planHash: input.plan.planHash,
		plannedPairs: plannedPairs.length,
		inventoryDigest: input.plan.inventory.digest,
		conformance: {
			eligible: input.plan.conformanceEligible,
			reasons: input.plan.ineligibilityReasons,
		},
		totals: {
			byOutcome: byOutcome,
			qualifiedPasses,
			rawPassesMissingEvidence,
			expectedFailures,
			unexpectedFailures,
			missing,
			rejectedRecords: rejected.length,
			sharedFailures,
			regressions,
			artifactFailures,
			integrityFailures: integrityIssues.length,
		},
		completion: {
			finished: input.completion.finished,
			reason: input.completion.reason,
			successful: completionSuccessful,
		},
		evidence: {
			artifactsDeclared: input.artifacts?.declared ?? 0,
			artifactsVerified: input.artifacts?.verified ?? 0,
			artifactIssues,
			browserIdentities: coherence.browserIdentities,
			integrityIssues: Object.freeze(integrityIssues),
			artifactsUnverified: input.artifacts === undefined,
		},
		tests,
		rejectedRecords: rejected,
		notes,
		exitCode,
	});
}
