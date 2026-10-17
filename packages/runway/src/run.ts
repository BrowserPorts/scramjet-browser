/**
 * Run orchestration.
 *
 * The order here is the architecture: resolve the denominator, open the recorder,
 * bring up fixtures and one browser, execute scheduled tests, then compare what
 * was recorded against what was planned. Comparison never sees live objects — it
 * reads the immutable records — so the verdict a run prints is the same verdict a
 * later `runway compare` recomputes from the same directory.
 *
 * Teardown is unconditional: fixtures, lanes and the browser are closed and the
 * recorder is flushed and closed even when the run is aborted mid-test.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashAssetEntry } from "./fixtures/assets.ts";
import type { ComparisonReport } from "./core/compare.ts";
import {
	RunwayError,
	serializeError,
	toRunwayError,
	type SerializedRunwayError,
} from "./core/errors.ts";
import { ADMISSION_INTEGRITY_CODE } from "./core/verification.ts";
import { contentHash, createNonce, type LaneId, type TestId } from "./core/ids.ts";
import {
	buildInventory,
	CAPABILITIES,
	createInventorySnapshot,
	filterEntries,
	inventoryFromSnapshot,
	planPairs,
	type Inventory,
	type InventoryEntry,
	type PlannedPair,
} from "./core/inventory.ts";
import {
	createRunPlan,
	savePlan,
	type BrowserPlan,
	type RunConfiguration,
	type RunPlan,
} from "./core/plan.ts";
import { evaluateRecordedRun } from "./core/offline.ts";
import type { LaneEvidence, ProvenanceBundle } from "./core/protocol.ts";
import {
	PLAN_NAME,
	REPORT_NAME,
	RunRecorder,
	writeReport,
	type RecorderOptions,
	type TerminalRecordInput,
} from "./core/recorder.ts";
import type { TerminalOutcome } from "./core/outcome.ts";
import { schedule, type ItemResult, type ScheduleItem } from "./core/scheduler.ts";
import { loadExpectations, NO_EXPECTATIONS, type LoadedExpectations } from "./core/expectations.ts";
import {
	launchBrowser,
	type BrowserCloseReport,
	type BrowserOwner,
} from "./browser/owner.ts";
import { startLocalFixtures, type LocalFixtures } from "./fixtures/servers.ts";
import { loadPluginProfile, type LoadedPluginProfile } from "./fixtures/plugin-profile.ts";
import { createBrowserLane } from "./lanes/browser-lane.ts";
import type { Lane } from "./lanes/lane.ts";
import { discoverNativeTests, NATIVE_SUITE, type NativeDiscovery } from "./suites/native.ts";
import { executeNativeTest } from "./suites/native-execute.ts";
import { discoverWptCases, type WptDiscovery } from "./suites/wpt/suite.ts";
import type { WptManifest } from "./suites/wpt/manifest.ts";
import { WPT_SUITE_NAME } from "./config/resolve.ts";
import { executeWptCase } from "./suites/wpt/execute.ts";
import { startWptServer, type WptServerHandle } from "./suites/wpt/server.ts";
import {
	createWptHostAttachment,
	mainFrameCase,
} from "./suites/wpt/host-attachment.ts";
import type { WptCaseFrame, WptHostAttachment } from "./suites/wpt/execute.ts";

export { REPORT_NAME } from "./core/recorder.ts";

export type RunLogger = (line: string) => void;

export type PreparedRun = {
	/** The configuration bound to the denominator it expanded to. */
	readonly plan: RunPlan;
	readonly inventory: Inventory;
	readonly plannedPairs: readonly PlannedPair[];
	readonly discovery: NativeDiscovery;
	/**
	 * Present when the plan selected the `wpt` suite.
	 *
	 * Never `null` for a WPT selection: {@link prepareRun} refuses a plan whose
	 * manifest it could not read, so a prepared WPT plan always has the manifest
	 * its denominator was built from.
	 */
	readonly wptDiscovery: WptDiscovery | null;
};

/**
 * Expands a configuration into a plan: discover the suite, build the inventory,
 * snapshot the planned pairs, and hash the result.
 *
 * `runway list`, `runway preflight` and `runway run` all take this path, so the
 * denominator — and the plan hash that binds records to it — is produced by one
 * piece of code. Nothing is launched here.
 */
export async function prepareRun(configuration: RunConfiguration): Promise<PreparedRun> {
	const nativeSelection = configuration.suites.find((suite) => suite.suite === NATIVE_SUITE);
	// The selection the consumer names is `wpt`; the *entries* carry per-manifest suite
	// ids (such as `wpt/url`), because the selection label is chosen by
	// whoever generated the manifest. Matching a single constant id would miss them.
	const wptSelection = configuration.suites.find((suite) => suite.suite === WPT_SUITE_NAME);
	if (!nativeSelection && !wptSelection) {
		throw new RunwayError("plan/invalid", "no suite in this plan is implemented by this build", {
			details: { suites: configuration.suites.map((suite) => suite.suite) },
		});
	}

	const entries: InventoryEntry[] = [];
	let discovery: NativeDiscovery = Object.freeze({
		entries: Object.freeze([]),
		tests: new Map(),
		skippedModules: Object.freeze([]),
	});
	if (nativeSelection) {
		discovery = await discoverNativeTests(
			configuration.testRoot ? { root: configuration.testRoot } : {}
		);
		if (configuration.testRoot && discovery.entries.length === 0) {
			throw new RunwayError("suite/discovery-failed", "the consumer test directory contains no tests", {
				remedy: "Export a test or an array of tests built with runway/testkit from an ESM module.",
			});
		}
		entries.push(...filterEntries(discovery.entries, nativeSelection.filters));
	}

	/*
	 * WPT discovery reads the manifest; it does not execute anything.
	 *
	 * A manifest that cannot be read is a *planning* failure, and it is refused
	 * here rather than carried.
	 *
	 * Carrying it was the defect: the selection then expanded to zero entries, the
	 * plan recorded no ineligibility, and a WPT-only run reported a clean, empty
	 * success — the one outcome an unreadable denominator must never produce. A
	 * mixed native+WPT plan was worse, because the native half really did run and
	 * the run was then marked complete while half its selection had silently
	 * vanished. `runway list` took the same path and exited 0.
	 *
	 * So the manifest is read before a plan exists, and a plan is only produced
	 * once the denominator it promises is known. Nothing is fabricated from an
	 * unreadable manifest, and the original parse/read failure is preserved as the
	 * `cause` so the reason survives the refusal.
	 *
	 * This is not the same boundary as {@link executeRun}: once a *valid* plan has
	 * been saved, a manifest that has since become unreadable is that run's
	 * recorded setup failure, one outcome per planned pair, because by then there
	 * is a denominator to answer for. Here there is not.
	 */
	let wptDiscovery: WptDiscovery | null = null;
	if (wptSelection) {
		if (!configuration.wpt) {
			throw new RunwayError(
				"plan/invalid",
				"the wpt suite was selected but the plan carries no manifest",
				{
					details: { suites: configuration.suites.map((suite) => suite.suite) },
					remedy:
						"Pass --wpt-manifest <path>. The manifest is the denominator and is never " +
						"inferred.",
				}
			);
		}
		try {
			wptDiscovery = await discoverWptCases({
				manifestPath: configuration.wpt.manifestPath,
				allowIncomplete: configuration.wpt.allowIncomplete,
				inventory: { lanes: configuration.lanes.map((lane) => lane.laneId) },
			});
		} catch (cause) {
			throw new RunwayError(
				"plan/invalid",
				// Deliberately broader than "could not be read": this covers a manifest
				// that was read and then refused — an incomplete one, which describes
				// less than its own selection. `details.reason` carries which it was.
				"the wpt suite was selected but its manifest could not be used, so this plan " +
					"has no denominator",
				{
					details: {
						manifestPath: configuration.wpt.manifestPath,
						reason: cause instanceof Error ? cause.message : String(cause),
					},
					remedy:
						"Generate a manifest with scripts/generate-wpt.py against the " +
						"upstream checkout you intend to run, and pass its absolute path. A plan is " +
						"not produced from a manifest that cannot be read.",
					cause,
				}
			);
		}
		// Every case the manifest lists is retained, including the ones this
		// boundary cannot execute: they keep their reason and record `notRun`.
		entries.push(...filterEntries(wptDiscovery.entries, wptSelection.filters));
	}

	const inventory = buildInventory(entries);
	const plannedPairs = planPairs(
		inventory,
		configuration.lanes.map((lane) => lane.laneId)
	);
	const plan = createRunPlan(
		configuration,
		createInventorySnapshot({
			inventory,
			pairs: plannedPairs,
			suites: configuration.suites.map((suite) => suite.suite),
		})
	);
	return Object.freeze({ plan, inventory, plannedPairs, discovery, wptDiscovery });
}

export type RunResult = {
	readonly plan: RunPlan;
	readonly report: ComparisonReport;
	readonly runDirectory: string;
	readonly exitCode: number;
};

