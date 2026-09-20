/**
 * Option → configuration resolution.
 *
 * Every check that can be made without importing a test module happens here,
 * once, and the result is an immutable {@link RunConfiguration}. Failures name the
 * flag or file that fixes them. After this function returns, configuration no
 * longer exists as mutable state anywhere in the process.
 *
 * The denominator is not decided here. A configuration becomes a {@link RunPlan}
 * only once the suite inventory has been built and snapshotted, because the plan
 * hash covers the planned tests and pairs as well as the settings.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { RunwayError } from "../core/errors.ts";
import { createRunId, laneId, suiteId } from "../core/ids.ts";
import { createRunConfiguration, type LanePlan, type RunConfiguration } from "../core/plan.ts";
import { resolveBrowserSelection } from "../browser/selection.ts";
import { resolveAssetDirectory } from "../fixtures/assets.ts";
import type { RunwayOptions } from "./options.ts";

/** Lane adapters this build implements. */
export const KNOWN_LANES = {
	bare: { adapter: "bare", role: "reference" },
	scramjet: { adapter: "scramjet", role: "candidate" },
} as const satisfies Readonly<
	Record<string, { adapter: LanePlan["adapter"]; role: LanePlan["role"] }>
>;

/**
 * Suite adapters this build implements.
 *
 * `wpt` is the upstream suite. Its cases come from an inventory manifest generated
 * from a real upstream checkout, so selecting it requires `--wpt-manifest`.
 */
export const KNOWN_SUITES = ["native", "wpt"] as const;

/** Suite id prefix every WPT selection lives under (`wpt/url`, `wpt/serviceworker`). */
export const WPT_SUITE_NAME = "wpt";

export type ResolveContext = {
	/**
	 * Directory every relative input is resolved against.
	 *
	 * Captured once at the process boundary (the CLI passes `process.cwd()`), and
	 * required here: a programmatic caller that names a different directory must
	 * get *its* plugin profile, assets, browser binary and output root, not the
	 * runner's ambient ones.
	 */
	readonly cwd: string;
	readonly now?: Date;
};

function requireExistingFile(
	cwd: string,
	value: string,
	description: string,
	remedy: string
): string {
	const resolved = path.resolve(cwd, value);
	if (!existsSync(resolved) || !statSync(resolved).isFile()) {
		throw new RunwayError(
			"config/missing-input",
			`${description} does not exist: ${resolved}`,
			{ remedy }
		);
	}
	return resolved;
}

