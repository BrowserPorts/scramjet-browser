/**
 * Native regression suite: execution.
 *
 * A test is executed across every planned lane as a unit, because the suite's
 * cross-lane consistency checks are a rendezvous between lanes and because the
 * fixture origin is shared. Each lane still produces exactly one terminal record,
 * and every way an attempt can end — setup failure, lane failure, timeout,
 * cancellation, plugin rejection — has its own outcome instead of being folded into
 * "the test failed".
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createNonce, type LaneId } from "../core/ids.ts";
import { RunwayError, serializeError } from "../core/errors.ts";
import { CAPABILITIES, type InventoryEntry } from "../core/inventory.ts";
import type { TerminalOutcome } from "../core/outcome.ts";
import type {
	ArtifactRef,
	BrowserProvenance,
	FixtureProvenance,
	LaneEvidence,
	SourcePortProvenance,
	TruncationNote,
} from "../core/protocol.ts";
import type { TerminalRecordInput } from "../core/recorder.ts";
import { createConsistencyBroker } from "../core/consistency.ts";
import type {
	Lane,
	LaneAttempt,
	LaneFailureLedger,
	PageResult,
	PluginAssertionFailure,
	PluginAssertionReport,
} from "../lanes/lane.ts";
import type { Fixture, FixtureTarget, NativeTest, ResultHooks } from "../testkit.ts";

export type NativeExecutionContext = {
	readonly entry: InventoryEntry;
	readonly test: NativeTest;
	/** Lanes planned for this test, already intersected with the run's lanes. */
	readonly lanes: readonly Lane[];
	readonly signal: AbortSignal;
	readonly defaultDeadlineMs: number;
	readonly browserProvenance: BrowserProvenance;
	readonly fixtureProvenance: readonly FixtureProvenance[];
	readonly sourcePort?: SourcePortProvenance;
	/** Root the run reserved for artifacts. */
	readonly artifactRoot: string;
	/** Run directory the recorded artifact paths are relative to. */
	readonly runDirectory: string;
	readonly pluginProfileName: string;
	/** Registers this attempt's fixture port so wisp streams can be matched to it. */
	readonly watchRoute?: (
		nonce: string,
		watch: import("../fixtures/route.ts").AttemptWatch
	) => void;
	readonly forgetRoute?: (nonce: string) => void;
	readonly emit: (record: TerminalRecordInput) => Promise<void>;
	readonly diagnostic: (
		level: "info" | "warning" | "error",
		message: string,
		details?: Readonly<Record<string, unknown>>
	) => Promise<void>;
};

type LaneOutcomeDraft = {
	readonly lane: Lane;
	readonly nonce: string;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly durationMs: number;
	outcome: TerminalOutcome;
	summary: string | null;
	failure?: ReturnType<typeof serializeError>;
	readonly evidence: LaneEvidence;
};

const EMPTY_EVIDENCE: LaneEvidence = Object.freeze({
	nonceEcho: false,
	ownerSignal: "notRequired",
	resultChannel: "page",
	hostOwned: false,
	artifacts: Object.freeze([]),
	truncations: Object.freeze([]),
});

export type AttemptSignal = {
	readonly source: "page" | "host";
	readonly result: PageResult;
};

export type SelectedAttempt = {
	readonly channel: "page" | "host";
	readonly hostOwned: boolean;
	readonly result: PageResult;
};

/**
 * Immutable selection of the attempt's terminal signal.
 *
 * A declared host verdict accepts a host pass only. A page pass cannot stand in
 * for that host verdict. A page fail still fails a host test. Later signals
 * cannot rewrite a frozen failure into a pass.
 */
export function selectAttemptResult(
	verdict: "page" | "host",
	signals: readonly AttemptSignal[]
): SelectedAttempt | null {
	let selected: SelectedAttempt | null = null;
	for (const signal of signals) {
		if (verdict === "host") {
			if (signal.source === "page" && signal.result.kind === "pass") continue;
			if (signal.source === "page" && signal.result.kind === "fail") {
				if (!selected || selected.result.kind === "pass") {
					selected = { channel: "page", hostOwned: false, result: signal.result };
				}
				continue;
			}
			if (signal.source === "host") {
				if (signal.result.kind === "fail") {
					selected = { channel: "host", hostOwned: true, result: signal.result };
					continue;
				}
				if (!selected) {
					selected = { channel: "host", hostOwned: true, result: signal.result };
				}
			}
			continue;
		}
		if (signal.source === "host" && signal.result.kind === "pass") continue;
		if (signal.source === "host" && signal.result.kind === "fail") {
			selected = { channel: "host", hostOwned: true, result: signal.result };
			continue;
		}
		if (!selected) {
			selected = {
				channel: signal.source,
				hostOwned: signal.source === "host",
				result: signal.result,
			};
		}
	}
	return selected;
}