export type RunOptions = {
	/** A prepared plan: its inventory snapshot is the denominator this run answers. */
	readonly plan: RunPlan;
	/**
	 * Discovery that produced the plan. Supplied by `runway run` so the suite is
	 * imported once; otherwise it is re-imported and selected *by snapshot id*.
	 */
	readonly discovery?: NativeDiscovery;
	readonly signal?: AbortSignal;
	readonly log?: RunLogger;
	/**
	 * Test seam. Replaces how this run opens its log.
	 *
	 * Production always passes nothing and gets a real `RunRecorder` over the run
	 * directory. Tests pass a factory — usually one that opens a real recorder and
	 * wraps it — to inject exactly one failure at the boundary under test. It is
	 * spelled as an option rather than as module state so two runs cannot share it,
	 * and so forgetting it degrades to the production path rather than to a stub.
	 */
	readonly openRecorder?: (options: RecorderOptions) => Promise<RunRecorder>;
	/**
	 * Test seam. Replaces how this run starts and owns its heavy resources.
	 *
	 * Production always passes nothing and gets the real fixture servers and the
	 * real browser launch. Tests for the *cleanup ledger itself* — idempotence,
	 * ordering, shared settlement — substitute disposals whose `close` they
	 * control, because a real browser will not refuse to close on demand, and
	 * because the property under test is the ledger, not Chromium. Tests for a
	 * real browser launch use no seam at all: they pass a plan whose browser
	 * selection names the binary, exactly as `runway run` does.
	 *
	 * The seam is split per resource rather than one blob, so a test can replace
	 * the fixture servers while launching a real browser, or vice versa. Nothing
	 * here changes the registrations either way: whatever is started is handed to
	 * the ledger at acquisition, and the `finally` is the only releaser.
	 */
	readonly resources?: {
		readonly startFixtures?: (input: {
			readonly plan: RunPlan;
			readonly profile: LoadedPluginProfile;
		}) => Promise<LocalFixtures>;
		readonly launchBrowser?: (plan: BrowserPlan) => Promise<BrowserOwner>;
	};
};

function requiresBrowser(entries: readonly InventoryEntry[]): boolean {
	return entries.some((entry) => entry.requiredCapabilities.includes(CAPABILITIES.browser));
}

/**
 * Turns an unsuccessful {@link BrowserCloseReport} into a cleanup failure.
 *
 * `BrowserOwner.close` reports rather than throws: a browser that would not close
 * within its budget resolves with `browserReleased: false` and whatever could be
 * observed about it. That is the right contract for the owner — it lets the caller
 * decide — but it means a caller that only awaits the promise sees success.
 *
 * What is asserted here is exactly what the owner declared, and nothing more. No
 * claim is made that the process was terminated, and none that it survived: the
 * sampled fields travel into `details` as the owner reported them, including
 * `null` where it did not sample. `browserReleased` is optional on the report, and
 * only an explicit `false` counts as a failure — absent means the producer did not
 * say, which is not the same as saying no.
 */
function assertBrowserReleased(report: BrowserCloseReport): void {
	const contextsFailed = report.contextsFailed ?? [];
	const unreleased = report.browserReleased === false;
	if (report.browserFailure === null && contextsFailed.length === 0 && !unreleased) return;
	const parts: string[] = [];
	if (report.browserFailure !== null) parts.push(`the browser did not close: ${report.browserFailure}`);
	else if (unreleased) parts.push("the browser close did not complete within its budget");
	if (contextsFailed.length > 0) {
		parts.push(`${contextsFailed.length} profile(s) did not close`);
	}
	throw new RunwayError("browser/cleanup-failed", parts.join("; "), {
		details: {
			browserFailure: report.browserFailure,
			// Reported as observed, not as concluded.
			browserReleased: report.browserReleased ?? null,
			browserStillConnected: report.browserStillConnected ?? null,
			outstandingContexts: report.outstandingContexts ?? null,
			contextsClosed: report.contextsClosed,
			contextsFailed: contextsFailed.map((failure) => ({ ...failure })),
		},
		remedy:
			"The run's evidence is on disk, but this host may still hold a browser process " +
			"and its profile directory. Check before starting another run.",
	});
}

/**
 * Whether this entry came from the WPT suite.
 *
 * The same test the dispatcher uses, kept in one place so "which entries are
 * WPT" cannot drift between deciding what to start and deciding what to run.
 */
function isWptEntry(entry: InventoryEntry): boolean {
	return String(entry.suite).startsWith(`${WPT_SUITE_NAME}/`);
}

