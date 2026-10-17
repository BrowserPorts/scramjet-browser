/**
 * Evidence qualification.
 *
 * A raw pass says the subject's assertions held. A *qualified* pass additionally
 * requires the evidence that ties that observation to this test, this lane and
 * this browser: the per-attempt nonce echoed from the page, host-side route
 * instrumentation for a candidate lane, and an owner attestation when the suite
 * declares one. A globally configured flag proves nothing about an individual
 * test, so nothing here reads run-level configuration as evidence.
 *
 * Missing evidence never converts a failure into a pass, and it never disappears
 * into a footnote: it downgrades the pass and changes the exit code.
 *
 * What the route requirement actually asserts: for `local-http`, the host saw the
 * request it was expecting arrive on a stream the candidate transport accepted.
 * That is a recorded observation by Runway's own fixture, not an authenticity
 * proof — nothing here is signed, and a `matchedTarget` observation says the
 * traffic took the route this process watched, not that no other path exists.
 * `remote-stream` proves connectivity only and never satisfies the requirement.
 */
import type { LaneId, TestId } from "./ids.ts";
import { CAPABILITIES, type InventoryEntry } from "./inventory.ts";
import { isRawPass, isExecuted } from "./outcome.ts";
import type { LanePlan } from "./plan.ts";
import { isValidRouteInstrumentation, type RunEvent, type TerminalRecord } from "./protocol.ts";

export type EvidenceRequirement = {
	readonly nonceEcho: boolean;
	readonly hostOwned: boolean;
	readonly ownerSignal: boolean;
	readonly routeInstrumentation: boolean;
	readonly explicitBrowser: boolean;
};

/**
 * What a pair can miss.
 *
 * `eligiblePlan` is not per-pair evidence: it is the run-level configuration
 * gate. It is part of this union because it has the same consequence as a missing
 * nonce — the raw pass stands, the qualified pass does not.
 *
 * `admissionIntegrity` is the same shape of fact, narrowed to the pairs it really
 * touched: the run could not close this pair's admissions, so it cannot say whether
 * the record it holds was written before or after the pair lost its claim. The raw
 * observation is kept exactly as recorded; what is withdrawn is the run's
 * *vouching* for it.
 */
export type QualificationRequirementKey =
	| keyof EvidenceRequirement
	| "eligiblePlan"
	| "admissionIntegrity";

export type QualificationMiss = {
	readonly requirement: QualificationRequirementKey;
	readonly detail: string;
};

/** The run-level eligibility facts, as decided when the plan was created. */
export type PlanEligibility = {
	readonly conformanceEligible: boolean;
	readonly ineligibilityReasons: readonly string[];
};

export type Qualification = {
	/** True only for a raw pass with every required piece of evidence present. */
	readonly qualified: boolean;
	readonly misses: readonly QualificationMiss[];
	readonly requirement: EvidenceRequirement;
};

/**
 * Requirements for one (test, lane) pair.
 *
 * Declared per test and per lane role, so a proxy regression test is not asked
 * for runtime-owner metadata it has no use for.
 */
export function requirementsFor(
	entry: InventoryEntry,
	lane: LanePlan
): EvidenceRequirement {
	const browserTest = entry.requiredCapabilities.includes(CAPABILITIES.browser);
	const wantsOwner = entry.requiredCapabilities.includes(CAPABILITIES.ownerSignal);
	const wantsRoute = entry.requiredCapabilities.includes(CAPABILITIES.proxyRoute);
	const playwright = entry.requiredCapabilities.includes(CAPABILITIES.playwrightControl);
	const verdict = entry.meta?.verdict;
	const hostVerdict = verdict === "host";
	/*
	 * A WPT case reports through upstream's own testharness callbacks, which never
	 * call the native suite's `__testPass`/`__testFail` bindings, so there is no
	 * nonce for it to echo and requiring one would make every WPT record permanently
	 * unqualifiable.
	 *
	 * Its attribution is a different fact, established host-side: the completion's
	 * binding call came from the exact Playwright frame the host designated before
	 * navigating, compared by object identity rather than by anything the page said.
	 * That check lives in the WPT adapter and is required there; it is not weakened
	 * by dropping a requirement the collector cannot satisfy.
	 *
	 * Scoped to this one execution mode on purpose. Native plugin, owner and route
	 * requirements below are untouched.
	 */
	const wptTestharness = entry.meta?.executionMode === "wpt-testharness";
	return {
		nonceEcho: browserTest && !playwright && !hostVerdict && !wptTestharness,
		hostOwned: hostVerdict,
		ownerSignal: wantsOwner && lane.role === "candidate",
		routeInstrumentation: wantsRoute && lane.role === "candidate",
		explicitBrowser: browserTest,
	};
}

