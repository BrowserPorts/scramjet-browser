/**
 * Runway commands.
 *
 * This layer is thin orchestration: it resolves flags into an immutable
 * configuration, calls the run or comparison API, and writes the result. It holds
 * no state, reads no environment variable, and never exits the process — every
 * command returns an exit code and `cli/bin.ts` applies it.
 *
 * Output discipline: requested data goes to stdout, usage and runtime errors go to
 * stderr, and `--json` means stdout carries exactly one JSON document. Nothing
 * adds colour, so piped output is byte-identical to a terminal's.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import { resolveRunConfiguration } from "../config/resolve.ts";
import type { ComparisonReport } from "../core/compare.ts";
import { RunwayError, toRunwayError } from "../core/errors.ts";
import { createNonce } from "../core/ids.ts";
import { CAPABILITIES } from "../core/inventory.ts";
import { evaluateRecordedRun } from "../core/offline.ts";
import { loadPlan } from "../core/plan.ts";
import {
	PLAN_NAME,
	writeDerivedReport,
	writeReportToPath,
} from "../core/recorder.ts";
import { loadExpectations, NO_EXPECTATIONS } from "../core/expectations.ts";
import { describeSelection } from "../browser/selection.ts";
import { launchBrowser } from "../browser/owner.ts";
import { startLocalFixtures } from "../fixtures/servers.ts";
import { loadPluginProfile } from "../fixtures/plugin-profile.ts";
import { createBrowserLane } from "../lanes/browser-lane.ts";
import { executeRun, prepareRun } from "../run.ts";
import { NATIVE_SUITE } from "../suites/native.ts";
import { commandInspect } from "./inspect.ts";
import {
	buildProgram,
	EXIT_FAILURES,
	EXIT_OK,
	EXIT_USAGE,
	jsonRequested,
	type CliWriters,
	type CommandRequest,
} from "./program.ts";

/** Reads the installed package version. Never hard-coded in source. */
export function packageVersion(): string {
	const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
	const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
	if (typeof parsed.version !== "string" || parsed.version.length === 0) {
		throw new RunwayError("internal/unexpected", `${manifest} declares no version`, {
			details: { manifest },
		});
	}
	return parsed.version;
}

/**
 * Line-oriented view of the raw writers.
 *
 * Commander writes pre-formatted text including newlines; command output is
 * written a line at a time. One place adds the newline so both stay consistent.
 */
type LineWriter = {
	readonly out: (line?: string) => void;
	readonly err: (line?: string) => void;
};

function lines(writers: CliWriters): LineWriter {
	return {
		out: (line = "") => writers.out(`${line}\n`),
		err: (line = "") => writers.err(`${line}\n`),
	};
}

function summarise(report: ComparisonReport, writers: LineWriter): void {
	const totals = report.totals;
	const line = (label: string, value: string | number) =>
		writers.out(`${label.padEnd(20)} ${value}`);
	line("planned pairs", report.plannedPairs);
	line("qualified passes", totals.qualifiedPasses);
	if (totals.rawPassesMissingEvidence > 0) {
		line("passes w/o evidence", totals.rawPassesMissingEvidence);
	}
	line("unexpected failures", totals.unexpectedFailures);
	if (totals.expectedFailures > 0) line("expected failures", totals.expectedFailures);
	if (totals.missing > 0) line("missing records", totals.missing);
	if (totals.sharedFailures > 0) line("shared failures", totals.sharedFailures);
	if (totals.regressions > 0) line("regressions", totals.regressions);
	if (totals.rejectedRecords > 0) line("rejected records", totals.rejectedRecords);
	if (totals.artifactFailures > 0) line("artifact failures", totals.artifactFailures);
	if (totals.integrityFailures > 0) line("integrity failures", totals.integrityFailures);
	line(
		"artifacts verified",
		`${report.evidence.artifactsVerified}/${report.evidence.artifactsDeclared}`
	);

	for (const test of report.tests) {
		for (const lane of test.lanes) {
			if (lane.outcome === "pass" && lane.qualified) continue;
			const flags = [
				lane.expected ? "expected" : null,
				lane.outcome === "pass" && !lane.qualified ? "unqualified" : null,
				lane.evidenceIntact ? null : "artifacts",
			].filter((flag): flag is string => flag !== null);
			writers.out(
				`  ${lane.outcome.padEnd(20)} ${lane.laneId.padEnd(9)} ${lane.testId}` +
					`${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}` +
					`${lane.summary ? ` — ${lane.summary}` : ""}`
			);
			for (const miss of lane.misses) {
				writers.out(`      evidence: ${miss.requirement} — ${miss.detail}`);
			}
			for (const issue of lane.artifactIssues) {
				writers.out(`      artifact: ${issue.code} ${issue.path} — ${issue.detail}`);
			}
		}
	}
	for (const rejected of report.rejectedRecords) {
		writers.out(`  rejected line ${rejected.line}: ${rejected.code} — ${rejected.message}`);
	}
	for (const note of report.notes) writers.out(`note: ${note}`);
}