export async function executeRun(options: RunOptions): Promise<RunResult> {
	const { plan } = options;
	const log: RunLogger = options.log ?? (() => undefined);
	// The denominator is the plan's snapshot, not a fresh discovery: executing a
	// saved plan must run exactly the pairs that plan hash covers.
	const inventory = inventoryFromSnapshot(plan.inventory);
	const plannedPairs = plan.inventory.pairs;
	const plannedLanes = new Set<LaneId>(plannedPairs.map((pair) => pair.laneId));
	const plannedTests = new Set<TestId>(plannedPairs.map((pair) => pair.testId));

	// The accounted boundary opens here, and everything that can fail while bringing
	// the run up happens inside it.
	//
	// This ordering is the point. A valid plan is a promise to answer for every pair
	// it names, and work done before the log exists cannot be answered for: a suite
	// module that fails to import, or a capability this build cannot provide, would
	// otherwise abandon a real denominator with no run directory, no plan.json and no
	// outcomes — a run that has to be reconstructed from a stack trace. So the log is
	// opened first, against a denominator derived from the plan alone, and discovery
	// and the capability checks happen after it, where a failure becomes one recorded
	// outcome per outstanding pair and a `failed` completion.
	//
	// What remains outside is only what cannot be recorded by definition: deriving the
	// denominator from the plan's own snapshot (an unreadable snapshot is not a valid
	// plan, so there is nothing to answer for), and creating the directory and log
	// themselves.
	await mkdir(plan.output.runDirectory, { recursive: true });
	await savePlan(path.join(plan.output.runDirectory, PLAN_NAME), plan);

	const recorder = await (options.openRecorder ?? RunRecorder.open)({
		runId: plan.runId,
		planHash: plan.planHash,
		directory: plan.output.runDirectory,
		knownTests: plannedTests,
		knownLanes: plannedLanes,
	});
	await recorder.runStarted(plannedPairs.length);

	let fixtures: LocalFixtures | null = null;
	let browser: BrowserOwner | null = null;
	let aborted = false;
	/** Set once discovery has run. Read after the boundary for the report's notes. */
	let discovery: NativeDiscovery | null = null;
	let wptFailure: string | null = null;
	let wptServer: WptServerHandle | null = null;
	/**
	 * The run's single cleanup owner. Resources are registered at acquisition and
	 * released by the `finally` below — and only there. The `catch` must not call
	 * `release()` itself: the `finally` runs whether the `try` threw, so a catch
	 * that released would double-run whenever both fired.
	 */
	const cleanup = createRunCleanup();
	const cleanupSettled = (): Promise<readonly RunwayError[]> => cleanup.release();
	let cleanupFailures: readonly RunwayError[] = [];
	/**
	 * What `finish` records once control leaves the `try`.
	 *
	 * Assigned by exactly one path: the disrupted one sets `"aborted"`, the quiet
	 * one sets `"completed"` or `"failed"`. A thrown failure never assigns it — the
	 * `finally` then records `"failed"`, so a run that never finished its own
	 * accounting cannot be marked `completed`. Fail-closed, not fail-quiet.
	 */
	let failState: "completed" | "aborted" | "failed" | null = null;
	/**
	 * What `finish` threw, when it did. The error itself, never a flag.
	 *
	 * A run whose completion marker could not be written is unfinished, and the
	 * reason it could not be written is the only thing that explains why. Keeping
	 * the error means its code, message and cause reach the caller instead of a
	 * synthesized stand-in: an out-of-space `finish` and a closed-handle `finish`
	 * are different failures and must not be reported as the same one.
	 */
	let finishFailure: unknown = null;
	/**
	 * The failure the `try` raised, held until the `finally` has run.
	 *
	 * The `catch` cannot throw directly any more. `finish` runs in the `finally`,
	 * which is *after* a `throw` expression is evaluated, so a failure thrown from
	 * the `catch` could never carry what `finish` then did. Holding it lets one
	 * place — after the `finally` — build the final error with every secondary the
	 * run actually collected, in order, without rebuilding an already-wrapped one.
	 */
	let pendingFailure: { readonly cause: unknown } | null = null;
	/** Secondary failures collected while accounting for {@link pendingFailure}. */
	const pendingSecondary: SecondaryFailure[] = [];

	try {
		// Inside the boundary: a module that cannot be imported is now this run's
		// recorded failure rather than an exception thrown over an empty directory.
		const discovered = options.discovery ?? (await discoverNativeTests(
			plan.testRoot ? { root: plan.testRoot } : {}
		));
		if (plan.testRoot) {
			const current = new Map(discovered.entries.map((entry) => [entry.testId, entry]));
			for (const entry of inventory.entries) {
				if (entry.suite !== NATIVE_SUITE) continue;
				if (!entry.meta?.moduleSha256 || current.get(entry.testId)?.meta?.moduleSha256 !== entry.meta.moduleSha256) {
					throw new RunwayError("plan/invalid", `consumer test source changed after planning: ${entry.testId}`, {
						remedy: "Create a new plan for the changed test modules.",
					});
				}
			}
		}

		/*
		 * The WPT fixture server, inside the accounted boundary.
		 *
		 * The manifest is *not* re-read here. `prepareRun` read it once, selected the
		 * cases, and wrote each one's execution metadata into the plan's inventory
		 * snapshot; `inventoryFromSnapshot` above restored exactly that. Re-reading a
		 * live file at dispatch time was how a saved plan could record one case and
		 * execute another: the lookup matched on the upstream URL, which survives an
		 * edit to the timeout or the test flags that decides what actually runs.
		 *
		 * Starting the server can still fail — a checkout that is not there, a
		 * listener that never came up — and that has to become a recorded setup
		 * failure against the pairs the plan already promised, not an exception thrown
		 * over a run that has a directory and a plan.json.
		 */
		if (plan.wpt !== null) {
			if (plan.wpt.wptRoot !== null && plan.wpt.serverConfigPath !== null) {
				try {
					wptServer = await startWptServer({
						wptRoot: plan.wpt.wptRoot,
						configPath: plan.wpt.serverConfigPath,
						...(options.signal ? { signal: options.signal } : {}),
					});
					// Registered with the run's single cleanup owner, like every other
					// resource: the `finally` releases it, nothing else does.
					cleanup.register({
						what: "wpt fixture server",
						close: async () => {
							const report = await wptServer!.close();
							if (report.groupSurvived) {
								throw new RunwayError(
									"fixtures/server-failed",
									"the wptserve process group outlived the run",
									{ details: { endedBy: report.endedBy } }
								);
							}
						},
					});
					await recorder.diagnostic("info", "official wptserve is ready", {
						details: {
							origin: wptServer.origin,
							// Only what was actually proved. A TCP connect is not TLS, and no
							// capability beyond the server itself is claimed here.
							listenerProofs: wptServer.provenance.identity.listenerProofs,
							tlsEstablished: wptServer.provenance.identity.tlsEstablished,
						},
					});
				} catch (error) {
					wptFailure =
						(wptFailure === null ? "" : `${wptFailure}; `) +
						`the WPT fixture server could not be started: ${error instanceof Error ? error.message : String(error)}`;
					await recorder.diagnostic("error", "the WPT fixture server could not be started", {
						details: { reason: error instanceof Error ? error.message : String(error) },
					});
				}
			} else {
				wptFailure =
					"no upstream checkout was supplied (--wpt-root/--wpt-server-config), so no WPT " +
					"case can be served";
			}
		}
		discovery = discovered;
		for (const skipped of discovered.skippedModules) {
			await recorder.diagnostic("info", `module not inventoried: ${skipped.module}`, {
				details: { reason: skipped.reason },
			});
		}

		// Checked before anything is launched, so a capability this build cannot
		// provide costs no fixture servers and no browser — and is still accounted
		// for, because the check is inside the boundary.
		if (
			inventory.entries.some((entry) =>
				entry.requiredCapabilities.includes(CAPABILITIES.ownerSignal)
			)
		) {
			throw new RunwayError(
				"fixtures/capability-unavailable",
				"this build has no host-side owner receipt; tests that require owner cannot run",
				{
					remedy:
						"Do not set requireOwner on builtin proxy regressions. Host-runtime owner verification is not available in this build.",
				}
			);
		}

		// Every planned test must be present in the denominator it was planned from.
		// A missing entry is a contradiction rather than something to skip quietly:
		// skipping would drop the pair out of the schedule and leave the plan's
		// promise unanswered.
		const plannedEntries = [...plannedTests].map((testId) => {
			const entry = inventory.byId.get(testId);
			if (!entry) {
				throw new RunwayError(
					"plan/invalid",
					`the plan schedules ${testId}, which its own inventory snapshot does not describe`,
					{ details: { testId } }
				);
			}
			return entry;
		});
		/*
		 * Resources are acquired for the work that can still run, not for the work
		 * that was planned.
		 *
		 * When the WPT half has already been refused from disk — an unreadable
		 * manifest, or one that is not the manifest this plan was made from — every
		 * WPT pair's outcome is already decided: it is a setup failure, and it needs
		 * no fixture server and no browser to be recorded. Deriving `needBrowser`
		 * from the full planned inventory anyway meant a WPT-only run launched
		 * Chromium and three fixture servers purely to arrive at a refusal it had
		 * already established. Worse, if either of those unrelated acquisitions
		 * failed, the run took the outer failure path and reported *that* instead of
		 * the manifest refusal — the wrong reason, for a fault the run did not have.
		 *
		 * The denominator is untouched: `plannedPairs` and `inventory` still describe
		 * every promised pair, and every refused pair still gets its own recorded
		 * outcome below. This decides only what has to be started.
		 */
		const wptRefused = plan.wpt !== null && wptServer === null;
		const executableEntries = wptRefused
			? plannedEntries.filter((entry) => !isWptEntry(entry))
			: plannedEntries;
		const needBrowser = requiresBrowser(executableEntries);
		if (wptRefused && executableEntries.length < plannedEntries.length) {
			await recorder.diagnostic(
				"info",
				`${plannedEntries.length - executableEntries.length} WPT test(s) cannot be served, ` +
					"so no browser or local fixture server is started on their behalf",
				{ details: { reason: wptFailure } }
			);
		}

		const lanes = new Map<LaneId, Lane>();
		const scramjetLane = plan.lanes.find((lane) => lane.adapter === "scramjet");
		const profile = await loadPluginProfile(scramjetLane?.pluginManifestPath ?? null);
		if (needBrowser) {
			fixtures = await (options.resources?.startFixtures
				? options.resources.startFixtures({ plan, profile })
				: startLocalFixtures({ plan: plan.localFixtures, profile }));
			// Registered at acquisition, before the next acquisition is attempted,
			// so a browser that fails to launch cannot strand the servers it was
			// meant to be tested against. The `finally` below is the only releaser.
			cleanup.register({
				what: "local fixtures",
				close: () => fixtures!.close(),
			});
			log(`  harness ${fixtures.harnessOrigin}`);
			log(`  bare    ${fixtures.bareOrigin}`);
			log(`  wisp    ${fixtures.wispOrigin}`);

			browser = await (options.resources?.launchBrowser
				? options.resources.launchBrowser(plan.browser)
				: launchBrowser(plan.browser));
			cleanup.register({
				what: "browser",
				close: async () => {
					// The report is the point. `close()` *resolves* with an unsuccessful
					// report on timeout or rejection rather than throwing, so a disposal
					// that only awaited it recorded a browser the owner had explicitly
					// declared unreleased as a clean teardown — and the run was then
					// marked `completed`.
					assertBrowserReleased(await browser!.close());
				},
			});
			log(
				`  browser ${browser.provenance.engine} ${browser.provenance.version} ` +
					`(${browser.provenance.selection}${browser.provenance.explicitlySelected ? "" : ", not selection proof"})`
			);

			for (const lanePlan of plan.lanes) {
				if (!plannedLanes.has(lanePlan.laneId)) continue;
				lanes.set(
					lanePlan.laneId,
					createBrowserLane({
						laneId: lanePlan.laneId,
						role: lanePlan.role,
						adapter: lanePlan.adapter,
						origin:
							lanePlan.adapter === "scramjet" ? fixtures.harnessOrigin : fixtures.bareOrigin,
						owner: browser,
						loaded:
							lanePlan.adapter === "scramjet"
								? {
										...profile.loaded,
										"asset:scramjet.js": hashAssetEntry(
											plan.localFixtures.scramjetDist,
											"scramjet.js"
										),
										"asset:controller.api.js": hashAssetEntry(
											plan.localFixtures.controllerDist,
											"controller.api.js"
										),
										"asset:libcurl/index.js": hashAssetEntry(
											plan.localFixtures.libcurlDist,
											"index.js"
										),
									}
								: {
										"asset:bare-index.html": hashAssetEntry(
											path.join(
												path.dirname(fileURLToPath(import.meta.url)),
												"harness",
												"bare",
												"public"
											),
											"index.html"
										),
									},
						...(lanePlan.adapter === "scramjet"
							? { routeObservation: fixtures.routeObservation }
							: {}),
						readyTimeoutMs: plan.schedule.setupDeadlineMs,
						collectCoverage: plan.diagnostics.collectCoverage,
						traceConsole: plan.diagnostics.traceConsole,
					})
				);
			}
		}

		// One scheduler item per test: lanes for a test rendezvous with each other,
		// so they must be in flight together.
		const liveFixtures = fixtures;
		const items: ScheduleItem<InventoryEntry>[] = [];
		const lanesByTest = new Map<TestId, LaneId[]>();
		const pairsByTest = new Map<TestId, PlannedPair[]>();
		for (const pair of plannedPairs) {
			const list = lanesByTest.get(pair.testId) ?? [];
			list.push(pair.laneId);
			lanesByTest.set(pair.testId, list);
			const pairs = pairsByTest.get(pair.testId) ?? [];
			pairs.push(pair);
			pairsByTest.set(pair.testId, pairs);
		}
		const sealer = createItemSealer({
			recorder,
			inventory,
			plan,
			pairsByTest,
			browserProvenance: browserProvenanceFor(plan, browser?.provenance ?? null),
			fixtureProvenance: fixtures?.provenance ?? [],
		});
		for (const [testId, laneIds] of lanesByTest) {
			const entry = inventory.byId.get(testId);
			if (!entry) continue;
			const perLane = entry.deadlineMs ?? plan.schedule.defaultDeadlineMs;
			items.push({
				key: testId,
				payload: entry,
				// Outer backstop: the suite enforces its own per-lane deadline first.
				deadlineMs: perLane * laneIds.length + plan.schedule.setupDeadlineMs,
				...(entry.serialGroup ? { serialGroup: entry.serialGroup } : {}),
			});
		}

		const outcome = await schedule<InventoryEntry>({
			items,
			concurrency: plan.schedule.concurrency,
			defaultDeadlineMs: plan.schedule.defaultDeadlineMs + plan.schedule.setupDeadlineMs,
			...(options.signal ? { signal: options.signal } : {}),
			execute: async (item, signal) => {
				const entry = item.payload;
				const plannedLaneIds = lanesByTest.get(entry.testId) ?? [];

				// WPT entries are dispatched to the WPT adapter. The scheduler, recorder,
				// verification and browser owner are the same ones the native suite uses:
				// this is a second *suite*, not a second runner.
				if (String(entry.suite).startsWith(`${WPT_SUITE_NAME}/`)) {
					await dispatchWptCase({
						entry,
						plannedLaneIds,
						signal,
						plan,
						lanes,
						recorder,
						browser,
						fixtures,
						wptServer,
						wptFailure,
					});
					return;
				}

				const test = discovered.tests.get(entry.testId);
				if (!test) {
					throw new RunwayError(
						"suite/discovery-failed",
						`no discovered test backs the inventory entry ${entry.testId}`,
						{ details: { testId: entry.testId } }
					);
				}
				// A test that runs in the Node process gets a lane identity, not a
				// browser lane: its record must not claim harness or profile loads.
				const entryLanes = entry.requiredCapabilities.includes(CAPABILITIES.inProcess)
					? plannedLaneIds.map((laneId) => inProcessLane(laneId, plan))
					: plannedLaneIds
							.map((laneId) => lanes.get(laneId))
							.filter((lane): lane is Lane => lane !== undefined);
				if (entryLanes.length === 0) {
					throw new RunwayError(
						"lane/init-failed",
						`no lane is available for ${entry.testId}`,
						{ details: { testId: entry.testId, planned: plannedLaneIds } }
					);
				}
				await executeNativeTest({
					entry,
					test,
					lanes: entryLanes,
					signal,
					defaultDeadlineMs: plan.schedule.defaultDeadlineMs,
					browserProvenance:
						browser?.provenance ?? {
							engine: "none",
							version: "n/a",
							selection: plan.browser.selection.kind,
							selector: plan.browser.selection.selector,
							binarySha256: null,
							explicitlySelected: plan.browser.selection.explicitlySelected,
						},
					fixtureProvenance: fixtures?.provenance ?? [],
					artifactRoot: path.join(plan.output.runDirectory, "artifacts"),
					runDirectory: plan.output.runDirectory,
					pluginProfileName: profile.profile.name,
					...(liveFixtures
						? {
								watchRoute: (nonce, watch) => liveFixtures.watchAttempt(nonce, watch),
								forgetRoute: (nonce) => liveFixtures.forgetAttempt(nonce),
							}
						: {}),
					emit: (input) => recorder.recordTerminal(input).then(() => undefined),
					diagnostic: (level, message, details) =>
						recorder.diagnostic(level, message, details ? { details } : {}),
				});
			},
			// Synchronous, and it runs before the attempt is told to stop. An attempt
			// is entitled to a `signal.addEventListener("abort", …)` that reports
			// something, and that listener runs inside the abort itself — before this
			// scheduler could reach any `await`. Withdrawing the pairs here is the only
			// placement that a late report cannot get in front of.
			//
			// It cannot throw: there is no caller to catch it here. A seal that fails
			// is recorded on the sealer and the run fails itself below, where failing
			// is an outcome written to the log rather than an uncaught exception.
			onConclude: (item) => {
				sealItemAdmissionsSafely(sealer, item.key as TestId);
			},
			onResult: async (result) => {
				const status =
					result.conclusion === "completed"
						? "ok"
						: `${result.conclusion}${result.orphanSettled ? " (orphan settled late)" : ""}`;
				log(`  ${status.padEnd(10)} ${result.item.key} (${result.durationMs}ms)`);
				// Writes what the seal decided this item owes. Sealing already happened
				// at the boundary for a timed-out or cancelled item; for one that
				// concluded normally it happens here.
				await sealConcludedItem(sealer, result.item.key as TestId, result);
			},
		});

		aborted = outcome.aborted;
		for (const item of outcome.notStarted) {
			await recorder.diagnostic("warning", `test not started: ${item.key}`, {
				details: { reason: "the run was cancelled before this test started" },
			});
		}
		for (const result of outcome.results) {
			if (result.conclusion === "completed") continue;
			await recorder.diagnostic(
				result.conclusion === "cancelled" ? "warning" : "error",
				`test item ${result.item.key} ended as ${result.conclusion}`,
				{
					details: {
						...(result.error ? { error: result.error.toJSON() } : {}),
						...(result.orphanSettled ? { orphanSettled: true } : {}),
					},
				}
			);
		}

		// Close the scheduler's gaps. A cancelled, timed-out or failed item still
		// owes each of its planned pairs one terminal outcome; without this they
		// would only appear as `missing`, which says nothing about why.
		const gaps = gapTerminalsFor({
			plannedPairs,
			inventory,
			plan,
			results: outcome.results,
			notStarted: outcome.notStarted,
			recorded: (testId, laneId) => recorder.hasTerminal(testId, laneId),
			browserProvenance: browserProvenanceFor(plan, browser?.provenance ?? null),
			fixtureProvenance: fixtures?.provenance ?? [],
		});
		for (const gap of gaps) {
			const written = await recorder.recordGapTerminal(gap);
			if (written === null) {
				// The executor recorded it in the meantime: its record stands.
				await recorder.diagnostic(
					"info",
					`gap terminal for ${gap.testId} on ${gap.laneId} was not needed`,
					{ testId: gap.testId, laneId: gap.laneId }
				);
			}
		}

		// A seal that could not be taken is an infrastructure failure of the run
		// itself. The run no longer knows whether those pairs were open when their
		// attempt reported, so it cannot publish a verdict over them: it fails, which
		// is recorded, rather than reporting a total it cannot justify.
		//
		// Failing the run is necessary but not sufficient. A pair left unsealed can
		// still have accepted a real pass from an attempt's abort listener, and that
		// pass is genuine evidence of what the subject did — it is never rewritten.
		// What must not survive is the run *vouching* for it, so each affected pair is
		// named in a structured diagnostic first. That diagnostic is the record the
		// comparator reads, live and offline alike, to withdraw qualification from
		// exactly those pairs and no others.
		if (sealer.faults.size > 0) {
			const affected = [...sealer.faults.keys()];
			const unreportable = await reportAdmissionIntegrityFaults(
				recorder,
				sealer.faults,
				pairsByTest
			);
			throw new RunwayError(
				"schedule/hook-failed",
				`the run could not close the admissions of ${affected.length} test(s): ${affected.join(", ")}` +
					(unreportable.length > 0
						? `; and the log would not accept the integrity fault for ${unreportable.join(", ")}, ` +
							"so a later offline comparison of this directory cannot know which pairs were affected"
						: ""),
				{
					details: {
						tests: affected,
						...(unreportable.length > 0 ? { unreportablePairs: unreportable } : {}),
					},
					cause: sealer.faults.get(affected[0] as TestId),
				}
			);
		}
		// The quiet end of the `try`. Reached only when nothing above threw, so the
		// marker this assigns is earned: `aborted` when the schedule was cancelled,
		// `completed` otherwise. A dirty release may still demote it in the
		// `finally`; a thrown failure never reaches this line and stays `failed`.
		failState = aborted ? "aborted" : "completed";
	} catch (cause) {
		// The accounted catch. Every statement in it can fail — the log it writes to
		// may be the very thing that is broken — so every statement is best-effort
		// and individually guarded. The original failure stays primary whatever the
		// accounting does; secondary failures are kept structured, never merged into
		// the message, never dropped.
		//
		// Releases are deliberately *not* here: the `finally` below owns them, and it
		// runs whether this block throws or returns. Releasing here too would either
		// double-run or be skipped by the first guarded statement that throws. What
		// this block does record is the failure and the gaps; it hands the failure to
		// the code after the `finally`, which raises it once the releases and the
		// completion marker have had their turn and can be accounted for too.
		const error = toRunwayError(cause);
		const secondary = pendingSecondary;
		const attempt = async (phase: string, work: () => Promise<unknown>): Promise<void> => {
			try {
				await work();
			} catch (failure) {
				secondary.push({ phase, error: serializeError(failure) });
			}
		};
		await attempt("failure-diagnostic", () =>
			recorder.diagnostic("error", "the run failed before completing", {
				details: { error: serializeError(cause) },
			})
		);
		// Every planned pair still owes an outcome. A run that failed while bringing
		// itself up leaves its pairs with a *reason*, not with silence that a later
		// comparison has to describe as `missing`. Pairs that already recorded a
		// real outcome are left exactly as they were.
		await attempt("gap-accounting", async () => {
			const outstanding = recorder.sealOutstanding(plannedPairs);
			for (const gap of setupFailureTerminalsFor({
				plannedPairs: outstanding,
				inventory,
				plan,
				error,
				browserProvenance: browserProvenanceFor(plan, browser?.provenance ?? null),
				fixtureProvenance: fixtures?.provenance ?? [],
			})) {
				await recorder.recordGapTerminal(gap);
			}
		});
		// Waits for the releases the `finally` owns: the ledger's settlement is
		// shared, so awaiting it here does not start a second release, it joins the
		// one already running. Joining matters — the failure that leaves this
		// function must name the releases that did not complete, and it can only do
		// that once they have settled — and it cannot deadlock, because `release`
		// never awaits the catch: it runs the disposals and returns their failures.
		for (const failure of await cleanupSettled()) {
			secondary.push({ phase: "release", error: failure.toJSON() });
		}
		pendingFailure = { cause };
	} finally {
		// The single cleanup owner. Runs on every path — success, failure, abort —
		// and never throws: a `finally` that threw would replace the failure it is
		// unwinding with, which is exactly what `primaryFailureWith` above exists to
		// prevent.
		//
		// Order inside the `finally` is the architecture, and it matches the old
		// shape exactly: releases first, then the completion marker, because how the
		// run released its own resources is part of how it ended. On the success
		// path the marker was already chosen by the `try` — see `failState` — and a
		// release that now reports failure *demotes* it: a browser that would not
		// close leaves the run `failed`, not `completed` with a footnote.
		try {
			cleanupFailures = await cleanup.release();
		} catch {
			// Unreachable by construction — `release` collects rather than throws —
			// and kept because a `finally` must not be the place a second, losing
			// exception is born. If the ledger ever changes, this is the line that
			// keeps the original failure primary.
			cleanupFailures = [];
		}
		// A dirty release demotes the marker, but only one way: `completed` can
		// become `failed`, and nothing earned can be promoted. A thrown failure
		// never assigned `failState`, so it is already `failed` by the `??`.
		const marker = cleanupFailures.length > 0 ? "failed" : (failState ?? "failed");
		try {
			await recorder.finish(marker);
		} catch (cause) {
			// Kept, not swallowed, and not reduced to a flag. A completion marker
			// that cannot be written leaves the run unfinished — the fail-closed
			// state is `finished: false`, never a marker the run did not earn — and
			// *why* it could not be written is raised below, on whichever path this
			// run is on. Nothing is written to the log about it: the log is the thing
			// that just failed, and re-reporting a write failure by writing is how a
			// broken log turns into a lost cause.
			finishFailure = cause;
		}
	}

	// One place raises whatever the run failed at, now that the releases and the
	// completion marker have both had their turn and can be accounted for.
	//
	// The failure the `try` raised stays primary: same code, same message, same
	// cause. Everything the accounting then failed at — the diagnostic it could not
	// write, the gaps it could not record, the releases that did not complete, and
	// the completion marker — travels beside it as structured `details.secondary`,
	// in the order it happened. A run that failed and then failed again is still the
	// first failure's story.
	if (pendingFailure) {
		if (finishFailure !== null) {
			pendingSecondary.push({ phase: "finish", error: serializeError(finishFailure) });
		}
		throw pendingSecondary.length === 0
			? pendingFailure.cause
			: primaryFailureWith(pendingFailure.cause, pendingSecondary);
	}

	// Reached only when the `try` did not throw. The releases already ran, exactly
	// once, in the `finally` — but on this path the completion marker is already
	// written and the recorder is closed, so the diagnostic this used to write can
	// no longer be written. It is not attempted: the `failed` marker carries the
	// verdict, and the failures travel on the report's notes below, as structured
	// data rather than as a line in a closed log.
	//
	// There is one case that must not return at all. If the `finally` could not
	// write the completion marker, this run is unfinished — no `completed`, no
	// `aborted`, no `failed` — and returning a report over it would present an
	// unwitnessed ending as an ending. The run fails, fail-closed.
	//
	// On this path the unwritable marker is the *only* failure, so it is the primary
	// one: its own code is kept, its own message is quoted rather than replaced, and
	// it remains reachable as the `cause`. A synthesized `internal/unexpected` here
	// would report a full disk and a closed handle as the same failure, which is
	// exactly the information a caller needs to tell apart.
	if (finishFailure !== null) {
		const failure = toRunwayError(finishFailure);
		throw new RunwayError(
			failure.code,
			"the run finished its work but its completion marker could not be written, " +
				`so the log has no runFinished event: ${failure.message}`,
			{
				details: {
					...failure.details,
					phase: "finish",
					intendedCompletion: cleanupFailures.length > 0 ? "failed" : (failState ?? "failed"),
					finishError: serializeError(finishFailure),
				},
				remedy:
					failure.remedy ??
					"The run directory holds partial evidence; re-run rather than trust it.",
				cause: finishFailure,
			}
		);
	}

	const expectations: LoadedExpectations = plan.expectationsPath
		? await loadExpectations(plan.expectationsPath)
		: NO_EXPECTATIONS;

	// The run's own summary is produced by the offline evaluator, from the frozen
	// plan and the files on disk. A live run and a later `runway compare` therefore
	// share one verdict pipeline and one exit code.
	const evaluation = await evaluateRecordedRun({
		plan,
		runDirectory: plan.output.runDirectory,
		expectations: expectations.expectations,
		notes: [
			...(expectations.source ? [`expectations applied from ${expectations.source}`] : []),
			...(aborted ? ["the run was cancelled; every planned pair still has an outcome"] : []),
			...(discovery?.skippedModules ?? []).map(
				(skipped) => `not inventoried: ${skipped.module} — ${skipped.reason}`
			),
			// The releases failed after the work finished. The log is already closed
			// — the `failed` completion marker carries it — so what each release
			// reported is attached here, where the run's own report can still say it.
			...cleanupFailures.map(
				(failure) => `teardown did not complete: ${failure.code}: ${failure.message}`
			),
		],
	});
	await writeReport(plan.output.runDirectory, REPORT_NAME, evaluation.report);

	return Object.freeze({
		plan,
		report: evaluation.report,
		runDirectory: plan.output.runDirectory,
		exitCode: evaluation.report.exitCode,
	});
}