/**
 * The plugin verification of one attempt: one report per navigated target.
 *
 * Verification is per navigation because a plugin's `verify({ testURL })` answers
 * about a URL, not about a test. A test that navigates twice therefore has two
 * reports, both of which must hold; the combined status is the worst of them and no
 * failure is dropped on the way.
 */
export type CombinedPluginAssertions = {
	readonly status: PluginAssertionReport["status"];
	readonly failures: readonly PluginAssertionFailure[];
	readonly unavailableReason?: string;
	readonly reports: readonly PluginAssertionReport[];
};

/** Worst-of, never best-of: an unchecked target cannot be covered by a checked one. */
export function combinePluginReports(
	reports: readonly PluginAssertionReport[]
): CombinedPluginAssertions {
	if (reports.length === 0) {
		return {
			status: "unavailable",
			failures: [],
			unavailableReason: "no navigation target was verified for this attempt",
			reports: [],
		};
	}
	const failures = reports.flatMap((report) => report.failures);
	const unavailable = reports.filter((report) => report.status === "unavailable");
	if (unavailable.length > 0) {
		return {
			status: "unavailable",
			failures,
			unavailableReason: unavailable
				.map(
					(report) =>
						`${report.target ?? "no navigation"}: ${report.unavailableReason ?? "unknown reason"}`
				)
				.join("; "),
			reports,
		};
	}
	if (reports.some((report) => report.status === "violated")) {
		return { status: "violated", failures, reports };
	}
	if (reports.some((report) => report.status === "satisfied")) {
		return { status: "satisfied", failures, reports };
	}
	return { status: "none", failures, reports };
}

