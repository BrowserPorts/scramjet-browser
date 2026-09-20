/**
 * Interactive inspect.
 *
 * Opens one inventoried test on one lane and keeps the browser open. Inspect is
 * a diagnostic session, not a conformance run: it writes no records and does not
 * produce a verdict. The same browser owner, fixtures and lane adapters as `run`
 * are used, so what you see is the same process a recorded run would drive.
 */
import { option, type RunwayOptions } from "../config/options.ts";
import { resolveRunConfiguration } from "../config/resolve.ts";
import { RunwayError } from "../core/errors.ts";
import { createNonce } from "../core/ids.ts";
import { CAPABILITIES } from "../core/inventory.ts";
import { launchBrowser } from "../browser/owner.ts";
import { startLocalFixtures } from "../fixtures/servers.ts";
import { loadPluginProfile } from "../fixtures/plugin-profile.ts";
import { createBrowserLane } from "../lanes/browser-lane.ts";
import { prepareRun } from "../run.ts";
import type { CliWriters } from "./program.ts";

export type InspectContext = {
	readonly cwd: string;
	readonly writers: CliWriters;
	/** Interrupt signal owned by the entry point; inspect waits on it. */
	readonly signal?: AbortSignal;
};

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
	if (!signal) return Promise.resolve();
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

/** Inspect is headed unless the caller asked for headless with `--headed=false`. */
function inspectOptions(options: RunwayOptions): RunwayOptions {
	if (options.headed) return options;
	return { ...options, headed: option(true, "cli", "inspect") };
}

export async function commandInspect(
	options: RunwayOptions,
	context: InspectContext
): Promise<number> {
	const say = (line: string): void => context.writers.out(`${line}\n`);
	const configuration = resolveRunConfiguration(inspectOptions(options), { cwd: context.cwd });
	const prepared = await prepareRun(configuration);
	const plan = prepared.plan;
	if (prepared.inventory.entries.length === 0) {
		throw new RunwayError("config/missing-input", "inspect needs a filter that matches one test", {
			remedy: "Pass a unique test name, e.g. `runway inspect sanity-01`.",
		});
	}
	if (prepared.inventory.entries.length > 1) {
		const names = prepared.inventory.entries.map((entry) => entry.localName);
		throw new RunwayError(
			"config/invalid-option",
			`inspect matches ${names.length} tests; name exactly one`,
			{
				details: { matches: names.slice(0, 20) },
				remedy: "Narrow the filter until a single test remains. `runway list --filter …` lists them.",
			}
		);
	}

	const entry = prepared.inventory.entries[0]!;
	const test = prepared.discovery.tests.get(entry.testId);
	if (!test) {
		throw new RunwayError("suite/discovery-failed", `no discovered test backs ${entry.testId}`, {
			details: { testId: entry.testId },
		});
	}

	say(`inspect ${entry.testId}`);
	say(`execution ${test.execution.kind}`);
	say(`this session is diagnostic and is not a recorded run`);

	if (test.execution.kind === "node") {
		say("this test runs in the Node process; there is no harness to attach");
		return 0;
	}

	const scramjetLane = plan.lanes.find((lane) => lane.adapter === "scramjet");
	const profile = await loadPluginProfile(scramjetLane?.pluginManifestPath ?? null);
	const fixtures = await startLocalFixtures({ plan: plan.localFixtures, profile });
	const browser = await launchBrowser(plan.browser);
	say(`harness ${fixtures.harnessOrigin}`);
	say(`bare    ${fixtures.bareOrigin}`);
	say(`wisp    ${fixtures.wispOrigin}`);
	say(`browser ${browser.provenance.engine} ${browser.provenance.version}`);

	const plannedLaneId = prepared.plannedPairs.find((pair) => pair.testId === entry.testId)?.laneId;
	const lanePlan =
		plan.lanes.find((lane) => lane.laneId === plannedLaneId) ??
		plan.lanes.find((lane) => lane.adapter === "scramjet") ??
		plan.lanes[0];
	if (!lanePlan) {
		throw new RunwayError("plan/invalid", "inspect has no lane to open", {});
	}

	const lane = createBrowserLane({
		laneId: lanePlan.laneId,
		role: lanePlan.role,
		adapter: lanePlan.adapter,
		origin: lanePlan.adapter === "scramjet" ? fixtures.harnessOrigin : fixtures.bareOrigin,
		owner: browser,
		loaded: lanePlan.adapter === "scramjet" ? profile.loaded : { "harness:bare": fixtures.bareOrigin },
		...(lanePlan.adapter === "scramjet" ? { routeObservation: fixtures.routeObservation } : {}),
		readyTimeoutMs: plan.schedule.setupDeadlineMs,
		traceConsole: true,
	});

	const controller = new AbortController();
	const nonce = createNonce();
	const attempt = await lane.openAttempt({
		testId: entry.testId,
		nonce,
		signal: controller.signal,
	});

	let inspectedFixture: { stop: () => Promise<void> } | null = null;
	try {
		if (test.execution.kind === "in-page") {
			const fixture = test.execution.createFixture();
			await fixture.start({
				pass: async (message) => {
					say(`fixture pass${message ? `: ${message}` : ""}`);
				},
				fail: async (message) => {
					say(`fixture fail${message ? `: ${message}` : ""}`);
				},
			});
			inspectedFixture = fixture;
			const target = fixture.target();
			fixtures.watchAttempt(nonce, {
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
			await attempt.navigate(target.url);
			say(`navigated ${target.url}`);
		} else {
			say(
				"page-control test: the harness is open; drive it from the inspector. " +
					"Inspect does not run the test body."
			);
		}
		say(`lane ${lanePlan.laneId} origin ${lane.origin}`);
		if (entry.requiredCapabilities.includes(CAPABILITIES.proxyRoute) && lanePlan.role === "candidate") {
			const route = attempt.evidence().routeInstrumentation;
			say(
				route?.matchedTarget
					? `route proven (HTTP on accepted stream ${route.httpOnAcceptedStream})`
					: `route not proven (handshake ${route?.handshakeUpgrades ?? 0} is not proof; accepted streams ${route?.acceptedStreamsToTarget ?? 0}, HTTP on stream ${route?.httpOnAcceptedStream ?? 0})`
			);
		}
		say("leave the window open; Ctrl-C ends the session");
		await waitForAbort(context.signal);
	} finally {
		controller.abort();
		await attempt.dispose().catch(() => undefined);
		if (inspectedFixture) {
			await inspectedFixture.stop().catch(() => undefined);
		}
		await browser.close();
		await fixtures.close();
	}
	return 0;
}