async function commandRun(request: CommandRequest): Promise<number> {
	const say = lines(request.writers);
	const configuration = resolveRunConfiguration(request.options, { cwd: request.cwd });
	const prepared = await prepareRun(configuration);
	const plan = prepared.plan;
	if (!request.json) {
		say.out(`run   ${plan.runId}`);
		say.out(`plan  ${plan.planHash}`);
		say.out(`pairs ${plan.inventory.pairs.length}`);
	}
	for (const reason of plan.ineligibilityReasons) {
		say.err(`warning: ${reason}`);
	}
	const result = await executeRun({
		plan,
		discovery: prepared.discovery,
		...(request.signal ? { signal: request.signal } : {}),
		...(request.json ? {} : { log: (text: string) => say.out(text) }),
	});
	if (request.json) {
		say.out(JSON.stringify(result.report, null, 2));
	} else {
		summarise(result.report, say);
		say.out(`records ${path.join(result.runDirectory, "events.jsonl")}`);
		say.out(`report  ${path.join(result.runDirectory, "report.json")}`);
	}
	return result.exitCode;
}

async function commandList(request: CommandRequest): Promise<number> {
	const say = lines(request.writers);
	const configuration = resolveRunConfiguration(request.options, { cwd: request.cwd });
	const prepared = await prepareRun(configuration);
	if (request.json) {
		say.out(
			JSON.stringify(
				{
					planHash: prepared.plan.planHash,
					inventoryDigest: prepared.plan.inventory.digest,
					lanes: prepared.plan.lanes.map((lane) => lane.laneId),
					plannedPairs: prepared.plannedPairs.length,
					tests: prepared.plan.inventory.tests,
					skippedModules: prepared.discovery.skippedModules,
				},
				null,
				2
			)
		);
		return EXIT_OK;
	}
	for (const test of prepared.plan.inventory.tests) {
		say.out(`${test.testId.padEnd(52)} ${test.executionMode.padEnd(14)} ${test.lanes.join(",")}`);
	}
	say.out(`${prepared.plan.inventory.tests.length} test(s), ${prepared.plannedPairs.length} pair(s)`);
	for (const skipped of prepared.discovery.skippedModules) {
		say.out(`not inventoried: ${skipped.module} — ${skipped.reason}`);
	}
	return EXIT_OK;
}

/**
 * Verifies the environment a run would need, and owns what it starts.
 *
 * Everything acquired here is registered for release *at the moment it is
 * acquired*, and everything after the first acquisition runs inside a `try` whose
 * `finally` releases in reverse order. The previous shape started the fixture
 * servers, then launched the browser, and only then entered a `try` — so a browser
 * that failed to launch left three listening servers bound and the process alive.
 * A release that itself fails is recorded as a failed check, not swallowed.
 */