/** Browser provenance for records written outside a lane attempt. */
function browserProvenanceFor(
	plan: RunPlan,
	launched: ProvenanceBundle["browser"] | null
): ProvenanceBundle["browser"] {
	return (
		launched ?? {
			engine: "none",
			version: "n/a",
			selection: plan.browser.selection.kind,
			selector: plan.browser.selection.selector,
			binarySha256: null,
			explicitlySelected: plan.browser.selection.explicitlySelected,
		}
	);
}

const GAP_EVIDENCE: LaneEvidence = Object.freeze({
	nonceEcho: false,
	ownerSignal: "notRequired",
	resultChannel: "node",
	hostOwned: false,
	artifacts: Object.freeze([]),
	truncations: Object.freeze([]),
});

/**
 * Maps a scheduler conclusion to the outcome its pairs deserve.
 *
 * Nothing here can invent a pass: the scheduler only knows that an item did not
 * report, and each mapping says which way it failed to report.
 */
function gapOutcomeFor(result: ItemResult<InventoryEntry> | null): {
	readonly outcome: TerminalOutcome;
	readonly summary: string;
} {
	if (!result) {
		return {
			outcome: "cancelled",
			summary: "the run was cancelled before this test started",
		};
	}
	switch (result.conclusion) {
		case "cancelled":
			return {
				outcome: "cancelled",
				summary: "the run was cancelled before this lane reported a result",
			};
		case "timedOut":
			return {
				outcome: "timeout",
				summary:
					`the test exceeded its scheduler deadline without reporting this lane` +
					`${result.orphanSettled ? "; its work settled afterwards and was not accepted" : ""}`,
			};
		case "failed": {
			const code = result.error?.code ?? "";
			const detail = result.error?.message ?? "the test item failed";
			return code.startsWith("fixtures/") || code.startsWith("lane/")
				? { outcome: "setupError", summary: detail }
				: { outcome: "infrastructureError", summary: detail };
		}
		default:
			return {
				outcome: "infrastructureError",
				summary: "the test completed without recording an outcome for this lane",
			};
	}
}