/** Builds the immutable run configuration from merged options. */
export function resolveRunConfiguration(
	options: RunwayOptions,
	context: ResolveContext
): RunConfiguration {
	const laneNames = options.lanes?.value ?? ["bare", "scramjet"];
	const lanes: LanePlan[] = laneNames.map((name) => {
		const known = (KNOWN_LANES as Record<string, { adapter: LanePlan["adapter"]; role: LanePlan["role"] } | undefined>)[name];
		if (!known) {
			throw new RunwayError(
				"config/invalid-option",
				`unknown lane ${JSON.stringify(name)}`,
				{
					details: { known: Object.keys(KNOWN_LANES) },
					remedy: `Use --lanes with one or more of: ${Object.keys(KNOWN_LANES).join(", ")}.`,
				}
			);
		}
		const manifest = options.pluginManifest?.value;
		return {
			laneId: laneId(name),
			adapter: known.adapter,
			role: known.role,
			pluginManifestPath:
				known.adapter === "scramjet" && manifest
					? requireExistingFile(
							context.cwd,
							manifest,
							"the plugin manifest (--plugin-manifest)",
							"Point --plugin-manifest at an existing profile JSON file."
						)
					: null,
		};
	});

	const suiteNames = options.suites?.value ?? ["native"];
	const suites = suiteNames.map((name) => {
		if (!(KNOWN_SUITES as readonly string[]).includes(name)) {
			throw new RunwayError(
				"config/invalid-option",
				`unknown suite ${JSON.stringify(name)}`,
				{
					details: { known: KNOWN_SUITES },
					// The native-only remedy is retired here because `wpt` really is wired
					// now. What it is *not* is complete: see the WPT resolution below,
					// which refuses rather than pretending about the parts that are unmet.
					remedy: `This build implements: ${KNOWN_SUITES.join(", ")}.`,
				}
			);
		}
		return { suite: suiteId(name), filters: options.filters?.value ?? [] };
	});

	/*
	 * WPT inputs are resolved, not read.
	 *
	 * Only the shape of the arguments is checked here: whether a manifest was named
	 * at all, and what absolute path it resolves to. Parsing it is the run's job, so
	 * that a missing or malformed manifest is recorded against the plan's pairs
	 * instead of throwing before a run exists.
	 */
	const wantsWpt = suiteNames.includes(WPT_SUITE_NAME);
	if (!wantsWpt && options.wptManifest) {
		throw new RunwayError(
			"config/conflicting-inputs",
			"--wpt-manifest was given but the wpt suite was not selected",
			{
				details: { suites: suiteNames, source: options.wptManifest.source },
				remedy: "Add --suite wpt, or drop --wpt-manifest.",
			}
		);
	}
	const wpt = wantsWpt
		? (() => {
				if (!options.wptManifest) {
					throw new RunwayError(
						"config/missing-input",
						"the wpt suite needs an inventory manifest",
						{
							remedy:
								"Pass --wpt-manifest <path>. Generate one with " +
								"scripts/generate-serviceworker-wpt.py against the upstream checkout you " +
								"intend to run; the manifest is the denominator and is never inferred.",
						}
					);
				}
				const serverConfig = options.wptServerConfig
					? path.resolve(context.cwd, options.wptServerConfig.value)
					: null;
				const root = options.wptRoot ? path.resolve(context.cwd, options.wptRoot.value) : null;
				// Both or neither: a checkout without a config cannot be served, and a
				// config without a checkout has nothing to serve.
				if ((root === null) !== (serverConfig === null)) {
					throw new RunwayError(
						"config/missing-input",
						"--wpt-root and --wpt-server-config must be given together",
						{
							details: { wptRoot: root, serverConfig },
							remedy:
								"Supply both to have this run start the official wptserve, or neither to " +
								"plan the inventory without executing any case.",
						}
					);
				}
				return Object.freeze({
					manifestPath: path.resolve(context.cwd, options.wptManifest.value),
					allowIncomplete: options.wptAllowIncomplete?.value ?? false,
					wptRoot: root,
					serverConfigPath: serverConfig,
				});
			})()
		: null;

	const insecure = options.insecureDiagnostics?.value ?? false;
	const browserSelection = resolveBrowserSelection({
		cwd: context.cwd,
		...(options.browserExecutable
			? {
					executablePath: {
						value: options.browserExecutable.value,
						source: options.browserExecutable.source,
					},
				}
			: {}),
		...(options.browserChannel
			? {
					channel: {
						value: options.browserChannel.value,
						source: options.browserChannel.source,
					},
				}
			: {}),
		...(options.browserBundled
			? {
					bundled: {
						value: options.browserBundled.value,
						source: options.browserBundled.source,
					},
				}
			: {}),
	});

	const outputRoot = path.resolve(context.cwd, options.outputDir?.value ?? "runway-output");
	const runIdentifier = createRunId(context.now);

	return createRunConfiguration({
		runId: runIdentifier,
		createdAt: (context.now ?? new Date()).toISOString(),
		browser: {
			selection: browserSelection,
			headless: !(options.headed?.value ?? false),
			// The only argument Runway adds is the labelled diagnostic bypass.
			args: insecure ? ["--ignore-certificate-errors"] : [],
			insecureDiagnostics: insecure,
		},
		lanes,
		suites,
		wpt,
		localFixtures: {
			scramjetDist: resolveAssetDirectory("scramjet", {
				cwd: context.cwd,
				...(options.scramjetDist ? { override: options.scramjetDist.value } : {}),
			}).directory,
			controllerDist: resolveAssetDirectory("controller", {
				cwd: context.cwd,
				...(options.controllerDist ? { override: options.controllerDist.value } : {}),
			}).directory,
			libcurlDist: resolveAssetDirectory("libcurl", {
				cwd: context.cwd,
				...(options.libcurlDist ? { override: options.libcurlDist.value } : {}),
			}).directory,
			// 0 means "ask the operating system"; actual ports are read back from the
			// listening sockets and recorded with the run.
			requestedHarnessPort: options.harnessPort?.value ?? 0,
			requestedWispPort: options.wispPort?.value ?? 0,
			requestedBarePort: options.barePort?.value ?? 0,
		},
		schedule: {
			concurrency: options.concurrency?.value ?? 1,
			defaultDeadlineMs: options.deadlineMs?.value ?? 60_000,
			setupDeadlineMs: 30_000,
		},
		diagnostics: {
			collectCoverage: options.coverage?.value ?? false,
			traceConsole: options.traceConsole?.value ?? false,
		},
		output: {
			root: outputRoot,
			runDirectory: path.join(outputRoot, runIdentifier),
		},
		expectationsPath: options.expectations
			? requireExistingFile(
					context.cwd,
					options.expectations.value,
					"the expectations file (--expectations)",
					"Point --expectations at an existing JSON file, or omit it."
				)
			: null,
	});
}