async function commandPreflight(request: CommandRequest): Promise<number> {
	const say = lines(request.writers);
	const checks: { name: string; ok: boolean; detail: string }[] = [];
	const record = (name: string, ok: boolean, detail: string): void => {
		checks.push({ name, ok, detail });
		if (!request.json) {
			say.out(`${ok ? "ok  " : "FAIL"} ${name.padEnd(30)} ${detail}`);
		}
	};
	/** Releases, newest first. Registered as resources are acquired. */
	const release: { readonly what: string; readonly close: () => Promise<void> }[] = [];
	const releaseAll = async (): Promise<void> => {
		for (const entry of release.reverse()) {
			try {
				await entry.close();
			} catch (cause) {
				record(
					`release ${entry.what}`,
					false,
					cause instanceof Error ? cause.message : String(cause)
				);
			}
		}
		release.length = 0;
	};

	const configuration = resolveRunConfiguration(request.options, { cwd: request.cwd });
	record("scramjet assets", true, configuration.localFixtures.scramjetDist);
	record("controller assets", true, configuration.localFixtures.controllerDist);
	record("libcurl assets", true, configuration.localFixtures.libcurlDist);
	record(
		"browser selection",
		configuration.browser.selection.explicitlySelected,
		describeSelection(configuration.browser.selection)
	);

	const prepared = await prepareRun(configuration);
	record("plan resolved", true, prepared.plan.planHash);
	const ownerRequired = prepared.inventory.entries.some((entry) =>
		entry.requiredCapabilities.includes(CAPABILITIES.ownerSignal)
	);
	record(
		"owner capability",
		!ownerRequired,
		ownerRequired
			? "tests require a host owner receipt; this build does not provide one"
			: "no test requires owner"
	);
	record(
		"inventory",
		prepared.inventory.entries.length > 0,
		`${prepared.inventory.entries.length} test(s), ${prepared.plannedPairs.length} pair(s)`
	);

	const plan = prepared.plan;
	const scramjetLane = plan.lanes.find((lane) => lane.adapter === "scramjet");
	const profile = await loadPluginProfile(scramjetLane?.pluginManifestPath ?? null);
	record("plugin profile", true, profile.profile.name);

	// From here on every acquisition is paired with its release before the next
	// acquisition is attempted, so a later failure cannot leak an earlier resource.
	const fixtures = await startLocalFixtures({ plan: plan.localFixtures, profile });
	release.push({ what: "local fixtures", close: () => fixtures.close() });
	try {
		record("harness origin", true, fixtures.harnessOrigin);
		record("bare origin", true, fixtures.bareOrigin);
		record("wisp origin", true, fixtures.wispOrigin);

		const browser = await launchBrowser(plan.browser);
		release.push({
			what: "browser",
			close: async () => {
				await browser.close();
			},
		});
		record("browser launched", true, `${browser.provenance.engine} ${browser.provenance.version}`);

		for (const lanePlan of plan.lanes) {
			const lane = createBrowserLane({
				laneId: lanePlan.laneId,
				role: lanePlan.role,
				adapter: lanePlan.adapter,
				origin: lanePlan.adapter === "scramjet" ? fixtures.harnessOrigin : fixtures.bareOrigin,
				owner: browser,
				loaded: lanePlan.adapter === "scramjet" ? profile.loaded : {},
				...(lanePlan.adapter === "scramjet"
					? { routeObservation: fixtures.routeObservation }
					: {}),
				readyTimeoutMs: plan.schedule.setupDeadlineMs,
			});
			const controller = new AbortController();
			try {
				const attempt = await lane.openAttempt({
					testId: prepared.inventory.entries[0]?.testId ?? NATIVE_SUITE,
					nonce: createNonce(),
					signal: controller.signal,
				});
				const evidence = attempt.evidence();
				record(`lane ${lanePlan.laneId}`, true, lane.origin);
				if (lanePlan.role === "candidate") {
					const route = evidence.routeInstrumentation;
					record(
						`lane ${lanePlan.laneId} handshake`,
						true,
						route
							? `${route.handshakeUpgrades} wisp handshake(s); not a route proof`
							: "no host-side handshake observation"
					);
				}
				await attempt.dispose();
			} catch (cause) {
				record(
					`lane ${lanePlan.laneId}`,
					false,
					cause instanceof Error ? cause.message : String(cause)
				);
			}
		}
	} finally {
		await releaseAll();
	}

	const failed = checks.filter((check) => !check.ok);
	if (request.json) {
		say.out(JSON.stringify({ planHash: plan.planHash, checks }, null, 2));
	} else {
		say.out(`${checks.length - failed.length}/${checks.length} checks passed`);
	}
	return failed.length === 0 ? EXIT_OK : EXIT_FAILURES;
}

/**
 * Recomputes a verdict from a recorded run.
 *
 * Offline by construction: the saved plan supplies the denominator, so no test
 * module is imported, no fixture starts, no browser launches and no asset
 * directory is resolved. The original evidence is read, never written; the derived
 * report goes to a new file.
 */
async function commandCompare(request: CommandRequest): Promise<number> {
	const say = lines(request.writers);
	const directory = request.positionals[0];
	if (!directory) {
		throw new RunwayError("config/missing-input", "compare needs a run directory", {
			remedy: "Pass the directory that contains plan.json and events.jsonl.",
		});
	}
	const resolved = path.resolve(request.cwd, directory);
	const plan = await loadPlan(path.join(resolved, PLAN_NAME));
	const expectationsFlag = request.flags.expectations;
	const expectationsPath =
		typeof expectationsFlag === "string"
			? path.resolve(request.cwd, expectationsFlag)
			: plan.expectationsPath;
	const expectations = expectationsPath
		? await loadExpectations(expectationsPath)
		: NO_EXPECTATIONS;
	const evaluation = await evaluateRecordedRun({
		plan,
		runDirectory: resolved,
		expectations: expectations.expectations,
		notes: [
			"recomputed offline from the recorded run directory",
			...(expectations.source ? [`expectations applied from ${expectations.source}`] : []),
		],
	});
	const outputFlag = request.flags.output;
	const written =
		typeof outputFlag === "string"
			? await writeReportToPath(path.resolve(request.cwd, outputFlag), evaluation.report, {
					protectedRoot: resolved,
				})
			: await writeDerivedReport(resolved, "compare", evaluation.report);
	if (request.json) {
		say.out(JSON.stringify(evaluation.report, null, 2));
	} else {
		summarise(evaluation.report, say);
		say.out(`derived ${written}`);
	}
	return evaluation.report.exitCode;
}