/**
 * One gap record for one pair. The shape is identical whatever closed the pair,
 * so a scheduler gap and a run-level setup failure are described the same way.
 */
function gapRecordFor(options: {
	readonly pair: PlannedPair;
	readonly entry: InventoryEntry | undefined;
	readonly lanePlan: { readonly role: "reference" | "candidate" } | undefined;
	readonly outcome: TerminalOutcome;
	readonly summary: string;
	readonly browserProvenance: ProvenanceBundle["browser"];
	readonly fixtureProvenance: ProvenanceBundle["fixtures"];
}): TerminalRecordInput {
	const at = new Date().toISOString();
	return {
		testId: options.pair.testId,
		laneId: options.pair.laneId,
		nonce: createNonce(),
		startedAt: at,
		finishedAt: at,
		durationMs: 0,
		outcome: options.outcome,
		summary: options.summary,
		failure: { message: options.summary },
		evidence: GAP_EVIDENCE,
		provenance: {
			browser: options.browserProvenance,
			lane: {
				laneId: options.pair.laneId,
				role: options.lanePlan?.role ?? "candidate",
				// No lane adapter produced this record: the scheduler did, because
				// the lane never reported. Claiming the lane's adapter and an empty
				// asset set would misdescribe both.
				adapter: "scheduler",
				loaded: {},
			},
			fixtures: options.fixtureProvenance,
		},
		requiredCapabilities: options.entry?.requiredCapabilities ?? [],
	};
}

