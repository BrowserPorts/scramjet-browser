/**
 * WPT case execution, as a canonical suite adapter.
 *
 * Shaped after `suites/native-execute.ts` and subject to the same rules: the
 * canonical browser owner, scheduler, recorder and verification layers are the only
 * things that execute, schedule, record and qualify. This module opens attempts on
 * lanes the run hands it, converts what upstream's harness reported, and emits
 * records through the run's own `emit`. It launches no browser, owns no Playwright
 * object, and has no reporting channel of its own.
 *
 * ## The integration this adapter cannot fake
 *
 * A WPT case needs one thing the native suite does not: **host-established frame
 * attribution**. The collector's init script runs in every frame and the binding is
 * exposed to every frame, so a fixture's helper iframe runs the same collector as the
 * case document and can complete first. Deciding which completion belongs to the
 * case is therefore a host obligation, and it needs three things the current `Lane`
 * contract does not expose:
 *
 * 1. a **case frame designated before navigation**, which under a proxy lane is the
 *    guest frame, not the outer controller page;
 * 2. the **Playwright binding source** (`source.frame` / `source.page`) for each
 *    arrival, compared against that designated frame;
 * 3. the **route owner's** mapping from the expected logical URL to the physical
 *    URL actually loaded, which under a proxy lane are different strings.
 *
 * None of those can be derived inside this adapter. A guest-reported flag is a
 * guest claim; a URL in the payload is page-controlled; and a same-origin or
 * basename comparison would either reject every proxied case or accept an unrelated
 * document. So the adapter *requires* them as a typed input — see
 * {@link WptHostAttachment} — and refuses to produce a record without them.
 */
import type { InventoryEntry } from "../../core/inventory.ts";
import { createNonce, type LaneId, type Nonce, type TestId } from "../../core/ids.ts";
import type { Lane, LaneAttempt, PluginAssertionReport } from "../../lanes/lane.ts";
import type { TerminalOutcome } from "../../core/outcome.ts";
import { serializeError } from "../../core/errors.ts";
import { ADMISSION_INTEGRITY_CODE } from "../../core/verification.ts";
import type {
	BrowserProvenance,
	FixtureProvenance,
	LaneEvidence,
	SourcePortProvenance,
	SubtestRecord,
	TerminalRecord,
} from "../../core/protocol.ts";
import {
	collectorInitScript,
	convertHarnessCompletion,
	parseRawHarnessRecord,
	runnerTimeoutOutcome,
	type HarnessAdmissionEvidence,
	type HarnessConversion,
} from "./harness.ts";
import { caseUrl } from "./inventory.ts";
import { combinePluginReports, type CombinedPluginAssertions } from "../native-execute.ts";
import { assertExecutable } from "./suite.ts";

/** Record shape the run's recorder accepts, minus the fields it assigns itself. */
export type WptTerminalRecordInput = Omit<
	TerminalRecord,
	"protocolVersion" | "runId" | "planHash" | "sequence"
>;

/**
 * One attempt's host-side attribution, supplied by the run.
 *
 * Every field is a *host* observation. Nothing here may be derived from the page.
 */
export type WptHostAttachment = {
	/**
	 * Designates the case frame **before** navigation and installs the collector.
	 *
	 * The returned handle is what later arrivals are compared against. Designation
	 * has to happen first: a frame chosen after the fact is chosen using information
	 * the page has already had a chance to influence.
	 *
	 * The implementer decides which frame that is. On a reference lane it is normally
	 * the page's main frame; on a proxy lane it is the guest frame the controller
	 * created, *not* the outer controller document.
	 */
	readonly designateCaseFrame: (request: {
		readonly attempt: LaneAttempt;
		readonly lane: Lane;
		/** Init script the host must install in the context before navigating. */
		readonly initScript: string;
		/** Logical (upstream) URL this attempt intends to load. */
		readonly logicalUrl: string;
	}) => Promise<WptCaseFrame>;
};

export type WptCaseFrame = {
	/** Host's identifier for the designated frame. Diagnostic only. */
	readonly caseFrameId: string;
	/**
	 * Navigates the designated frame to the case and returns the physical URL.
	 *
	 * Under a proxy lane the physical URL is the rewritten one; the route owner knows
	 * the mapping, this adapter does not.
	 */
	readonly navigate: (logicalUrl: string) => Promise<{ readonly physicalUrl: string }>;
	/**
	 * Waits for the next completion payload the host's binding received.
	 *
	 * Resolves with the raw JSON payload **and** the host's evidence about the frame
	 * it arrived from. Resolves `null` when the host has closed the channel — which
	 * the adapter treats as the host giving up, not as a deadline.
	 *
	 * Upstream calls its completion callback once per document, so one arrival from
	 * the designated frame is the whole result. Arrivals from any other frame are the
	 * host's to refuse before they are ever queued.
	 */
	readonly nextCompletion: (signal: AbortSignal) => Promise<WptArrival | null>;
	/**
	 * Why no completion could be collected, when the host knows.
	 *
	 * `null` means the host has nothing to add and a missing completion really is a
	 * missing completion. A non-null reason — an oversized payload, a second
	 * completion — is a collection failure, and the adapter records it as one
	 * instead of as a deadline.
	 */
	readonly collectionFault: () => string | null;
	readonly dispose: () => Promise<void>;
};