async function commandInspectAdapter(request: CommandRequest): Promise<number> {
	return commandInspect(request.options, {
		cwd: request.cwd,
		writers: request.writers,
		...(request.signal ? { signal: request.signal } : {}),
	});
}

/**
 * Translates a Commander usage failure into Runway's own error vocabulary.
 *
 * Commander decides *that* the invocation was wrong; this says which of Runway's
 * stable codes that corresponds to, so a machine-readable usage error is as
 * actionable as a runtime one. Its own message is kept verbatim: it names the
 * exact flag or argument.
 */
function usageErrorFor(cause: CommanderError): RunwayError {
	const code: RunwayError["code"] = (() => {
		switch (cause.code) {
			case "commander.unknownOption":
			case "commander.unknownCommand":
				return "config/unknown-flag";
			case "commander.missingArgument":
			case "commander.optionMissingArgument":
			case "commander.missingMandatoryOptionValue":
				return "config/missing-input";
			case "commander.conflictingOption":
				return "config/conflicting-inputs";
			default:
				return "config/invalid-option";
		}
	})();
	return new RunwayError(code, cause.message, {
		details: { commanderCode: cause.code },
		remedy: "Run `runway help <command>` for the accepted flags and arguments.",
	});
}

export type CliContext = {
	readonly cwd: string;
	readonly writers: CliWriters;
	readonly version?: string;
	/**
	 * Cancellation for long-running commands. The entry point owns the signal
	 * handlers; no command registers process listeners of its own.
	 */
	readonly signal?: AbortSignal;
};

/**
 * Parses `argv` (already stripped of `node` and the script path) and runs one
 * command.
 *
 * Returns 0 for success, 1 for test or runtime failure, and 2 for a usage error.
 * Help and `--version` are successful requests for data.
 */
export async function runCli(
	argv: readonly string[],
	context: CliContext
): Promise<number> {
	const result = { exitCode: EXIT_OK, json: false };
	// `--json` is a promise about stdout that has to hold even for a parse error,
	// so it is answered before parsing rather than read out of a parse that failed.
	// The answer comes from the same grammar, so an option's value that happens to
	// look like `--json` is not mistaken for the flag.
	const wantsJson = await jsonRequested(argv);
	// Commander's own output is buffered until the outcome is known: in JSON mode a
	// usage error is one JSON document on stdout with nothing on stderr, and help
	// text is only ever printed when help was what was asked for.
	const buffered: { readonly stream: "out" | "err"; readonly text: string }[] = [];
	const program = buildProgram({
		cwd: context.cwd,
		writers: context.writers,
		diagnostics: {
			out: (text) => buffered.push({ stream: "out", text }),
			err: (text) => buffered.push({ stream: "err", text }),
		},
		version: context.version ?? packageVersion(),
		result,
		handlers: {
			run: commandRun,
			list: commandList,
			preflight: commandPreflight,
			compare: commandCompare,
			inspect: commandInspectAdapter,
		},
		// Cancellation belongs to the process entry point and has to reach the
		// command that can act on it: without this, Ctrl-C printed a message and
		// the run carried on to completion.
		...(context.signal ? { signal: context.signal } : {}),
	});
	const flush = (): void => {
		for (const entry of buffered) {
			if (entry.stream === "out") context.writers.out(entry.text);
			else context.writers.err(entry.text);
		}
		buffered.length = 0;
	};

	try {
		await program.parseAsync([...argv], { from: "user" });
		flush();
		return result.exitCode;
	} catch (cause) {
		if (cause instanceof CommanderError) {
			// Help and version are requested data: they were asked for explicitly, so
			// they are printed exactly as Commander produced them.
			if (cause.exitCode === EXIT_OK) {
				flush();
				return EXIT_OK;
			}
			if (wantsJson) {
				// One document, on stdout, and a clean stderr. Commander's text — the
				// usage line and the help hint — is deliberately dropped: `--json`
				// asked for a machine-readable answer, not a machine-readable answer
				// plus a page of prose on another stream.
				buffered.length = 0;
				context.writers.out(
					`${JSON.stringify(
						{
							error: usageErrorFor(cause).toJSON(),
						},
						null,
						2
					)}\n`
				);
				return EXIT_USAGE;
			}
			flush();
			if (cause.code === "commander.unknownCommand") {
				context.writers.err(program.helpInformation());
			}
			return EXIT_USAGE;
		}
		const error = toRunwayError(cause);
		const usage =
			error.code.startsWith("config/") || error.code === "browser/selection-invalid";
		if (wantsJson || result.json) {
			buffered.length = 0;
			context.writers.out(`${JSON.stringify({ error: error.toJSON() }, null, 2)}\n`);
		} else {
			flush();
			context.writers.err(`${error.format()}\n`);
		}
		return usage ? EXIT_USAGE : EXIT_FAILURES;
	}
}