/**
 * How a run-level failure lands on the pairs that never got to run.
 *
 * A failure while bringing the run up is not the subject's failure, and it is not
 * "missing" either: the pairs have a definite reason, and it is recorded as one.
 * Fixture, asset, profile and browser failures are setup errors; anything else is
 * infrastructure.
 */
export function setupFailureTerminalsFor(options: {
	readonly plannedPairs: readonly PlannedPair[];
	readonly inventory: Inventory;
	readonly plan: RunPlan;
	readonly error: RunwayError;
	readonly browserProvenance: ProvenanceBundle["browser"];
	readonly fixtureProvenance: ProvenanceBundle["fixtures"];
}): readonly TerminalRecordInput[] {
	const code = options.error.code;
	const setup =
		code.startsWith("fixtures/") || code.startsWith("lane/") || code.startsWith("browser/");
	const summary =
		`the run could not be brought up for this pair: ${code}: ${options.error.message}`;
	return Object.freeze(
		options.plannedPairs.map((pair) =>
			gapRecordFor({
				pair,
				entry: options.inventory.byId.get(pair.testId),
				lanePlan: options.plan.lanes.find((lane) => lane.laneId === pair.laneId),
				outcome: setup ? "setupError" : "infrastructureError",
				summary,
				browserProvenance: options.browserProvenance,
				fixtureProvenance: options.fixtureProvenance,
			})
		)
	);
}

/**
 * Terminal records the scheduler owes for pairs the executor never reported.
 *
 * Pure, so the mapping is testable without a browser: the caller writes what this
 * returns, and a pair recorded concurrently keeps its real record.
 */
export function gapTerminalsFor(options: {
	readonly plannedPairs: readonly PlannedPair[];
	readonly inventory: Inventory;
	readonly plan: RunPlan;
	readonly results: readonly ItemResult<InventoryEntry>[];
	readonly notStarted: readonly ScheduleItem<InventoryEntry>[];
	readonly recorded: (testId: TestId, laneId: LaneId) => boolean;
	readonly browserProvenance: ProvenanceBundle["browser"];
	readonly fixtureProvenance: ProvenanceBundle["fixtures"];
}): readonly TerminalRecordInput[] {
	const byKey = new Map<string, ItemResult<InventoryEntry>>();
	for (const result of options.results) byKey.set(result.item.key, result);
	const neverStarted = new Set(options.notStarted.map((item) => item.key));

	const gaps: TerminalRecordInput[] = [];
	for (const pair of options.plannedPairs) {
		if (options.recorded(pair.testId, pair.laneId)) continue;
		const entry = options.inventory.byId.get(pair.testId);
		const lanePlan = options.plan.lanes.find((lane) => lane.laneId === pair.laneId);
		const mapped = gapOutcomeFor(
			neverStarted.has(pair.testId) ? null : byKey.get(pair.testId) ?? null
		);
		gaps.push(
			gapRecordFor({
				pair,
				entry,
				lanePlan,
				outcome: mapped.outcome,
				summary: mapped.summary,
				browserProvenance: options.browserProvenance,
				fixtureProvenance: options.fixtureProvenance,
			})
		);
	}
	return Object.freeze(gaps);
}

/** What a per-item seal needs. Everything is data the run already has. */
export type ItemSealer = {
	readonly recorder: RunRecorder;
	readonly inventory: Inventory;
	readonly plan: RunPlan;
	/** Planned pairs per test, from the plan's snapshot. */
	readonly pairsByTest: ReadonlyMap<TestId, readonly PlannedPair[]>;
	readonly browserProvenance: ProvenanceBundle["browser"];
	readonly fixtureProvenance: ProvenanceBundle["fixtures"];
	/**
	 * Pairs sealed but not yet written down, per test.
	 *
	 * The seal has to be synchronous and the writing cannot be, so what the seal
	 * decided is remembered here until {@link sealConcludedItem} can write it.
	 */
	readonly owed: Map<TestId, readonly PlannedPair[]>;
	/**
	 * Tests whose seal could not be taken, and why.
	 *
	 * A seal that failed is not a detail to log and move on from: the run no longer
	 * knows whether the pair's admissions are open, so it cannot vouch for anything
	 * recorded against them. The run reads this after the schedule and fails.
	 */
	readonly faults: Map<TestId, RunwayError>;
};

/** Builds a sealer around a recorder. Both ledgers start empty. */
export function createItemSealer(input: Omit<ItemSealer, "owed" | "faults">): ItemSealer {
	return {
		...input,
		owed: new Map<TestId, readonly PlannedPair[]>(),
		faults: new Map<TestId, RunwayError>(),
	};
}

/**
 * {@link sealItemAdmissions}, guaranteed not to throw. Returns the failure instead.
 *
 * This is what the scheduler's `onConclude` is given, because that hook runs inside
 * a timer callback and inside an abort listener: an exception there has no caller
 * to catch it. The failure is recorded on the sealer so the run can fail *itself*
 * afterwards, in a place where failing is a recorded outcome rather than a crash.
 *
 * The scheduler also guards hooks that throw, for any caller. This is not a reason
 * to rely on that guard: a hook that throws leaves the item's admissions in an
 * unknown state, and the only thing the guard can do is refuse to count the item.
 * Catching here keeps the abort, the cleanup and the rest of the accounting running.
 */
export function sealItemAdmissionsSafely(
	sealer: ItemSealer,
	testId: TestId
): RunwayError | null {
	try {
		sealItemAdmissions(sealer, testId);
		return null;
	} catch (cause) {
		const error = toRunwayError(cause);
		// First failure per test is kept: later attempts are consequences of it.
		if (!sealer.faults.has(testId)) sealer.faults.set(testId, error);
		return error;
	}
}

/**
 * Writes the run's admission-integrity report: one structured diagnostic per pair
 * of every test whose admissions could not be closed.
 *
 * Returns the pairs the log would not accept, and **never throws**. Writing this
 * report can itself fail, and for the most likely cause of a seal fault — a log
 * that can no longer be written — it will. Letting that escape would replace the
 * fault being reported with the secondary failure of reporting it, and would skip
 * the pairs after the first one.
 *
 * What cannot be repaired here is stated rather than hidden: a fault that could not
 * be written to the log is not readable back out of the log, so a later offline
 * comparison of that directory cannot know which pairs were affected. Such a run
 * still fails — it never reaches its own `runFinished`, so `completion.successful`
 * is false and the exit code is 1 — but the pair-level withdrawal depends on the
 * record having been written. The caller names the gap in the error it throws.
 */
export async function reportAdmissionIntegrityFaults(
	recorder: Pick<RunRecorder, "diagnostic">,
	faults: ReadonlyMap<TestId, RunwayError>,
	pairsByTest: ReadonlyMap<TestId, readonly PlannedPair[]>
): Promise<readonly string[]> {
	const unreportable: string[] = [];
	for (const [testId, fault] of faults) {
		for (const pair of pairsByTest.get(testId) ?? []) {
			try {
				await recorder.diagnostic(
					"error",
					`the admissions of ${pair.testId} on ${pair.laneId} could not be closed ` +
						`(${fault.code}: ${fault.message}).`,
					{
						testId: pair.testId,
						laneId: pair.laneId,
						details: { code: ADMISSION_INTEGRITY_CODE, fault: fault.toJSON() },
					}
				);
			} catch {
				unreportable.push(`${pair.testId} on ${pair.laneId}`);
			}
		}
	}
	return Object.freeze(unreportable);
}

/**
 * Refuses further outcomes for whatever this test still owes. Synchronous.
 *
 * Called at the scheduler's deadline/cancellation boundary, before the item's
 * signal is aborted — which is the last moment before the item's own abort
 * listener runs and can try to report a result it no longer has a claim to. It
 * completes in one turn and takes no locks, so nothing can interleave: after it
 * returns, `recordTerminal` for any pair it named is `record/stale-terminal`.
 *
 * Pairs that already hold a real record are left alone. Sealing withdraws a claim
 * that was never used; it never overwrites an outcome that happened.
 *
 * Writing the gap records is deliberately *not* done here — writing needs `await`,
 * and this must not. {@link sealConcludedItem} does that afterwards.
 */
export function sealItemAdmissions(
	sealer: ItemSealer,
	testId: TestId
): readonly PlannedPair[] {
	const pairs = sealer.pairsByTest.get(testId) ?? [];
	const owed = sealer.recorder.sealOutstanding(pairs);
	if (owed.length > 0) {
		sealer.owed.set(testId, [...(sealer.owed.get(testId) ?? []), ...owed]);
	}
	return owed;
}