/** Applies the requirements to one recorded terminal outcome. */
export function qualifyRecord(
	record: TerminalRecord,
	requirement: EvidenceRequirement
): Qualification {
	const misses: QualificationMiss[] = [];
	const executed = isExecuted(record.outcome);

	if (requirement.nonceEcho && executed && !record.evidence.nonceEcho) {
		misses.push({
			requirement: "nonceEcho",
			detail:
				"the page result did not echo this attempt's nonce, so it cannot be " +
				"attributed to this test and lane",
		});
	}
	if (requirement.hostOwned && executed && !record.evidence.hostOwned) {
		misses.push({
			requirement: "hostOwned",
			detail:
				"the host verdict was not produced by this attempt's fixture instance",
		});
	}
	if (requirement.ownerSignal && record.evidence.ownerSignal !== "verified") {
		misses.push({
			requirement: "ownerSignal",
			detail: `owner attestation is ${record.evidence.ownerSignal}; this suite requires a verified owner signal`,
		});
	}
	if (requirement.routeInstrumentation) {
		const route = record.evidence.routeInstrumentation;
		if (!route) {
			misses.push({
				requirement: "routeInstrumentation",
				detail: "no host-side route observation was recorded for the candidate lane",
			});
		} else if (!isValidRouteInstrumentation(route)) {
			// Qualification is a boundary in its own right: a caller may hand it a
			// record it built rather than one read back through the protocol
			// validator, and a malformed observation is not an observation.
			misses.push({
				requirement: "routeInstrumentation",
				detail:
					"the recorded route observation is malformed (unknown mode, non-boolean " +
					"match, or a counter that is not a non-negative integer), so it proves " +
					"nothing about the candidate route",
			});
		} else if (route.mode === "remote-stream") {
			misses.push({
				requirement: "routeInstrumentation",
				detail:
					"remote-stream is transport connectivity only and never satisfies proxyRoute; " +
					"remote HTTP proof is not implemented",
			});
		} else if (!route.matchedTarget) {
			misses.push({
				requirement: "routeInstrumentation",
				detail:
					`candidate route was not proven (accepted streams to target: ` +
					`${route.acceptedStreamsToTarget}, HTTP on those streams for the expected ` +
					`URL: ${route.httpOnAcceptedStream}, unmatched HTTP: ${route.unmatchedHttp}, ` +
					`handshakes: ${route.handshakeUpgrades}; handshake and idle TCP are not a route proof)`,
			});
		}
	}
	if (requirement.explicitBrowser && !record.provenance.browser.explicitlySelected) {
		misses.push({
			requirement: "explicitBrowser",
			detail:
				"the browser binary was not explicitly selected, so this result records " +
				"what ran but is not conformance evidence",
		});
	}

	return {
		qualified: isRawPass(record.outcome) && misses.length === 0,
		misses,
		requirement,
	};
}

/**
 * Misses that apply to every pair in a run the plan already declared ineligible.
 *
 * Diagnostic modes exist — a certificate bypass makes a TLS fixture reachable, an
 * unselected browser makes a first run easy — and they are legitimate for
 * debugging. What they cannot do is produce evidence: a run that disabled
 * certificate verification observed a subject the deployed configuration would
 * never have reached, so its passes describe this diagnostic setup and nothing
 * else. The reasons come from the plan, which decided them before anything ran.
 */
export function planEligibilityMisses(
	plan: PlanEligibility
): readonly QualificationMiss[] {
	if (plan.conformanceEligible) return Object.freeze([]);
	const reasons =
		plan.ineligibilityReasons.length > 0
			? plan.ineligibilityReasons
			: ["the plan is marked ineligible for conformance evidence"];
	return Object.freeze(
		reasons.map((reason) => ({
			requirement: "eligiblePlan" as const,
			detail:
				`${reason}. Results from this run are recorded observations, not ` +
				"conformance evidence, so no pass in it can be qualified.",
		}))
	);
}

/**
 * The `details.code` a run writes on the diagnostic that reports this fault.
 *
 * One constant, used by the writer in `run.ts` and by {@link admissionIntegrityFaults}
 * that reads it back, so the live log and a later offline comparison agree by
 * construction rather than by two copies of a string.
 */
export const ADMISSION_INTEGRITY_CODE = "admission/integrity-fault";

/** One pair whose admissions the run could not close, and why. */
export type AdmissionIntegrityFault = {
	readonly testId: TestId;
	readonly laneId: LaneId;
	readonly detail: string;
};

/**
 * Reads admission-integrity faults back out of a run's own diagnostics.
 *
 * Deliberately built on the diagnostic events that already exist, already carry
 * `testId` and `laneId`, and are already validated by the record schema. There is
 * no second log, no side-channel and no in-memory-only state: a run that reported
 * the fault reports it to `runway compare` a week later in exactly the same words.
 *
 * A diagnostic that names the code but not a pair is ignored rather than widened
 * to the whole run — this gate is narrow on purpose, and a malformed report of it
 * must not become a reason to disqualify pairs it never named.
 */
export function admissionIntegrityFaults(
	events: readonly RunEvent[]
): readonly AdmissionIntegrityFault[] {
	const faults: AdmissionIntegrityFault[] = [];
	for (const event of events) {
		if (event.type !== "diagnostic") continue;
		if (event.details?.code !== ADMISSION_INTEGRITY_CODE) continue;
		if (event.testId === undefined || event.laneId === undefined) continue;
		faults.push(
			Object.freeze({
				testId: event.testId,
				laneId: event.laneId,
				detail: event.message,
			})
		);
	}
	return Object.freeze(faults);
}

/** The miss an admission-integrity fault produces. Never converts a failure into a pass. */
export function admissionIntegrityMiss(detail: string): QualificationMiss {
	return Object.freeze({
		requirement: "admissionIntegrity" as const,
		detail:
			`${detail} The recorded outcome stands as a raw observation, but this run ` +
			"cannot vouch for when it was admitted, so it is not a qualified pass.",
	});
}

/**
 * Qualifies one pair against both gates: the evidence the pair itself owes, and
 * the eligibility of the run it belongs to.
 *
 * This is the function comparison uses, so plan-level ineligibility cannot be
 * reduced to a footnote on an otherwise green report.
 */
export function qualifyPair(
	record: TerminalRecord,
	entry: InventoryEntry,
	lane: LanePlan,
	plan: PlanEligibility
): Qualification {
	const requirement = requirementsFor(entry, lane);
	const base = qualifyRecord(record, requirement);
	const planMisses = planEligibilityMisses(plan);
	if (planMisses.length === 0) return base;
	const misses = Object.freeze([...base.misses, ...planMisses]);
	return { qualified: false, misses, requirement };
}