/** Reads a numeric self-reported counter without trusting its presence. */
function counter(source: Readonly<Record<string, unknown>> | undefined, key: string): number {
	const value = source?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function attemptSelectionComplete(
	verdict: "page" | "host",
	selected: SelectedAttempt | null
): boolean {
	if (!selected) return false;
	if (verdict === "host") {
		return selected.channel === "host" || selected.result.kind === "fail";
	}
	return selected.channel === "page" || selected.result.kind === "fail";
}

/** Per-attempt artifact directory: one per test and lane, never shared. */
function attemptArtifactDirectory(
	context: NativeExecutionContext,
	entry: InventoryEntry,
	laneId: string
): string {
	return path.join(
		context.artifactRoot,
		entry.localName.replace(/[^a-zA-Z0-9._-]/g, "_"),
		laneId
	);
}

function metaString(entry: InventoryEntry, key: string): string | null {
	const value = entry.meta?.[key];
	return typeof value === "string" ? value : null;
}

function metaBoolean(entry: InventoryEntry, key: string): boolean {
	return entry.meta?.[key] === true;
}

function metaNumber(entry: InventoryEntry, key: string): number | null {
	const value = entry.meta?.[key];
	return typeof value === "number" ? value : null;
}

export async function executeNativeTest(context: NativeExecutionContext): Promise<void> {
	const { entry, test, lanes } = context;

	const record = (draft: LaneOutcomeDraft): TerminalRecordInput => ({
		testId: entry.testId,
		laneId: draft.lane.laneId,
		nonce: draft.nonce,
		startedAt: draft.startedAt,
		finishedAt: draft.finishedAt,
		durationMs: draft.durationMs,
		outcome: draft.outcome,
		summary: draft.summary,
		...(draft.failure ? { failure: draft.failure } : {}),
		evidence: draft.evidence,
		provenance: {
			browser: context.browserProvenance,
			lane: draft.lane.provenance,
			fixtures: context.fixtureProvenance,
			...(context.sourcePort ? { sourcePort: context.sourcePort } : {}),
		},
		requiredCapabilities: entry.requiredCapabilities,
	});

	const emitAll = async (
		outcome: TerminalOutcome,
		summary: string,
		failure?: ReturnType<typeof serializeError>
	): Promise<void> => {
		const at = new Date().toISOString();
		for (const lane of lanes) {
			await context.emit(
				record({
					lane,
					nonce: createNonce(),
					startedAt: at,
					finishedAt: at,
					durationMs: 0,
					outcome,
					summary,
					...(failure ? { failure } : {}),
					evidence: EMPTY_EVIDENCE,
				})
			);
		}
	};

	const unsupported = metaString(entry, "unsupportedReason");
	if (unsupported) {
		await emitAll("unsupported", unsupported);
		return;
	}
	if (!entry.executable) {
		await emitAll("notRun", entry.notRunReason ?? "the inventory marks this test as not executed");
		return;
	}
	if (context.signal.aborted) {
		await emitAll("cancelled", "the run was cancelled before this test started");
		return;
	}

	// ---- in-process tests --------------------------------------------------
	if (test.execution.kind === "node") {
		const startedAt = new Date();
		const nonce = createNonce();
		let outcome: TerminalOutcome = "pass";
		let summary: string | null = null;
		let failure: ReturnType<typeof serializeError> | undefined;
		try {
			await test.execution.fn({
				assert: (condition: unknown, message = "assertion failed") => {
					if (!condition) throw new Error(message);
				},
				assertEqual: (actual: unknown, expected: unknown, message = "values are not equal") => {
					if (!Object.is(actual, expected)) {
						throw new Error(`${message}\nexpected: ${String(expected)}\nactual: ${String(actual)}`);
					}
				},
			});
		} catch (cause) {
			outcome = "assertionFailure";
			summary = cause instanceof Error ? cause.message : String(cause);
			failure = serializeError(cause);
		}
		const finishedAt = new Date();
		for (const lane of lanes) {
			await context.emit(
				record({
					lane,
					nonce,
					startedAt: startedAt.toISOString(),
					finishedAt: finishedAt.toISOString(),
					durationMs: finishedAt.getTime() - startedAt.getTime(),
					outcome,
					summary,
					...(failure ? { failure } : {}),
					evidence: { ...EMPTY_EVIDENCE, resultChannel: "node" },
				})
			);
		}
		return;
	}

	// ---- browser tests -----------------------------------------------------
	const deadlineMs = entry.deadlineMs ?? context.defaultDeadlineMs;
	const broker = createConsistencyBroker(lanes.map((lane) => lane.laneId));
	const drafts: LaneOutcomeDraft[] = [];
	const attempts: LaneAttempt[] = [];
	const fixturesToStop: Fixture[] = [];

	/**
	 * Admission barrier across the lanes of this test.
	 *
	 * A lane drains the callbacks it admitted before its record is sealed, and a
	 * consistency submission only completes when its partner lane answers. Finalizing
	 * the rendezvous the moment every lane has sealed is what keeps those two facts
	 * compatible: no lane can submit again, so anything still waiting is released and
	 * recorded as incomplete instead of holding a drain open until the deadline.
	 */
	let sealedLanes = 0;
	let releaseSeals: () => void = () => undefined;
	const allLanesSealed = new Promise<void>((resolve) => {
		releaseSeals = resolve;
	});
	const noteSealed = (): void => {
		sealedLanes += 1;
		if (sealedLanes >= lanes.length) releaseSeals();
	};
	void allLanesSealed.then(
		() =>
			void broker.finalize(Math.min(deadlineMs, 5_000)).catch(() => undefined)
	);

	const runLane = async (lane: Lane): Promise<void> => {
		const startedAt = new Date();
		const nonce = createNonce();
		let attempt: LaneAttempt | null = null;
		let outcome: TerminalOutcome = "infrastructureError";
		let summary: string | null = null;
		let failure: ReturnType<typeof serializeError> | undefined;
		let evidence: LaneEvidence = EMPTY_EVIDENCE;
		let selected: SelectedAttempt | null = null;
		let recordedSelection: SelectedAttempt | null = null;
		let collected: {
			readonly artifacts: readonly ArtifactRef[];
			readonly truncations: readonly TruncationNote[];
		} = { artifacts: [], truncations: [] };
		let pluginAssertions: CombinedPluginAssertions | null = null;
		/** True once this attempt's observations are sealed; host hooks are refused after it. */
		let sealed = false;
		let pendingAdmissions = 0;
		/**
		 * The lane's own observations, sampled once at the seal.
		 *
		 * It is taken inside the cleanup block, after the drain and *before* the route
		 * observation is forgotten: the host's route instrumentation lives in the
		 * fixture observer keyed by this nonce, so reading it after `forgetRoute` would
		 * report a proven route as no handshakes, no streams and every request
		 * unmatched — a false bypass, recorded as evidence.
		 */
		let sealedEvidence: Omit<LaneEvidence, "artifacts" | "truncations"> | null = null;
		/** The lane's accepted-failure ledger, sampled at that same boundary. */
		let sealedFailures: LaneFailureLedger = {
			accepted: 0,
			attributed: 0,
			dropped: 0,
			retained: [],
		};
		/** Host fixture verdicts that arrived after the seal, refused at the source. */
		const lateHostAssertions: { readonly kind: "pass" | "fail"; readonly message: string | null }[] =
			[];
		const verdict: "page" | "host" = entry.meta?.verdict === "host" ? "host" : "page";
		let resultChannel: LaneEvidence["resultChannel"] =
			test.execution.kind === "page-control"
				? "playwright"
				: test.execution.kind === "node"
					? "node"
					: "page";

		const laneAbort = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			laneAbort.abort(new Error(`deadline of ${deadlineMs}ms exceeded`));
		}, deadlineMs);
		const onRunAbort = () => {
			laneAbort.abort(new Error("run cancelled"));
			// The deadline is released here, not only in the `finally`.
			//
			// Its sole effect is to abort this lane, which the line above has just
			// done, so once the run is cancelled it can no longer change anything —
			// but it is a ref'd timer, and a lane abandoned mid-attempt never reaches
			// its `finally`, because that only runs if the attempt settles. The timer
			// then held the whole process open for the remainder of its deadline:
			// every planned pair was already accounted for and every record written,
			// yet the CLI sat for the rest of the deadline before exiting, which is
			// indistinguishable from a hang.
			//
			// It is cleared rather than unref'd on purpose. Unref'ing would let the
			// process exit while leaving the deadline armed and invisible, which hides
			// abandoned work instead of accounting for it; clearing says plainly that
			// this deadline has been superseded by the cancellation.
			//
			// It also keeps the classification honest: left armed, the timer fires long
			// after the fact and sets `timedOut`, so a lane the operator cancelled would
			// be written up as having exceeded its deadline.
			clearTimeout(timer);
		};
		context.signal.addEventListener("abort", onRunAbort, { once: true });
		// Covers one narrow window: an abort that lands after `executeNativeTest`'s
		// own aborted-run check and before this registration would never call the
		// listener, because `addEventListener` on an already-aborted signal does not
		// fire — leaving the deadline armed for exactly the reason above. A run that
		// was aborted before the test started never reaches here at all; it returns
		// earlier with `cancelled` records. That makes this guard real but not
		// deterministically reproducible, so it carries no test of its own.
		if (context.signal.aborted) onRunAbort();

		try {
			attempt = await lane.openAttempt({
				testId: entry.testId,
				nonce,
				signal: laneAbort.signal,
				onConsistent: (label, value) =>
					// The broker owns the label contract, so a label the page did not give
					// reaches it exactly as it arrived and is refused there. Validating or
					// substituting one here would turn a refusal into silent agreement.
					broker.submit(lane.laneId, label as string, value),
			});
			attempts.push(attempt);

			if (test.execution.kind === "page-control") {
				const artifactDirectory = attemptArtifactDirectory(context, entry, lane.laneId);
				await mkdir(artifactDirectory, { recursive: true });
				const control = attempt;
				let originUrl: string | null = null;
				let originPort: number | null = null;
				const createFixture = test.execution.createFixture;
				if (createFixture) {
					// A fixture that cannot bind or start is a setup failure, not a failed
					// expectation. Without this guard the page-control branch of the catch
					// below turns an unbound port into `assertionFailure`, which reads as
					// "the browser disagreed" and hides the real cause.
					let target: FixtureTarget;
					try {
						const fixture = createFixture();
						// Registered before start so a partially started fixture is still stopped.
						fixturesToStop.push(fixture);
						await fixture.start({
							pass: async () => undefined,
							fail: async () => undefined,
						});
						target = fixture.target();
					} catch (cause) {
						outcome = "setupError";
						summary = `the fixture for ${test.name} on ${lane.laneId} failed to start: ${cause instanceof Error ? cause.message : String(cause)}`;
						failure = serializeError(cause);
						throw Object.assign(new Error(summary), { runwaySetup: true });
					}
					originUrl = target.url;
					originPort = target.listenPort;
					context.watchRoute?.(nonce, {
						listenPort: target.listenPort,
						expectedUrl: target.url,
						expectedMethod: "GET",
						mode: "local-http",
						remoteHost: null,
						remotePort: null,
					});
				}
				await test.execution.fn({
					page: control.page,
					frame: control.frame,
					originUrl,
					originPort,
					navigate: async (url: string) => {
						const parsed = new URL(url);
						const host = parsed.hostname;
						const loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]";
						const remote = entry.requiredCapabilities.includes(CAPABILITIES.remoteNetwork);
						if (!loopback && !remote) {
							throw new RunwayError(
								"fixtures/capability-unavailable",
								`page-control navigation to ${host} needs remoteNetwork; this test did not declare it`,
								{ details: { url } }
							);
						}
						if (loopback && parsed.port) {
							context.watchRoute?.(nonce, {
								listenPort: Number(parsed.port),
								expectedUrl: url,
								expectedMethod: "GET",
								mode: "local-http",
								remoteHost: null,
								remotePort: null,
							});
						} else if (!loopback) {
							context.watchRoute?.(nonce, {
								listenPort: 0,
								expectedUrl: url,
								expectedMethod: "GET",
								mode: "remote-stream",
								remoteHost: host,
								remotePort: parsed.port
									? Number(parsed.port)
									: parsed.protocol === "https:"
										? 443
										: 80,
							});
						}
						await control.navigate(url);
					},
					harnessOrigin: lane.origin,
					laneId: lane.laneId,
					artifactDirectory,
					browser: {
						engine: context.browserProvenance.engine,
						version: context.browserProvenance.version,
						selection: context.browserProvenance.selection,
						explicitlySelected: context.browserProvenance.explicitlySelected,
					},
					pluginProfileName: context.pluginProfileName,
				});
				outcome = "pass";
			} else if (test.execution.kind === "in-page") {
				const fixture = test.execution.createFixture();
				fixturesToStop.push(fixture);
				const signals: AttemptSignal[] = [];
				let hostResolve: ((result: PageResult) => void) | null = null;
				const hostResult = new Promise<PageResult>((resolve) => {
					hostResolve = resolve;
				});
				const settle = (kind: "pass" | "fail", message?: string, details?: unknown): void => {
					if (sealed) {
						// The record's observations are sealed. A fixture that still has
						// something to say is told so at its own call site, rather than
						// having a verdict accepted into nothing. A late *failure*
						// contradicts a pass and is accounted for below.
						lateHostAssertions.push({ kind, message: message ?? null });
						throw new RunwayError(
							"suite/unsupported-case",
							`the fixture for ${test.name} reported a ${kind} after the ${lane.laneId} ` +
								"attempt was sealed, so it was refused",
							{
								details: { testId: entry.testId, laneId: lane.laneId, message: message ?? null },
								remedy:
									"A fixture must report its verdict before the test ends; keep no request " +
									"handler alive that can still call pass() or fail() afterwards.",
							}
						);
					}
					if (signals.some((signal) => signal.source === "host")) return;
					const result: PageResult = {
						kind,
						message: message ?? null,
						details: details ?? null,
						attributed: true,
					};
					signals.push({ source: "host", result });
					selected = selectAttemptResult(verdict, signals);
					const resolve = hostResolve;
					hostResolve = null;
					resolve?.(result);
				};
				try {
					await fixture.start({
						pass: async (message, details) => settle("pass", message, details),
						fail: async (message, details) => settle("fail", message, details),
					});
				} catch (cause) {
					outcome = "setupError";
					summary = `the fixture for ${test.name} on ${lane.laneId} failed to start: ${cause instanceof Error ? cause.message : String(cause)}`;
					failure = serializeError(cause);
					throw Object.assign(new Error(summary), { runwaySetup: true });
				}
				const target = fixture.target();
				context.watchRoute?.(nonce, {
					listenPort: target.listenPort,
					expectedUrl: target.url,
					expectedMethod: "GET",
					mode: "local-http",
					remoteHost: null,
					remotePort: null,
				});
				await attempt.configureCleartext({
					hosts: target.hostMapping?.hosts ?? [],
					site: target.hostMapping?.site ?? null,
				});
				if (metaBoolean(entry, "warmProxiedRoute")) {
					await attempt.warmNavigation(target.url, Math.min(deadlineMs, 5_000));
				}
				await attempt.navigate(target.url);
				const abortResult = new Promise<never>((_resolve, reject) => {
					laneAbort.signal.addEventListener(
						"abort",
						() =>
							reject(
								new RunwayError(
									timedOut ? "schedule/deadline-exceeded" : "schedule/cancelled",
									timedOut
										? `the page reported no result within ${deadlineMs}ms`
										: "the run was cancelled while the test was executing",
									{ details: { testId: entry.testId, laneId: lane.laneId } }
								)
							),
						{ once: true }
					);
				});
				const pageArrived = attempt.waitForResult().then((result) => {
					signals.push({ source: "page", result });
					selected = selectAttemptResult(verdict, signals);
					return "page" as const;
				});
				const hostArrived = hostResult.then((result) => {
					if (!signals.some((signal) => signal.source === "host")) {
						signals.push({ source: "host", result });
						selected = selectAttemptResult(verdict, signals);
					}
					return "host" as const;
				});
				let sawPage = false;
				let sawHost = false;
				while (!attemptSelectionComplete(verdict, selected)) {
					const waiters: Promise<"page" | "host">[] = [];
					if (!sawPage) waiters.push(pageArrived.then((value) => { sawPage = true; return value; }));
					if (!sawHost) waiters.push(hostArrived.then((value) => { sawHost = true; return value; }));
					if (waiters.length === 0) break;
					await Promise.race([...waiters, abortResult]);
				}
				const frozen = ((value: SelectedAttempt | null) => value)(selected);
				recordedSelection = frozen;
				if (frozen === null) {
					outcome = "timeout";
					summary = "no terminal result";
				} else if (verdict === "page" && !frozen.result.attributed && frozen.channel === "page") {
					outcome = "invalidRecord";
					summary = "the page result did not carry this attempt's nonce";
					failure = { message: summary };
				} else {
					resultChannel = frozen.channel;
					outcome = frozen.result.kind === "pass" ? "pass" : "assertionFailure";
					summary = frozen.result.message;
					if (frozen.result.kind === "fail") {
						failure = { message: frozen.result.message ?? "the attempt reported a failure" };
					}
				}
				const expectedOk = metaNumber(entry, "expectedOkCalls");
				if (outcome === "pass" && expectedOk !== null && attempt.okCount() !== expectedOk) {
					outcome = "assertionFailure";
					summary = `expected ${expectedOk} ok() call(s), observed ${attempt.okCount()}`;
				}
			}

			// Configured plugin assertions run for every attempt, including when the
			// test does not require an owner receipt: a profile that declares a
			// verifier must be able to fail the attempt. They are consulted *only* as
			// a way to fail — see the owner signal below, which they cannot satisfy.
			//
			// One call per navigation this attempt actually made, with that
			// navigation's URL, so every tested target is covered instead of only the
			// last one. A test that navigated nowhere is asked once, about nothing.
			const navigatedTargets = attempt.navigations();
			const verificationTargets: readonly (string | null)[] =
				navigatedTargets.length > 0 ? navigatedTargets : [null];
			const reports: PluginAssertionReport[] = [];
			for (const target of verificationTargets) {
				reports.push(
					await attempt.verifyPluginAssertions(target).catch(
						(cause: unknown): PluginAssertionReport => ({
							status: "unavailable",
							failures: [],
							unavailableReason: cause instanceof Error ? cause.message : String(cause),
							expectation: attempt!.pluginVerifierExpectation(),
							invoked: [],
							target,
						})
					)
				);
			}
			pluginAssertions = combinePluginReports(reports);
			if (pluginAssertions.status === "violated" && outcome === "pass") {
				outcome = "pluginError";
				summary = `configured plugin assertions failed: ${pluginAssertions.failures
					.map((entry) => `${entry.module ?? "plugin"}: ${entry.message}`)
					.join("; ")}`;
				failure = { message: summary };
			} else if (pluginAssertions.status === "unavailable" && outcome === "pass") {
				outcome = "pluginError";
				summary = `the configured plugin assertions could not be evaluated: ${pluginAssertions.unavailableReason ?? "unknown reason"}`;
				failure = { message: summary };
			}

			collected = await attempt.collectArtifacts({
				runDirectory: context.runDirectory,
				directory: attemptArtifactDirectory(context, entry, lane.laneId),
			});
		} catch (cause) {
			const error = cause instanceof RunwayError ? cause : null;
			if (cause && typeof cause === "object" && "runwaySetup" in cause) {
				outcome = "setupError";
				summary = cause instanceof Error ? cause.message : String(cause);
			} else if (error?.code === "schedule/deadline-exceeded" || timedOut) {
				outcome = "timeout";
				summary = `no terminal result within ${deadlineMs}ms`;
			} else if (error?.code === "schedule/cancelled") {
				outcome = "cancelled";
				summary = "the run was cancelled before this lane produced a result";
			} else if (error?.code === "lane/init-failed") {
				outcome = "infrastructureError";
				summary = error.message;
			} else if (test.execution.kind === "page-control") {
				outcome = "assertionFailure";
				summary = cause instanceof Error ? cause.message : String(cause);
			} else {
				outcome = "infrastructureError";
				summary = cause instanceof Error ? cause.message : String(cause);
			}
			failure = serializeError(cause);
			if (attempt) {
				// A failed attempt is exactly when its console transcript matters.
				collected = await attempt
					.collectArtifacts({
						runDirectory: context.runDirectory,
						directory: attemptArtifactDirectory(context, entry, lane.laneId),
					})
					.catch(() => ({ artifacts: [], truncations: [] }));
			}
		} finally {
			// ---- admission seal -------------------------------------------------
			// Nothing more is accepted for this attempt from here on. Sealing before
			// the final observations are sampled is what makes them final: a binding
			// call or a fixture verdict that arrives later is refused at its own call
			// site, not accepted into a record that has already been written.
			sealed = true;
			if (attempt) {
				attempt.sealAdmissions();
				// The barrier is marked before draining, because a drain can be waiting
				// on the rendezvous with the other lane, and that lane is only released
				// once every lane has sealed.
				noteSealed();
				pendingAdmissions = (await attempt.drainAdmissions(laneAbort.signal)).pending;
				// Sampled here, while the host still holds this attempt's route
				// observation: `forgetRoute` below drops the watch, the handshakes and
				// the streams recorded under this nonce.
				sealedEvidence = attempt.evidence();
				// Read at the same boundary: every failure the page had accepted by the
				// time admissions closed, including any that arrived after the terminal
				// result was chosen.
				sealedFailures = attempt.acceptedFailures();
			} else {
				noteSealed();
			}
			clearTimeout(timer);
			context.signal.removeEventListener("abort", onRunAbort);
			context.forgetRoute?.(nonce);
		}

		// ---- sealed observations ----------------------------------------------
		// Sampled once, at the seal and after everything admitted before it had
		// drained, so no counter can move behind the record this produces and no
		// host-side observation has been released yet.
		// `sealedEvidence` is set for every attempt that exists; the check is what
		// tells the type checker so, since a failure to sample it would have thrown
		// out of `runLane` rather than reaching this point.
		if (attempt && sealedEvidence) {
			const laneEvidence = sealedEvidence;
			const selfReported = laneEvidence.selfReported;
			// Read from the sealed sample, not from the live counter: the outcome below
			// must be the one the recorded evidence supports, and the two cannot be
			// allowed to disagree even by a call that lands between them.
			const forgedConsistency = counter(selfReported, "unattributedConsistency");
			const refusedSubmissions = counter(selfReported, "rejectedConsistencySubmissions");
			const lateFailures = lateHostAssertions.filter((late) => late.kind === "fail");

			// A phase that could not finish because the attempt ran out of deadline is
			// reported as the deadline it hit, not as a defect in what it was asking.
			// A verification that was cut short is the clearest case: the plugin did
			// not misbehave, the attempt ended.
			const cutShort =
				outcome === "pass" ||
				(outcome === "pluginError" && pluginAssertions?.status === "unavailable");
			if (pendingAdmissions > 0 && outcome === "pass") {
				outcome = timedOut ? "timeout" : "cancelled";
				summary = `${pendingAdmissions} admitted callback(s) were still in flight when this attempt ended`;
				failure = { message: summary };
			} else if (laneAbort.signal.aborted && cutShort) {
				// A result that settled while the attempt was already over is not a
				// pass: the deadline covers verification and artifact collection too.
				outcome = timedOut ? "timeout" : "cancelled";
				summary = timedOut
					? `the attempt did not complete within ${deadlineMs}ms: ` +
						`${pluginAssertions?.status === "unavailable" ? pluginAssertions.unavailableReason ?? "a phase was cut short" : "a result that settled afterwards was not accepted"}`
					: "the run was cancelled before this lane's record was sealed";
				failure = { message: summary };
			}
			// A consistency value without this attempt's nonce never reached the
			// broker; the record it would have supported is invalid, not agreement.
			if (forgedConsistency > 0 && outcome === "pass") {
				outcome = "invalidRecord";
				summary = `${forgedConsistency} consistency value(s) did not carry this attempt's nonce`;
				failure = { message: summary };
			}
			// A submission the broker refused (duplicate, unknown lane, late) is a
			// contract violation that the page already saw rejected. A record that
			// reported it as a pass would contradict the broker's own issue list.
			if (refusedSubmissions > 0 && outcome === "pass") {
				outcome = "invalidRecord";
				summary = `the consistency broker refused ${refusedSubmissions} submission(s) from this attempt`;
				failure = { message: summary };
			}
			if (lateFailures.length > 0 && outcome === "pass") {
				outcome = "invalidRecord";
				summary =
					`the fixture reported ${lateFailures.length} failure(s) after this attempt was ` +
					`sealed: ${lateFailures.map((late) => late.message ?? "no message").join("; ")}`;
				failure = { message: summary };
			}
			// A failure the page reported and this attempt *accepted* belongs to the
			// record, whether or not it was the observation the verdict was chosen from.
			// The chosen observation is left exactly as it was recorded — the channel,
			// the nonce echo and the selection all stand — and only the terminal outcome
			// changes, because a pass recorded beside an accepted failure would
			// contradict what the page was told when the binding resolved.
			if (sealedFailures.accepted > 0 && outcome === "pass") {
				if (sealedFailures.attributed > 0) {
					// A real failed assertion, reported late. That is an assertion
					// failure, not a malformed record.
					const first = sealedFailures.retained.find((entry) => entry.attributed);
					const detail =
						first?.message ??
						`${sealedFailures.attributed} failure(s) whose detail exceeded the record's bound`;
					outcome = "assertionFailure";
					summary = `the page reported a failure after its terminal result: ${detail}`;
					failure = { message: summary };
				} else {
					// None of them carried this attempt's nonce, so they are not its
					// failures to report — and the record is not agreement either.
					outcome = "invalidRecord";
					summary =
						`${sealedFailures.accepted} page failure(s) did not carry this attempt's nonce`;
					failure = { message: summary };
				}
			}

			// This build has no host-side owner receipt. Builtin proxy tests do not
			// require one and must never be recorded as verified. A satisfied plugin
			// verifier is a self-report and is never promoted to owner proof.
			const ownerRequired = entry.requiredCapabilities.includes(CAPABILITIES.ownerSignal);
			evidence = {
				...laneEvidence,
				nonceEcho: recordedSelection?.channel === "host" ? false : laneEvidence.nonceEcho,
				ownerSignal: ownerRequired ? "absent" : "notRequired",
				resultChannel:
					test.execution.kind === "page-control"
						? "playwright"
						: recordedSelection?.channel ?? resultChannel,
				hostOwned: recordedSelection?.hostOwned === true,
				selfReported: {
					...(selfReported ?? {}),
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
									// Per navigation, so a record says which targets were covered.
									targets: pluginAssertions.reports.map((report) => ({
										target: report.target,
										status: report.status,
										invoked: report.invoked,
									})),
								},
							}
						: {}),
					...(lateHostAssertions.length > 0
						? {
								lateHostAssertions: lateHostAssertions.map((late) => ({
									kind: late.kind,
									message: late.message,
								})),
							}
						: {}),
					// What the page reported and the attempt accepted. The counts are
					// exact; the messages are bounded by the lane. Page-supplied
					// `details` are deliberately not merged in: a record must stay a
					// well-formed document that the page cannot shape, and the full
					// payload is already in this attempt's console artifact.
					...(sealedFailures.accepted > 0
						? {
								acceptedPageFailures: {
									accepted: sealedFailures.accepted,
									attributed: sealedFailures.attributed,
									dropped: sealedFailures.dropped,
									retained: sealedFailures.retained.map((entry) => ({
										message: entry.message,
										attributed: entry.attributed,
									})),
								},
							}
						: {}),
					admissionsPendingAfterDrain: pendingAdmissions,
				},
				artifacts: collected.artifacts,
				truncations: collected.truncations,
			};
		}

		const finishedAt = new Date();
		drafts.push({
			lane,
			nonce,
			startedAt: startedAt.toISOString(),
			finishedAt: finishedAt.toISOString(),
			durationMs: finishedAt.getTime() - startedAt.getTime(),
			outcome,
			summary,
			...(failure ? { failure } : {}),
			evidence,
		});
	};

	try {
		if (test.serialLanes === true) {
			for (const lane of lanes) await runLane(lane);
		} else {
			await Promise.all(lanes.map((lane) => runLane(lane)));
		}

		// Sampled after every lane sealed and drained: the barrier above already
		// closed the rendezvous, so this reads the final issue list — including a
		// refusal recorded while a lane was draining — rather than a snapshot taken
		// while callbacks were still running.
		const consistency = await broker.finalize(Math.min(deadlineMs, 5_000));
		if (consistency.issues.length > 0) {
			const detail = consistency.issues
				.map((issue) => `${issue.label} (${issue.reason})`)
				.join(", ");
			for (const draft of drafts) {
				// Disagreement between lanes fails the test in every lane; it is never
				// reported as agreement.
				if (draft.outcome === "pass") {
					draft.outcome = "assertionFailure";
					draft.summary = `lanes disagreed on: ${detail}`;
				}
			}
			await context.diagnostic("warning", `cross-lane consistency mismatch in ${test.name}`, {
				testId: entry.testId,
				issues: consistency.issues,
			});
		}
	} finally {
		for (const attempt of attempts) {
			// A profile that would not close is reported: silently swallowing it is how
			// a run ends up with a browser holding disposable profiles open.
			await attempt.dispose().catch(async (cause: unknown) => {
				await context.diagnostic(
					"warning",
					`a disposable profile for ${test.name} did not close cleanly`,
					{ testId: entry.testId, error: serializeError(cause) }
				);
			});
		}
		for (const fixture of fixturesToStop) {
			try {
				await fixture.stop();
			} catch (cause) {
				await context.diagnostic(
					"warning",
					`a fixture for ${test.name} did not stop cleanly`,
					{ testId: entry.testId, error: serializeError(cause) }
				);
			}
		}
	}

	// A planned lane that produced no draft still needs a terminal record; leaving
	// a pair silent would understate the denominator.
	const covered = new Set<LaneId>(drafts.map((draft) => draft.lane.laneId));
	for (const draft of drafts) await context.emit(record(draft));
	for (const lane of lanes) {
		if (covered.has(lane.laneId)) continue;
		const at = new Date().toISOString();
		await context.emit(
			record({
				lane,
				nonce: createNonce(),
				startedAt: at,
				finishedAt: at,
				durationMs: 0,
				outcome: "infrastructureError",
				summary: "the lane produced no outcome",
				evidence: { ...EMPTY_EVIDENCE, resultChannel: "node" },
			})
		);
	}
}