/**
 * Writes the terminals a concluded item owes.
 *
 * Runs at the item's conclusion, after {@link sealItemAdmissions} has already
 * refused further outcomes for those pairs — at a boundary, in the same turn as the
 * abort. For an item that concluded normally no boundary fired, so the seal happens
 * here instead; either way the pairs are closed before anything is written, and a
 * pair the executor really did record keeps its own record.
 */
export async function sealConcludedItem(
	sealer: ItemSealer,
	testId: TestId,
	result: ItemResult<InventoryEntry> | null
): Promise<readonly TerminalRecordInput[]> {
	// Covers the normal conclusions, where no boundary hook fired. Idempotent for
	// the boundary case: those pairs are already sealed and already in the ledger.
	// Safe, because a seal that failed at the boundary is likely to fail again, and
	// this runs where the run is still accounting rather than crashing.
	sealItemAdmissionsSafely(sealer, testId);
	const owed = sealer.owed.get(testId) ?? [];
	sealer.owed.delete(testId);
	if (owed.length === 0) return Object.freeze([]);
	const entry = sealer.inventory.byId.get(testId);
	const fault = sealer.faults.get(testId);
	const gaps = fault
		? // The seal failed, so whatever the scheduler concluded about this item is
			// not something the run can stand behind. The pairs get the fault itself,
			// named, instead of an outcome derived from a conclusion this run cannot
			// vouch for.
			owed.map((pair) =>
				gapRecordFor({
					pair,
					entry,
					lanePlan: sealer.plan.lanes.find((lane) => lane.laneId === pair.laneId),
					outcome: "infrastructureError",
					summary: `this pair's admissions could not be closed: ${fault.code}: ${fault.message}`,
					browserProvenance: sealer.browserProvenance,
					fixtureProvenance: sealer.fixtureProvenance,
				})
			)
		: gapTerminalsFor({
				plannedPairs: owed,
				inventory: sealer.inventory,
				plan: sealer.plan,
				results: result ? [result] : [],
				notStarted:
					result || !entry
						? []
						: [{ key: testId, payload: entry } satisfies ScheduleItem<InventoryEntry>],
				// `sealOutstanding` already excluded pairs that hold a real record.
				recorded: () => false,
				browserProvenance: sealer.browserProvenance,
				fixtureProvenance: sealer.fixtureProvenance,
			});
	const written: TerminalRecordInput[] = [];
	for (const gap of gaps) {
		if ((await sealer.recorder.recordGapTerminal(gap)) !== null) written.push(gap);
	}
	return Object.freeze(written);
}

/**
 * Stand-in lane for in-process tests.
 *
 * It carries the planned lane's identity and role so the record is attributed
 * correctly, and it deliberately cannot open an attempt.
 */
function inProcessLane(laneId: LaneId, plan: RunPlan): Lane {
	const lanePlan = plan.lanes.find((lane) => lane.laneId === laneId);
	return Object.freeze({
		laneId,
		role: lanePlan?.role ?? "candidate",
		provenance: {
			laneId,
			role: lanePlan?.role ?? "candidate",
			adapter: "in-process",
			loaded: {},
		},
		origin: "in-process",
		openAttempt: () => {
			throw new RunwayError(
				"lane/init-failed",
				"in-process tests do not open a browser attempt",
				{ details: { laneId } }
			);
		},
	});
}

/**
 * One run's cleanup ownership.
 *
 * A run acquires resources in stages — fixtures, then a browser — and must release
 * them exactly once however it ends. The `finally` in {@link executeRun} is the
 * only place that releases, and the only question it answers is "what has been
 * acquired so far": resources are registered at acquisition, never released
 * anywhere else, and `release()` is idempotent — a second call is a no-op, so an
 * `async finally` cannot double-close or let a second failure mask the first.
 *
 * The disposals themselves are best-effort in the precise sense that each one is
 * attempted whatever the others do, and every failure is reported, but none throws.
 */
/**
 * Dispatches one WPT case.
 *
 * The honest division of labour, and the reason this function is explicit about
 * what it will not do:
 *
 * - **Reference lane.** A bare browser loading the upstream case over plain HTTP.
 *   The logical URL *is* the physical URL, so the identity mapping is a true
 *   statement rather than a stand-in, and the case frame is a real page's main
 *   frame designated before navigation. This executes.
 * - **Candidate lane.** The case must be loaded through the proxy, which means
 *   somebody has to say which physical URL a logical one became. No route owner
 *   exports that mapping yet. Supplying an "always match" mapper would fabricate
 *   the attribution the ledger exists to check, so the lane records a setup failure
 *   naming the missing seam instead. The pair keeps its place in the denominator.
 *
 * Nothing here grants `proxyRoute`: that needs a host-side ingress observation on
 * the attempt's own socket, which is a separate module still being built.
 */
/**
 * Builds the reference lane's host attachment.
 *
 * Constructed per attempt, because the page it needs only exists once the lane has
 * opened one. A dedicated page is opened in the attempt's own context so the lane's
 * harness page is left exactly as the lane owns it — this code does not reach into
 * `browser-lane.ts`, it only uses the `Page` the public lane contract already hands
 * over.
 *
 * The mapping is the identity, and that is a statement of fact rather than a
 * placeholder: on the reference lane the browser really does load the upstream URL
 * unchanged, so `observedUrl === physicalUrl` is the correct verification. The
 * candidate lane is *not* served by this function precisely because the equivalent
 * statement there would be false.
 */
function laneDispatchingHost(): WptHostAttachment {
	return {
		designateCaseFrame: async (request) => {
			if (request.lane.role !== "reference") {
				return candidateCaseFrame(request);
			}
			const laneAttempt = request.attempt;
			const context = laneAttempt.page.context();
			// A page of this attempt's own, closed with it.
			const casePage = await context.newPage();
			const attachment = createWptHostAttachment({
				context,
				page: casePage,
				caseFrame: mainFrameCase(),
				routeMapping: {
					toPhysical: (logicalUrl) => logicalUrl,
					verify: ({ observedUrl, physicalUrl }) =>
						observedUrl === physicalUrl ? "match" : "mismatch",
				},
			});
			const frame = await attachment.designateCaseFrame(request);
			return Object.freeze({
				...frame,
				dispose: async () => {
					// The attachment's own teardown first — it removes this attempt's
					// binding and init script — then the page this function opened.
					try {
						await frame.dispose();
					} finally {
						await casePage.close({ runBeforeUnload: false });
					}
				},
			});
		},
	};
}

/**
 * Designates the case frame on a candidate lane, through the lane's own integration.
 *
 * Nothing here decides which frame the case runs in: the lane hands over the
 * `Frame` its controller created, located from an element handle captured before
 * anything was navigated. This function only refuses what the lane says it cannot
 * carry, and wires the lane's mapping into the adapter.
 *
 * Every refusal is a structured capability absence. There is no fallback to the
 * reference path — running a candidate case on a reference attachment would report
 * an unproxied document as the candidate's result.
 */
async function candidateCaseFrame(
	request: Parameters<WptHostAttachment["designateCaseFrame"]>[0]
): Promise<WptCaseFrame> {
	const { attempt, lane, logicalUrl } = request;
	if (attempt.hostIntegration === undefined) {
		throw new RunwayError(
			"fixtures/capability-unavailable",
			`the ${lane.laneId} lane exposes no host integration, so no case frame can be designated`,
			{ details: { laneId: lane.laneId, role: lane.role } }
		);
	}
	const capability = await attempt.hostIntegration();
	if (!capability.available) {
		throw new RunwayError("fixtures/capability-unavailable", capability.reason, {
			details: { laneId: lane.laneId, ...(capability.detail ?? {}) },
		});
	}
	const integration = capability.value;

	/*
	 * The downgrade guard, for the whole attempt and before anything is navigated.
	 *
	 * Disabling the wrapper outright is the only sufficient guard: clearing the host
	 * list leaves its loopback fallback, which rewrites `https://localhost` — and the
	 * upstream server this suite talks to is on localhost. With it off, an `https:`
	 * subresource either travels as real TLS or fails; it can no longer be silently
	 * carried as cleartext and then reported as a secure-context result.
	 */
	await attempt.configureCleartext({ hosts: [], site: null, enabled: false });

	// Asked before navigation, and refused rather than downgraded.
	const admission = integration.admitsLogicalUrl(logicalUrl);
	if (!admission.admitted) {
		throw new RunwayError("fixtures/capability-unavailable", admission.reason, {
			details: {
				laneId: lane.laneId,
				logicalUrl,
				transport: integration.transport.engine,
				cleartextHttpsActive: integration.transport.cleartextHttpsActive,
				realTls: integration.transport.realTls,
			},
		});
	}

	const attachment = createWptHostAttachment({
		context: integration.page.context(),
		page: integration.page,
		// The lane's own locator: an element handle captured before navigation,
		// resolved through Playwright's element->frame link. Never a URL or name
		// lookup, and never re-selected by CSS after the guest has loaded.
		caseFrame: integration.caseFrame,
		// The route owner's mapping, used directly. This module does not rewrite.
		routeMapping: integration.routeMapping,
	});
	return attachment.designateCaseFrame(request);
}