export type WptArrival = {
	readonly payload: string;
	readonly admission: HarnessAdmissionEvidence;
};

export type WptExecutionContext = {
	readonly entry: InventoryEntry;
	/**
	 * The harness timeout this case was *planned* with, from the plan's snapshot.
	 *
	 * Taken from the plan rather than recomputed from a live manifest: the manifest
	 * on disk can be regenerated or edited between planning and execution, and a
	 * case that runs under a different timeout than the one recorded is a case the
	 * run cannot honestly report. `null` means upstream recorded no timeout extra.
	 */
	readonly harnessTimeoutMs: number | null;
	readonly lanes: readonly Lane[];
	readonly signal: AbortSignal;
	readonly defaultDeadlineMs: number;
	/** Origin of the running upstream wptserve, read back from its socket. */
	readonly serverOrigin: string;
	readonly browserProvenance: BrowserProvenance;
	readonly fixtureProvenance: readonly FixtureProvenance[];
	readonly sourcePort?: SourcePortProvenance;
	/** Host attribution. Required: see the module comment. */
	readonly host: WptHostAttachment;
	readonly emit: (record: WptTerminalRecordInput) => Promise<void>;
	/**
	 * Emits a run diagnostic.
	 *
	 * The shape is not free-form. `core/verification.ts` `admissionIntegrityFaults()`
	 * reads faults back out of the run's own diagnostic events, and it requires
	 * **`testId` and `laneId` at the top level of the event** plus
	 * `details.code === ADMISSION_INTEGRITY_CODE`; an event that names the code but
	 * not a pair is deliberately ignored rather than widened to the whole run. So the
	 * ids travel as their own fields here and are *not* buried in `details`, because a
	 * fault reported the wrong way is a fault that silently disqualifies nothing.
	 *
	 * The implementer must forward these to `recorder.diagnostic` unchanged.
	 */
	readonly diagnostic: (input: WptDiagnosticInput) => Promise<void>;
};

export type WptDiagnosticInput = {
	readonly level: "info" | "warning" | "error";
	readonly message: string;
	/** Top level, as the fault reader requires. */
	readonly testId: TestId;
	/** Top level, as the fault reader requires. */
	readonly laneId: LaneId;
	readonly details?: Readonly<Record<string, unknown>>;
};

function nowIso(): string {
	return new Date().toISOString();
}

function baseEvidence(overrides: Partial<LaneEvidence> = {}): LaneEvidence {
	return Object.freeze({
		nonceEcho: false,
		ownerSignal: "notRequired",
		resultChannel: "page",
		hostOwned: false,
		artifacts: Object.freeze([]),
		truncations: Object.freeze([]),
		...overrides,
	});
}

/**
 * Emits one terminal record per planned lane without opening anything.
 *
 * Used for inventory-only and refused cases: the run still gets exactly one record
 * per (test, lane) pair, so the denominator stays whole.
 */
async function emitForEveryLane(
	context: WptExecutionContext,
	outcome: TerminalOutcome,
	summary: string,
	lanes: readonly Lane[] = context.lanes
): Promise<void> {
	for (const lane of lanes) {
		const at = nowIso();
		await context.emit({
			testId: context.entry.testId as TestId,
			laneId: lane.laneId as LaneId,
			// A8: the same helper the lanes and the native suite use. No attempt is
			// opened on this path, but the record still carries a well-formed nonce
			// minted the one canonical way rather than a second ad-hoc UUID scheme.
			nonce: createNonce(),
			startedAt: at,
			finishedAt: at,
			durationMs: 0,
			outcome,
			summary,
			evidence: baseEvidence(),
			provenance: {
				browser: context.browserProvenance,
				lane: lane.provenance,
				fixtures: context.fixtureProvenance,
				...(context.sourcePort === undefined ? {} : { sourcePort: context.sourcePort }),
			},
			requiredCapabilities: [...context.entry.requiredCapabilities],
		});
	}
}

/** Deadline for one case: the entry's, else the run default. */
function deadlineFor(context: WptExecutionContext): number {
	return context.entry.deadlineMs ?? context.defaultDeadlineMs;
}