async function dispatchWptCase(input: {
	readonly entry: InventoryEntry;
	readonly plannedLaneIds: readonly LaneId[];
	readonly signal: AbortSignal;
	readonly plan: RunPlan;
	readonly lanes: ReadonlyMap<LaneId, Lane>;
	readonly recorder: RunRecorder;
	readonly browser: BrowserOwner | null;
	readonly fixtures: LocalFixtures | null;
	readonly wptServer: WptServerHandle | null;
	readonly wptFailure: string | null;
}): Promise<void> {
	const { entry, plan, recorder } = input;
	const browserProvenance = input.browser?.provenance ?? {
		engine: "none",
		version: "n/a",
		selection: plan.browser.selection.kind,
		selector: plan.browser.selection.selector,
		binarySha256: null,
		explicitlySelected: plan.browser.selection.explicitlySelected,
	};
	const fixtureProvenance = [
		...(input.fixtures?.provenance ?? []),
		...(input.wptServer ? [input.wptServer.provenance] : []),
	];
	const emitSetupFailure = async (summary: string, lanesToFail: readonly LaneId[]): Promise<void> => {
		for (const laneId of lanesToFail) {
			const at = new Date().toISOString();
			await recorder.recordTerminal({
				testId: entry.testId,
				laneId,
				nonce: createNonce(),
				startedAt: at,
				finishedAt: at,
				durationMs: 0,
				outcome: "setupError",
				summary,
				evidence: {
					nonceEcho: false,
					ownerSignal: "notRequired",
					resultChannel: "page",
					hostOwned: false,
					artifacts: [],
					truncations: [],
				},
				provenance: {
					browser: browserProvenance,
					lane: plan.lanes.find((lane) => lane.laneId === laneId)
						? {
								laneId,
								role:
									plan.lanes.find((lane) => lane.laneId === laneId)?.role ?? "reference",
								adapter:
									plan.lanes.find((lane) => lane.laneId === laneId)?.adapter ?? "bare",
								loaded: {},
							}
						: { laneId, role: "reference", adapter: "bare", loaded: {} },
					fixtures: fixtureProvenance,
				},
				requiredCapabilities: [...entry.requiredCapabilities],
			});
		}
	};

	if (input.wptServer === null) {
		await emitSetupFailure(
			input.wptFailure ??
				"the WPT suite could not be brought up, so this case was not executed",
			input.plannedLaneIds
		);
		return;
	}

	/*
	 * The case's execution metadata comes from the plan's own snapshot.
	 *
	 * `prepareRun` recorded the upstream URL and the harness timeout this case was
	 * planned with; the entry here was rebuilt from that snapshot. Reading them back
	 * is what makes the case that runs the case that was planned.
	 */
	const upstreamUrl = entry.meta?.upstreamUrl;
	if (typeof upstreamUrl !== "string" || upstreamUrl.length === 0) {
		await emitSetupFailure(
			`the plan's snapshot for ${entry.testId} records no upstream URL, so there is ` +
				"nothing to dispatch",
			input.plannedLaneIds
		);
		return;
	}
	const recordedTimeout = entry.meta?.harnessTimeoutMs;
	if (recordedTimeout !== null && typeof recordedTimeout !== "number") {
		await emitSetupFailure(
			`the plan's snapshot for ${entry.testId} records no usable harness timeout`,
			input.plannedLaneIds
		);
		return;
	}

	// Split the planned lanes by what can actually be attached today.
	const executable: Lane[] = [];
	const unattachable: LaneId[] = [];
	for (const laneId of input.plannedLaneIds) {
		const lane = input.lanes.get(laneId);
		if (!lane) {
			unattachable.push(laneId);
			continue;
		}
		executable.push(lane);
	}

	if (unattachable.length > 0) {
		await emitSetupFailure(
			"this lane has no WPT host attachment: a candidate lane needs the route owner's " +
				"logical->physical mapping to designate and verify the guest case frame, and no " +
				"such mapping is exported yet. It is recorded as a setup failure rather than run " +
				"with a mapping that would report every document as the expected one.",
			unattachable
		);
	}
	if (executable.length === 0) return;

	await executeWptCase({
		entry,
		harnessTimeoutMs: recordedTimeout ?? null,
		lanes: executable,
		signal: input.signal,
		defaultDeadlineMs: plan.schedule.defaultDeadlineMs,
		serverOrigin: input.wptServer.origin,
		browserProvenance,
		fixtureProvenance,
		host: laneDispatchingHost(),
		emit: (record) => recorder.recordTerminal(record).then(() => undefined),
		// Top level, unchanged: the fault reader requires the pair there.
		diagnostic: (diagnosticInput) =>
			recorder.diagnostic(diagnosticInput.level, diagnosticInput.message, {
				testId: diagnosticInput.testId,
				laneId: diagnosticInput.laneId,
				...(diagnosticInput.details ? { details: diagnosticInput.details } : {}),
			}),
	});
}

export type RunCleanup = {
	/** Number of disposals that have been registered but not yet run. For tests. */
	readonly pendingCount: () => number;
	/**
	 * Registers a disposal. Called at acquisition, before anything can fail.
	 *
	 * Throws once the ledger has released. A ledger that accepted a disposal it
	 * will never run would report ownership it does not have, and the resource
	 * would leak with nothing recorded — so the registration is refused loudly
	 * instead. Closing the late resource here is not an option either: `register`
	 * is synchronous, so a close started from it could not be awaited, and an
	 * unawaited close is the same leak with a different shape.
	 */
	readonly register: (disposal: OwnedDisposal) => void;
	/**
	 * Runs every registered disposal, in reverse acquisition order, exactly once.
	 * Never throws: collects what failed so the caller can keep it structured.
	 */
	readonly release: () => Promise<readonly RunwayError[]>;
};

/** One thing a run owns, and what releasing it means. */
export type OwnedDisposal = {
	readonly what: string;
	readonly close: () => Promise<unknown>;
};

/** Builds the cleanup ledger for one run. Starts empty and unreleased. */
export function createRunCleanup(): RunCleanup {
	const disposals: OwnedDisposal[] = [];
	let released = false;
	let inFlight: Promise<readonly RunwayError[]> | null = null;
	return Object.freeze({
		pendingCount: () => (released ? 0 : disposals.length),
		register: (disposal) => {
			if (released) {
				// A contract violation, not a runtime condition: every acquisition in
				// `executeRun` happens inside the `try`, and the ledger only releases
				// from the `finally`, so nothing can reach this line today. It is a
				// guard against a future acquisition being added after the boundary,
				// where a silent drop would leak the resource and report nothing.
				throw new RunwayError(
					"internal/unexpected",
					`the run's cleanup ledger has already released; it cannot take ownership of ${disposal.what}`,
					{
						details: { what: disposal.what },
						remedy:
							"Acquire and register resources inside the run's accounted boundary. " +
							"A resource acquired after teardown must be closed by whoever acquired it.",
					}
				);
			}
			disposals.push(disposal);
		},
		release: () => {
			// Memoized before the first await: concurrent callers share one
			// settlement, so `finally` and a racing caller cannot each close the
			// same browser.
			inFlight ??= (async () => {
				released = true;
				const failures: RunwayError[] = [];
				for (const disposal of disposals.reverse()) {
					try {
						await disposal.close();
					} catch (cause) {
						failures.push(toRunwayError(cause));
					}
				}
				disposals.length = 0;
				return Object.freeze(failures);
			})();
			return inFlight;
		},
	});
}

/**
 * Reports what failed while holding each value's place.
 *
 * The original failure is always primary: the message names it, the code is its
 * code, and it is the `cause`. Secondary failures — recording diagnostics, gap
 * accounting, releases that did not complete, closing the log — are kept as
 * structured data under `details.secondary`, each with the phase it came from, so
 * nothing is merged into the message and nothing is dropped. A run that failed and
 * then failed again is still the first failure's story.
 */
/** What a secondary failure looks like: JSON-safe, with the phase that produced it. */
export type SecondaryFailure = {
	readonly phase: string;
	readonly error: SerializedRunwayError | { readonly message: string; readonly stack?: string };
};

export function primaryFailureWith(
	cause: unknown,
	secondary: readonly SecondaryFailure[]
): RunwayError {
	const primary = toRunwayError(cause);
	if (secondary.length === 0) return primary;
	return new RunwayError(primary.code, primary.message, {
		details: {
			...primary.details,
			// This error is a reconstruction — same code, same message, same details —
			// but not the same object, so the primary's own stack would otherwise be
			// gone: the reconstruction's stack points here, at the wrapper, not at
			// whatever actually threw. The original is kept as serializable data
			// rather than as the `cause`, because `cause` already holds the primary's
			// own cause and overwriting it would bury the real origin one level
			// deeper to save a stack.
			...(primary.stack === undefined ? {} : { primaryStack: primary.stack }),
			secondary: secondary.map((entry) => ({ phase: entry.phase, error: entry.error })),
		},
		...(primary.remedy ? { remedy: primary.remedy } : {}),
		// The cause is the primary's own cause, not the primary: wrapping it one
		// more level would bury what actually failed under a copy of itself.
		...(primary.cause === undefined ? {} : { cause: primary.cause }),
	});
}