/**
 * Runs one WPT case on every planned lane.
 *
 * Lanes are executed in sequence rather than concurrently: upstream fixtures share
 * server-side state (the stash, registrations, cookies) keyed by URL, so two lanes
 * loading the same case at the same time are not two independent observations. The
 * scheduler still owns concurrency *between* cases.
 */
export async function executeWptCase(context: WptExecutionContext): Promise<void> {
	/**
	 * R2: emits a diagnostic without ever letting it cost us the record.
	 *
	 * `context.diagnostic` reaches the recorder, and a recorder can fail. An
	 * unguarded call in the teardown or integrity path throws *before* `emit`, which
	 * loses the terminal result that was actually observed and abandons the remaining
	 * lanes. Reporting is best-effort; the record is not.
	 *
	 * The failure is never swallowed silently: it is counted, surfaced on the record
	 * as `selfReported.wpt.integrityFaultUnreported` when it was an integrity fault
	 * that went unreported, and re-reported to stderr as a last resort. This claims no
	 * durable-record guarantee — only that a reporting failure cannot erase an
	 * observation.
	 */
	const tryDiagnostic = async (
		input: WptDiagnosticInput,
		onFailure?: () => void
	): Promise<boolean> => {
		try {
			await context.diagnostic(input);
			return true;
		} catch (error) {
			onFailure?.();
			// Last resort, so a lost diagnostic is not invisible.
			process.stderr.write(
				`runway/wpt: a diagnostic could not be delivered for ${input.testId} on ` +
					`${input.laneId}: ${error instanceof Error ? error.message : String(error)}\n`
			);
			return false;
		}
	};

	// Gate first: inventory-only cases and short-denominator cases never reach a lane.
	const verdict = assertExecutable(context.entry);
	if (!verdict.executable) {
		for (const lane of context.lanes) {
			await tryDiagnostic({
				level: "info",
				message: `not executing ${context.entry.testId}`,
				testId: context.entry.testId as TestId,
				laneId: lane.laneId as LaneId,
				details: { outcome: verdict.outcome, reason: verdict.reason },
			});
		}
		await emitForEveryLane(context, verdict.outcome, verdict.reason);
		return;
	}

	const logicalUrl = String(context.entry.meta?.upstreamUrl ?? context.entry.localName);
	const target = caseUrl(context.serverOrigin, logicalUrl);
	const deadlineMs = deadlineFor(context);

	/*
	 * B1: cancellation is checked per lane, inside the loop.
	 *
	 * A single check before the loop only covers the first lane. Lanes run in
	 * sequence, so a run cancelled while lane 1 is executing would previously still
	 * open lane 2 and could record a pass for it — the run was over, and the record
	 * would say otherwise. The gate below therefore runs for every lane, after the
	 * abort listener is installed so there is no window between reading the flag and
	 * subscribing to it.
	 */
	for (const [laneIndex, lane] of context.lanes.entries()) {
		const startedAt = nowIso();
		const started = Date.now();

		// A3: the timer and the run's cancellation are distinct causes with distinct
		// outcomes, so they get distinct signals rather than one shared abort whose
		// reason has to be guessed afterwards.
		const controller = new AbortController();
		let deadlineReached = false;
		/**
		 * `deadlineReached` as it stood when the outcome was decided.
		 *
		 * The timer stays armed through teardown so it can still interrupt a hanging
		 * page hook, which means `deadlineReached` can flip *after* the classification
		 * above. The record must reflect the decision, not that later flip.
		 */
		let deadlineReachedAtDecision = false;
		const timer = setTimeout(() => {
			deadlineReached = true;
			controller.abort();
		}, deadlineMs);
		const onRunAbort = (): void => controller.abort();
		context.signal.addEventListener("abort", onRunAbort, { once: true });
		/** True when the run was cancelled, as opposed to this case timing out. */
		const runCancelled = (): boolean => context.signal.aborted;

		// B1: read the flag only after the listener is installed, so an abort that
		// lands between the two is still observed. A cancelled run opens no further
		// lane and records `cancelled` for this lane and every remaining one.
		if (runCancelled()) {
			clearTimeout(timer);
			context.signal.removeEventListener("abort", onRunAbort);
			await emitForEveryLane(
				context,
				"cancelled",
				laneIndex === 0
					? "the run was cancelled before this case started"
					: "the run was cancelled before this lane was opened",
				context.lanes.slice(laneIndex)
			);
			return;
		}

		// A8: minted once, outside the try, so the record carries this attempt's real
		// nonce on every path — including failures — instead of a second UUID that
		// corresponds to nothing.
		const nonce = createNonce();

		let attempt: LaneAttempt | null = null;
		let caseFrame: WptCaseFrame | null = null;
		let outcome: TerminalOutcome = "infrastructureError";
		let summary: string | null = null;
		let subtests: readonly SubtestRecord[] = [];
		let failure: ReturnType<typeof serializeError> | undefined;
		let evidence: LaneEvidence = baseEvidence();
		/** A1: set only when the ledger actually admitted a completion. */
		let admittedConversion: HarnessConversion | null = null;
		/**
		 * R3: a completion the ledger admitted only while sealing, after the loop had
		 * already given up (deadline, cancellation, or the host running dry).
		 *
		 * It is a real observation and is kept, but it is not a *credited* one: the
		 * attempt had already stopped waiting, so claiming `nonceEcho` for it would
		 * vouch for attribution the run did not actually stand behind at the time.
		 */
		/** R2: set when a diagnostic could not be delivered. */
		let integrityFaultUnreported = false;
		let diagnosticFailures = 0;
		let drainPending = 0;
		let drainFailure: string | null = null;
		/** Host-reported reason no completion could be collected. */
		let hostFault: string | null = null;
		/** Collector-reported terminal failure read off an in-frame arrival. */
		let terminalFault: string | null = null;
		/** The configured profile's own verifier report, when one was asked for. */
		let pluginAssertions: CombinedPluginAssertions | null = null;
		let evidenceSealed = false;
		let rejectedArrivalsTotal = 0;
		let malformedArrivalsTotal = 0;
		let suppressedDiagnosticsTotal = 0;

		try {
			attempt = await lane.openAttempt({
				testId: context.entry.testId as TestId,
				nonce,
				signal: controller.signal,
			});

			// The host designates the case frame and installs the collector BEFORE any
			// navigation. Both halves matter: a frame chosen afterwards was chosen with
			// information the page could already have influenced, and a collector
			// installed afterwards would miss upstream's registrars.
			caseFrame = await context.host.designateCaseFrame({
				attempt,
				lane,
				initScript: collectorInitScript(),
				// The authoritative logical case URL: absolute, on the server that is
				// actually serving it, with upstream's variant query preserved exactly.
				logicalUrl: target,
			});

			const navigation = await caseFrame.navigate(target);
			await tryDiagnostic({
				level: "info",
				message: `navigated ${context.entry.testId}`,
				testId: context.entry.testId as TestId,
				laneId: lane.laneId as LaneId,
				details: { logicalUrl, physicalUrl: navigation.physicalUrl },
			});

			/*
			 * A2: a malformed arrival is diagnosed and skipped, never thrown.
			 *
			 * `parseRawHarnessRecord` rejects anything that is not a well-formed
			 * completion. Letting that throw out of the loop would let any frame that can
			 * reach the binding — a helper iframe, a hostile child — terminate the case
			 * with one line of garbage. So each arrival is parsed in isolation and a
			 * failure only costs that arrival.
			 *
			 * Bounded on purpose: a child that streams garbage must not be able to hold
			 * the loop, the diagnostics or memory open indefinitely. The deadline already
			 * bounds wall-clock; these bound volume, and exhausting them is itself an
			 * observation worth recording rather than a silent give-up.
			 */
			/*
			 * Bound what is RETAINED, not how many arrivals are tolerated.
			 *
			 * Capping the number of rejections turned a helper frame into a denial of
			 * service: 50 junk messages and the real case frame's completion was never
			 * read. Waiting is already bounded by the deadline, so what actually needs
			 * bounding is memory and diagnostic volume. Past the cap the arrivals are
			 * still consumed and still offered to the ledger; only the per-arrival
			 * diagnostic is suppressed, and the suppressed count is reported in
			 * aggregate so nothing becomes invisible.
			 */
			const MAX_RETAINED_DIAGNOSTICS = 20;
			let rejectedArrivals = 0;
			let malformedArrivals = 0;
			let suppressedDiagnostics = 0;

			while (!controller.signal.aborted && admittedConversion === null) {
				const arrival = await caseFrame.nextCompletion(controller.signal);
				if (arrival === null) break;

				let parsed: ReturnType<typeof parseRawHarnessRecord>;
				try {
					parsed = parseRawHarnessRecord(arrival.payload);
				} catch (error) {
					malformedArrivals += 1;
					rejectedArrivals += 1;
					if (rejectedArrivals <= MAX_RETAINED_DIAGNOSTICS) {
						await tryDiagnostic({
							level: "warning",
							message: `discarded a malformed completion for ${context.entry.testId}`,
							testId: context.entry.testId as TestId,
							laneId: lane.laneId as LaneId,
							details: {
								reason: error instanceof Error ? error.message : String(error),
								// Host-observed source, so a malformed arrival can be traced to
								// the frame that sent it rather than just counted.
								caseFrameId: arrival.admission.caseFrameId,
								bindingSourceIsCaseFrame: arrival.admission.bindingSourceIsCaseFrame,
								observedLocation: arrival.admission.observedLocation,
								bytes: arrival.payload.length,
							},
						});
					} else {
						suppressedDiagnostics += 1;
					}
					// Cooperative yield: a host whose queue resolves synchronously would
					// otherwise starve the timer and the abort listener, so a flood could
					// outrun the deadline it is supposed to be bounded by.
					await new Promise((resolve) => setImmediate(resolve));
					continue;
				}

				/*
				 * A terminal collection failure, handled before conversion.
				 *
				 * The collector said it could not retain the completion. The host had
				 * already established this arrival came from the designated frame, and
				 * upstream reports once, so no later arrival can fix it: waiting on
				 * would only reach the deadline and report a timeout for a document that
				 * did report. Foreign-frame arrivals are refused by the host and never
				 * reach here.
				 *
				 * The envelope carries no status, location or subtests, so there is
				 * nothing to convert and nothing that could be read as a result.
				 */
				if (parsed.collectionOverflow) {
					terminalFault =
						`the page's completion exceeded the collector's budget (${parsed.retainedUnits} ` +
						`unit(s) retained of ${parsed.reportedSubtests} reported subtest(s))`;
					break;
				}

				/*
				 * The host already refused anything that did not come from the designated
				 * frame, so conversion is the remaining check: it refuses a completion the
				 * host could not attribute, a duplicate, or one whose upstream numbers do
				 * not parse. A refusal leaves the attempt OPEN so a later, real completion
				 * from the case frame can still decide it.
				 */
				let converted: HarnessConversion | null = null;
				let refusal: string | null = null;
				try {
					converted = convertHarnessCompletion(parsed, {
						admission: arrival.admission,
						...(controller.signal.aborted ? { aborted: true } : {}),
					});
				} catch (error) {
					refusal = error instanceof Error ? error.message : String(error);
				}
				if (converted !== null) {
					admittedConversion = converted;
					break;
				}
				rejectedArrivals += 1;
				// A rejected arrival is diagnosed and the attempt stays OPEN, so the real
				// case frame's completion can still be admitted afterwards. A helper frame
				// completing first must not decide this case.
				if (rejectedArrivals <= MAX_RETAINED_DIAGNOSTICS) {
					await tryDiagnostic({
						level: "warning",
						message: `refused a completion for ${context.entry.testId}`,
						testId: context.entry.testId as TestId,
						laneId: lane.laneId as LaneId,
						details: {
							reason: refusal,
							observedLocation: arrival.admission.observedLocation,
							caseFrameId: arrival.admission.caseFrameId,
							bindingSourceIsCaseFrame: arrival.admission.bindingSourceIsCaseFrame,
						},
					});
				} else {
					suppressedDiagnostics += 1;
				}
				await new Promise((resolve) => setImmediate(resolve));
			}

			rejectedArrivalsTotal = rejectedArrivals;
			malformedArrivalsTotal = malformedArrivals;
			suppressedDiagnosticsTotal = suppressedDiagnostics;
			// Read once, after the loop: a completion the host could not retain is a
			// different fact from a document that never reported.
			hostFault = caseFrame.collectionFault() ?? terminalFault;

			if (admittedConversion !== null) {
				outcome = admittedConversion.outcome;
				summary =
					admittedConversion.diagnostics.length === 0
						? admittedConversion.summary
						: `${admittedConversion.summary} | ${admittedConversion.diagnostics.join(" | ")}`;
				subtests = admittedConversion.subtests;
			} else if (runCancelled()) {
				// A3: the run was cancelled. Not a deadline, and not the subject's fault.
				outcome = "cancelled";
				summary = `the run was cancelled while ${context.entry.testId} was running`;
			} else if (hostFault !== null) {
				/*
				 * The host has a reason, so this is not a deadline.
				 *
				 * An oversized or excess completion is a collection failure about a
				 * document that did report. Calling it a timeout hid real subtest
				 * failures behind a missing-result verdict.
				 */
				outcome = "invalidRecord";
				summary = `the completion could not be collected: ${hostFault}`;
			} else if (deadlineReached) {
				const timedOut = runnerTimeoutOutcome({
					deadlineMs,
					harnessTimeoutMs: context.harnessTimeoutMs,
					location: navigation.physicalUrl,
				});
				outcome = timedOut.outcome;
				summary =
					malformedArrivals === 0
						? timedOut.summary
						: `${timedOut.summary} | ${malformedArrivals} malformed arrival(s) were discarded`;
				subtests = timedOut.subtests;
			} else {
				/*
				 * A3: neither cancelled nor timed out, and still no completion. The host
				 * stopped producing arrivals of its own accord, which is a fault in the
				 * integration rather than a deadline the case reached. Reporting a
				 * timeout here would invent a deadline that never expired.
				 */
				outcome = "infrastructureError";
				summary =
					rejectedArrivals > 0
						? `the host stopped delivering completions after ${rejectedArrivals} unusable ` +
							`arrival(s) (${malformedArrivals} malformed), before any could be admitted`
						: "the host stopped delivering completions before the deadline and before any " +
							"completion could be admitted";
			}
		} catch (error) {
			// A3: a rejection from `nextCompletion` (or anything else) is classified by
			// the cause that actually applies, not assumed to be a deadline.
			if (runCancelled()) {
				outcome = "cancelled";
				summary = `the run was cancelled while ${context.entry.testId} was running`;
			} else if (deadlineReached) {
				const timedOut = runnerTimeoutOutcome({
					deadlineMs,
					harnessTimeoutMs: context.harnessTimeoutMs,
					location: null,
				});
				outcome = timedOut.outcome;
				summary = timedOut.summary;
			} else {
				outcome = "infrastructureError";
				summary = error instanceof Error ? error.message : String(error);
			}
			failure = serializeError(error);
		} finally {
			/*
			 * The deadline stays ARMED across this block.
			 *
			 * Everything below can await the page — draining, the configured plugin
			 * assertions, disposal — and the lane bounds those awaits by racing this
			 * attempt's signal, which only the timer and the forwarded run-abort can
			 * trip. Clearing them here, as this block used to, disarmed the only thing
			 * that could interrupt a hanging verifier: it would then block disposal and
			 * the record indefinitely, with run cancellation no longer forwarded. They
			 * are torn down in the inner `finally` below, after the last await.
			 *
			 * The classification inputs are snapshotted first so a timer that fires
			 * *during* teardown cannot retroactively rewrite the outcome that was
			 * already decided above.
			 */
			deadlineReachedAtDecision = deadlineReached;
			try {
			/*
			 * A4/B2: sealing and draining happen on EVERY path, including failures, and a
			 * failure to do so is an explicit fault rather than silence.
			 */
			if (attempt !== null) {
				try {
					attempt.sealAdmissions();
					const drained = await attempt.drainAdmissions(
						// Draining must not inherit an already-aborted signal, or it would
						// give up immediately on exactly the paths it exists to settle.
						AbortSignal.timeout(Math.min(deadlineMs, 5_000))
					);
					drainPending = drained.pending;
					/*
					 * Evidence, reported as observed.
					 *
					 * `nonceEcho` stays false: a WPT case reports through upstream's
					 * testharness callbacks and never calls the native suite's
					 * `__testPass`/`__testFail` bindings, so no nonce is ever echoed. It is
					 * not set true from an admitted completion — attribution here is the
					 * host's frame identity, which is a different fact and is required
					 * separately by `requirementsFor`.
					 */
					const laneEvidence = attempt.evidence();
					evidence = Object.freeze({
						...laneEvidence,
						nonceEcho: false,
						artifacts: Object.freeze([]),
						truncations: Object.freeze([]),
					});
					evidenceSealed = true;
				} catch (error) {
					// B2: a seal/drain throw is an integrity failure in its own right. It
					// must not fall through to the default `baseEvidence()`, whose
					// `nonceEcho: false` would read as "the page never echoed the nonce"
					// rather than "this run could not close the attempt".
					drainFailure = drainFailure ?? (error instanceof Error ? error.message : String(error));
				}
			}

			/*
			 * Configured plugin assertions, before anything is disposed.
			 *
			 * The same contract the native suite uses, and the same policy: this is a
			 * page self-report that can only *fail* an attempt, never satisfy an owner
			 * receipt. Skipping it on the WPT path meant a profile that declares a
			 * verifier could not fail a WPT case at all, so a candidate case could pass
			 * while its plugin assertions were violated or unavailable.
			 *
			 * Called once with the case's own logical URL. WPT drives the case frame
			 * directly rather than through the lane's navigate hook, so
			 * `attempt.navigations()` is empty here; the target is passed explicitly
			 * because the API already takes one, rather than fabricating a navigation
			 * entry the attempt never made.
			 *
			 * `verifyPluginAssertions` is bounded by the attempt's own deadline inside
			 * the lane, so this cannot outlive the attempt or hang teardown; a rejection
			 * is caught and degraded to `unavailable` exactly as the native path does.
			 */
			if (attempt !== null) {
				// The absolute logical case URL — the same shape the native suite passes
				// from `navigations()`, and what a verifier can compare against the
				// requests it actually routed. Not the rewritten physical URL, which is
				// the proxy's address for it rather than the target under test.
				const verifyTarget = target;
				const verifier = attempt;
				const report: PluginAssertionReport = await verifier
					.verifyPluginAssertions(verifyTarget)
					.catch(
						(cause: unknown): PluginAssertionReport => ({
							status: "unavailable",
							failures: [],
							unavailableReason: cause instanceof Error ? cause.message : String(cause),
							expectation: verifier.pluginVerifierExpectation(),
							invoked: [],
							target: verifyTarget,
						})
					);
				pluginAssertions = combinePluginReports([report]);
				// Only a pass is downgraded: a real upstream failure stays that failure,
				// and its raw subtests are untouched.
				if (report.status === "violated" && outcome === "pass") {
					outcome = "pluginError";
					summary = `configured plugin assertions failed: ${report.failures
						.map((entry) => `${entry.module ?? "plugin"}: ${entry.message}`)
						.join("; ")}`;
					failure = { message: summary };
				} else if (report.status === "unavailable" && outcome === "pass") {
					outcome = "pluginError";
					summary = `the configured plugin assertions could not be evaluated: ${report.unavailableReason ?? "unknown reason"}`;
					failure = { message: summary };
				}
			}

			// Teardown failures are reported and never allowed to change the observed
			// outcome: a secondary cleanup fault must not turn a real failure green, nor
			// a real pass into an infrastructure error.
			for (const [what, dispose] of [
				["case frame", () => caseFrame?.dispose()],
				["lane attempt", () => attempt?.dispose()],
			] as const) {
				try {
					await dispose();
				} catch (error) {
					// R2: guarded. A failing diagnostic here must not throw past the record.
					await tryDiagnostic(
						{
							level: "warning",
							message: `disposing the ${what} failed`,
							testId: context.entry.testId as TestId,
							laneId: lane.laneId as LaneId,
							details: { reason: error instanceof Error ? error.message : String(error) },
						},
						() => {
							diagnosticFailures += 1;
						}
					);
				}
			}

			/*
			 * Final read, AFTER acceptance closed.
			 *
			 * `dispose()` stops acceptance synchronously, so a fault raised by a callback
			 * that landed during teardown is recorded by then. Reading before dispose
			 * would miss exactly those.
			 */
			const finalFault = caseFrame?.collectionFault() ?? hostFault;
			if (finalFault !== null) {
				hostFault = finalFault;
				if (outcome === "pass") {
					/*
					 * A pass cannot stand on a completion the host could not fully collect.
					 * The raw subtests are kept — they are upstream's own observations — but
					 * the verdict is downgraded rather than reported as a qualified pass.
					 */
					outcome = "invalidRecord";
					summary =
						summary === null
							? `the completion could not be fully collected: ${finalFault}`
							: `${summary} | the completion could not be fully collected: ${finalFault}`;
				} else if (summary === null) {
					summary = `the completion could not be fully collected: ${finalFault}`;
				} else if (!summary.includes(finalFault)) {
					// Already a failure: the outcome stands and the fault is a diagnostic.
					summary = `${summary} | ${finalFault}`;
				}
			}
			} finally {
				/*
				 * A3: the last thing this case owns. Runs on every path — including a
				 * throw anywhere in the block above — so no timer and no listener
				 * survives the attempt, and nothing can abort a signal nobody is
				 * waiting on any more.
				 */
				clearTimeout(timer);
				context.signal.removeEventListener("abort", onRunAbort);
			}
		}

		/*
		 * B2/B3: integrity gates, applied after the seal and before the record is written.
		 *
		 * Each of these means the run cannot vouch for the result it holds, so each
		 * follows the canonical native policy — `suites/native-execute.ts` downgrades a
		 * pass with work still in flight rather than reporting it — and each emits the
		 * fault in the exact shape `admissionIntegrityFaults()` reads: the code in
		 * `details.code`, and `testId`/`laneId` at the TOP LEVEL of the event.
		 *
		 * The raw upstream observation is preserved throughout: `subtests` keep
		 * upstream's own statuses and numbers, and the counts are recorded separately in
		 * `selfReported` rather than overwriting what the harness reported.
		 */
		const integrityFaults: string[] = [];
		if (drainFailure !== null) {
			integrityFaults.push(`this attempt's admissions could not be closed: ${drainFailure}`);
		}
		if (drainPending > 0) {
			integrityFaults.push(
				`${drainPending} admission(s) opened by this attempt had not settled when it closed`
			);
		}

		if (integrityFaults.length > 0) {
			const detail = integrityFaults.join("; ");
			/*
			 * R1: classify by the cause that actually applies.
			 *
			 * Calling every fault a timeout was wrong. A timeout is a statement that a
			 * bound expired, and only the pending-settlement fault is that: callbacks
			 * were admitted before the seal and had not settled when the real bound ran
			 * out. The others are not about time at all —
			 *
			 * - a *duplicate* completion from the designated case frame means the record
			 *   we hold does not describe the document's only completion. The payload was
			 *   well-formed and the attempt was not cut short; what is wrong is the
			 *   record's claim to be the result. `invalidRecord` is the existing term for
			 *   exactly that, and the taxonomy already treats it as infrastructural and
			 *   never a pass.
			 * - a *seal failure* is this runner being unable to close the attempt. Nothing
			 *   expired and the subject did nothing wrong: it is a fault in the runner or
			 *   the host, which is `infrastructureError`.
			 *
			 * Precedence: cancellation first, because a cancelled run explains every
			 * subsequent fault and is the operator's action rather than an observation
			 * about the case. Then the deadline, but only when it genuinely expired.
			 * Then the specific cause. A non-pass keeps the outcome it earned — an
			 * integrity fault never rewrites a failure into something else.
			 */
			/*
			 * Precedence, most specific first.
			 *
			 * `overflow` and `unreconciled` are both data-loss about the case's own
			 * result rather than statements about time, so they classify as
			 * `invalidRecord` alongside a duplicate: the record we hold is not a
			 * faithful account of what the document reported.
			 */
			let faultCause: "pending" | "duplicate" | "seal" | "overflow" | "unreconciled" | null =
				null;
			if (drainPending > 0) faultCause = "pending";
			else if (drainFailure !== null) faultCause = "seal";

			if (outcome === "pass") {
				if (runCancelled()) {
					// The run ending is the dominant explanation, whatever else is true.
					outcome = "cancelled";
				} else if (faultCause === "pending") {
					// A bound really did expire with work still in flight.
					outcome = deadlineReachedAtDecision ? "timeout" : "infrastructureError";
				} else {
					outcome = "infrastructureError";
				}
				summary = summary === null ? detail : `${detail} | prior summary: ${summary}`;
				failure = failure ?? { message: detail };
			} else {
				summary = summary === null ? detail : `${summary} | ${detail}`;
			}

			// R2: guarded, and its failure is surfaced on the record rather than lost.
			await tryDiagnostic(
				{
					level: "error",
					message: detail,
					// Top level, exactly as the fault reader requires.
					testId: context.entry.testId as TestId,
					laneId: lane.laneId as LaneId,
					details: {
						code: ADMISSION_INTEGRITY_CODE,
						cause: faultCause,
						drainPending,
						...(drainFailure === null ? {} : { drainFailure }),
					},
				},
				() => {
					diagnosticFailures += 1;
					// The offline collector reads faults out of diagnostics, so a fault that
					// could not be reported will not disqualify this pair there. Saying so on
					// the record is the only honest alternative to it vanishing.
					integrityFaultUnreported = true;
				}
			);
		}

		// Counts travel as self-reported data beside the record, never folded into the
		// upstream statuses they sit next to.
		const selfReported: Record<string, unknown> = {
			wpt: {
				rejectedArrivals: rejectedArrivalsTotal,
				malformedArrivals: malformedArrivalsTotal,
				suppressedDiagnostics: suppressedDiagnosticsTotal,
				drainPending,
				evidenceSealed,
				...(hostFault === null ? {} : { collectionFault: hostFault }),
				diagnosticFailures,
				integrityFaultUnreported,
			},
			// Recorded as what it is: the profile's own verifiers reporting on
			// themselves. It can explain a `pluginError`; it can never qualify a pass.
			...(pluginAssertions
				? {
						pluginAssertions: {
							status: pluginAssertions.status,
							failures: pluginAssertions.failures,
							...(pluginAssertions.unavailableReason === undefined
								? {}
								: { unavailableReason: pluginAssertions.unavailableReason }),
							targets: pluginAssertions.reports.map((report) => ({
								target: report.target,
								status: report.status,
								invoked: report.invoked,
							})),
						},
					}
				: {}),
		};
		evidence = Object.freeze({ ...evidence, selfReported });

		const finishedAt = nowIso();
		await context.emit({
			testId: context.entry.testId as TestId,
			laneId: lane.laneId as LaneId,
			// A8: the attempt's own nonce, on every path.
			nonce,
			startedAt,
			finishedAt,
			durationMs: Date.now() - started,
			outcome,
			summary,
			...(failure === undefined ? {} : { failure }),
			...(subtests.length === 0 ? {} : { subtests }),
			evidence,
			provenance: {
				browser: context.browserProvenance,
				lane: lane.provenance,
				fixtures: context.fixtureProvenance,
				...(context.sourcePort === undefined ? {} : { sourcePort: context.sourcePort }),
			},
			requiredCapabilities: [...context.entry.requiredCapabilities],
		});
	}
}
