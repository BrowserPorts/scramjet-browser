/**
 * Command-line surface, built with Commander.
 *
 * Commander owns parsing, validation, help and usage errors. Runway does not
 * pre-scan `process.argv`, does not re-implement flag matching, and reads no
 * environment variable as configuration: a command is described entirely by its
 * own flags, and unknown flags, unknown commands, missing arguments, excess
 * arguments and out-of-range values are all Commander errors.
 *
 * This module builds the program and translates parsed flags into
 * {@link RunwayOptions}. It performs no I/O of its own beyond the injected
 * writers, holds no process state, and never calls `process.exit`: exits belong to
 * `cli/bin.ts`.
 */
import { InvalidArgumentError, Option, Command } from "commander";
import { option, type RunwayOptions } from "../config/options.ts";
import { KNOWN_LANES, KNOWN_SUITES } from "../config/resolve.ts";

export const EXIT_OK = 0;
export const EXIT_FAILURES = 1;
export const EXIT_USAGE = 2;

/** Where the CLI writes. Injected, so the surface is testable in-process. */
export type CliWriters = {
	readonly out: (text: string) => void;
	readonly err: (text: string) => void;
};

/** One command's request, after Commander has validated it. */
export type CommandRequest = {
	readonly cwd: string;
	readonly writers: CliWriters;
	readonly options: RunwayOptions;
	readonly positionals: readonly string[];
	/** Machine-readable output was requested: stdout carries JSON and nothing else. */
	readonly json: boolean;
	/** Command-specific flags that are not run inputs. */
	readonly flags: Readonly<Record<string, unknown>>;
	/** Cancellation owned by the process entry point, not by a command. */
	readonly signal?: AbortSignal;
};

export type CommandHandler = (request: CommandRequest) => Promise<number>;

export type CliHandlers = {
	readonly run: CommandHandler;
	readonly list: CommandHandler;
	readonly preflight: CommandHandler;
	readonly compare: CommandHandler;
	readonly inspect: CommandHandler;
};

export type ProgramContext = {
	readonly cwd: string;
	readonly writers: CliWriters;
	/**
	 * Where Commander's own output goes: help, usage errors, version.
	 *
	 * Separate from the command writers on purpose. The caller buffers these so it
	 * can decide, after parsing has failed, whether the failure should be rendered
	 * as text or as the single JSON document `--json` promises — and so a usage
	 * error never interleaves with a command's output.
	 */
	readonly diagnostics?: CliWriters;
	/** Version reported by `--version`. Read from the installed package manifest. */
	readonly version: string;
	readonly handlers: CliHandlers;
	/** Cancellation installed by the entry point before parsing. */
	readonly signal?: AbortSignal;
	/**
	 * Records the exit code an action produced, and whether it ran in JSON mode.
	 * Commander action handlers cannot return a value to the caller, so the
	 * outcome is collected here instead of exiting from inside a command.
	 */
	readonly result: { exitCode: number; json: boolean };
};

function parseInteger(name: string, value: string, min: number, max: number): number {
	if (!/^\d+$/.test(value)) {
		throw new InvalidArgumentError(`${name} must be a whole number.`);
	}
	const parsed = Number(value);
	if (parsed < min || parsed > max) {
		throw new InvalidArgumentError(`${name} must be between ${min} and ${max}.`);
	}
	return parsed;
}

function parseChoiceList(
	value: string,
	allowed: readonly string[],
	label: string
): readonly string[] {
	const items = value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	if (items.length === 0) {
		throw new InvalidArgumentError(`name at least one ${label}.`);
	}
	for (const item of items) {
		if (!allowed.includes(item)) {
			throw new InvalidArgumentError(
				`${JSON.stringify(item)} is not a known ${label}. Allowed: ${allowed.join(", ")}.`
			);
		}
	}
	return Object.freeze([...new Set(items)]);
}

const LANE_NAMES = Object.keys(KNOWN_LANES);

/** Flags that select the browser. Exactly one may be given; the plan enforces that. */
function addBrowserOptions(command: Command): Command {
	return command
		.option(
			"--browser-executable <path>",
			"browser binary used by every lane"
		)
		.option("--browser-channel <name>", "installed browser channel used by every lane")
		.option(
			"--browser-bundled",
			"use Playwright's bundled Chromium; recorded as not selection proof"
		)
		.option("--headed", "run with a visible window");
}

/** Flags that locate the browser assets Runway serves. */
function addAssetOptions(command: Command): Command {
	return command
		.option("--scramjet-dist <dir>", "scramjet asset directory")
		.option("--controller-dist <dir>", "scramjet-controller asset directory")
		.option("--libcurl-dist <dir>", "libcurl asset directory")
		.option("--plugin-manifest <file>", "external plugin profile JSON")
		.option(
			"--wpt-manifest <file>",
			"WPT inventory manifest (required with --suites wpt); the denominator, never inferred"
		)
		.option(
			"--wpt-root <dir>",
			"upstream WPT checkout to serve cases from (with --wpt-server-config)"
		)
		.option("--wpt-server-config <file>", "wptserve config to start the official server with")
		.option(
			"--wpt-allow-incomplete",
			"read a WPT manifest that does not cover its whole selection (diagnosis only; " +
				"such cases are still refused execution)"
		);
}

function addLaneOptions(command: Command): Command {
	return command
		.addOption(
			new Option("--lanes <lanes>", `comma separated lanes (${LANE_NAMES.join(", ")})`).argParser(
				(value) => parseChoiceList(value, LANE_NAMES, "lane")
			)
		)
		.addOption(
			new Option("--suite <suites>", `comma separated suites (${KNOWN_SUITES.join(", ")})`).argParser(
				(value) => parseChoiceList(value, [...KNOWN_SUITES], "suite")
			)
		);
}

function addPortOptions(command: Command): Command {
	return command
		.addOption(
			new Option("--harness-port <port>", "harness port; 0 allocates").argParser((value) =>
				parseInteger("--harness-port", value, 0, 65535)
			)
		)
		.addOption(
			new Option("--wisp-port <port>", "wisp port; 0 allocates").argParser((value) =>
				parseInteger("--wisp-port", value, 0, 65535)
			)
		)
		.addOption(
			new Option("--bare-port <port>", "bare harness port; 0 allocates").argParser((value) =>
				parseInteger("--bare-port", value, 0, 65535)
			)
		);
}

function addJsonOption(command: Command): Command {
	return command.option("--json", "write machine-readable JSON on stdout and nothing else");
}

/**
 * Translates validated Commander values into run inputs.
 *
 * Each option records the flag it came from, so a later error can name the exact
 * argument that caused it. Paths stay as the consumer typed them; they are
 * resolved against the captured working directory during plan resolution.
 */
export function toRunwayOptions(
	flags: Readonly<Record<string, unknown>>,
	filters: readonly string[],
	includeComparisonFlags = true
): RunwayOptions {
	const options: Record<string, unknown> = {};
	const put = (key: string, flag: string, value: unknown, comparison = false): void => {
		if (value === undefined) return;
		if (comparison && !includeComparisonFlags) return;
		options[key] = option(value, "cli", flag);
	};
	put("lanes", "--lanes", flags.lanes);
	put("suites", "--suite", flags.suite);
	put("browserExecutable", "--browser-executable", flags.browserExecutable);
	put("browserChannel", "--browser-channel", flags.browserChannel);
	put("browserBundled", "--browser-bundled", flags.browserBundled);
	put("headed", "--headed", flags.headed);
	put("harnessPort", "--harness-port", flags.harnessPort);
	put("wispPort", "--wisp-port", flags.wispPort);
	put("barePort", "--bare-port", flags.barePort);
	put("scramjetDist", "--scramjet-dist", flags.scramjetDist);
	put("controllerDist", "--controller-dist", flags.controllerDist);
	put("libcurlDist", "--libcurl-dist", flags.libcurlDist);
	put("pluginManifest", "--plugin-manifest", flags.pluginManifest);
	put("wptManifest", "--wpt-manifest", flags.wptManifest);
	put("wptRoot", "--wpt-root", flags.wptRoot);
	put("wptServerConfig", "--wpt-server-config", flags.wptServerConfig);
	put("wptAllowIncomplete", "--wpt-allow-incomplete", flags.wptAllowIncomplete);
	// Compare accepts `--expectations` with different semantics (an override,
	// not a plan input), so it stays a command flag there and is not a run input.
	put("expectations", "--expectations", flags.expectations, true);
	put("outputDir", "--output-dir", flags.outputDir);
	put("concurrency", "--concurrency", flags.concurrency);
	put("deadlineMs", "--deadline-ms", flags.deadlineMs);
	put("insecureDiagnostics", "--insecure-diagnostics", flags.insecureDiagnostics);
	put("coverage", "--coverage", flags.coverage);
	put("traceConsole", "--trace-console", flags.traceConsole);
	if (filters.length > 0) {
		options.filters = option([...filters], "cli", "<filter>");
	}
	return options as RunwayOptions;
}

/**
 * Neutralizes a probe command tree's validation, in place, without touching its
 * grammar.
 *
 * Only the things that *reject* an invocation are removed — value parsers, required
 * arguments, mandatory options, the excess-argument check. Every option keeps its
 * own flags string, so it keeps its arity: an option that takes a value still
 * consumes the next token, and one that does not still does not. That is the whole
 * property being preserved, and it is preserved by not touching it.
 *
 * Unknown options become ordinary operands rather than errors, which is the one
 * deliberate divergence: it lets the probe keep reading the rest of the line after
 * the token the real parse will reject.
 */
function relaxForProbe(command: Command): Command {
	command.allowUnknownOption(true).allowExcessArguments(true);
	for (const argument of command.registeredArguments) {
		// So a missing operand does not end the parse before the flags are read:
		// `runway compare --json` has to be answerable as a JSON usage error.
		argument.argOptional();
	}
	for (const option of command.options) {
		// Identity in place of the real parser: `--concurrency bogus` must not abort
		// the probe, but `--concurrency` must still swallow the token after it.
		option.argParser((value: string) => value);
		option.makeOptionMandatory(false);
	}
	for (const child of command.commands) relaxForProbe(child);
	return command;
}

/**
 * Answers whether this invocation asked for machine-readable output.
 *
 * `--json` is a promise about stdout that has to hold even when the invocation is
 * wrong: `runway compare --nope --json` must fail as one JSON document, and the
 * real parse abandons the line at `--nope` before it ever sees `--json`. So the
 * question is answered by a *second parse of the same grammar*.
 *
 * The grammar comes from {@link buildProgram} itself — the same commands, the same
 * options, the same flags strings — built with inert handlers and its validation
 * relaxed. Nothing here re-implements flag matching, so there is no second parser
 * to keep in sync, and every property of the real parse that decides *whether a
 * token is a flag at all* is inherited rather than reproduced:
 *
 *   * Arity. `--concurrency --json` consumes `--json` as the value of
 *     `--concurrency`; it is not a request for JSON, and it is reported as a plain
 *     text usage error. An independent `--json` elsewhere on the same line still is
 *     one.
 *   * Values that merely look like flags. `runway compare <dir> --output --json`
 *     names an output file called `--json`. That is a valid invocation, not an
 *     error, and not a request for JSON output.
 *   * `--`. Everything after it is an operand, so `runway run -- --json` filters on
 *     the string `--json` and prints text.
 *   * `=`-joined values, negations, short flags, and which options exist on which
 *     subcommand — including that `inspect` has no `--json` at all, so asking for
 *     it there is the unknown-option error it really is.
 *
 * Handlers are inert copies, so nothing is executed; the answer is read from the
 * probe's own `result`, which `dispatch` fills in from `command.opts()` exactly as
 * the real dispatch does.
 *
 * Some invocations never reach an action even with validation relaxed — an option
 * whose value is missing (`runway run --json --concurrency`) is a parse error, not
 * a validation one, and relaxing the value parser cannot make a token appear. The
 * flags Commander had already accepted are not lost, though: they are on the command
 * it had already selected. So the probe remembers that command as it descends, via
 * Commander's own `preSubcommand` hook, and reads `--json` off *that* command when
 * the parse throws. The reference matters — reading the root program instead would
 * answer for a `--json` the root does not even declare.
 *
 * Help and version requests throw before any action runs and are reported as text
 * regardless, because they are requested data with exit code 0.
 */
export async function jsonRequested(argv: readonly string[]): Promise<boolean> {
	const result = { exitCode: EXIT_OK, json: false };
	const inert: CommandHandler = async () => EXIT_OK;
	const silent: CliWriters = { out: () => undefined, err: () => undefined };
	const probe = relaxForProbe(
		buildProgram({
			cwd: ".",
			writers: silent,
			diagnostics: silent,
			version: "0.0.0-probe",
			result,
			handlers: { run: inert, list: inert, preflight: inert, compare: inert, inspect: inert },
		})
	);
	/** The deepest command Commander had selected before it stopped. */
	const state: { selected: Command | null } = { selected: null };
	const watch = (command: Command): void => {
		command.hook("preSubcommand", (_parent, subcommand) => {
			state.selected = subcommand;
		});
		for (const child of command.commands) watch(child);
	};
	watch(probe);
	try {
		await probe.parseAsync([...argv], { from: "user" });
	} catch {
		// Deliberately not fatal. An unparseable line still has an answer, and the
		// answer is whatever the selected command had already accepted.
	}
	if (result.json) return true;
	// Only reached when no action ran. Same source as `dispatch` uses — the
	// command's own parsed values — so there is no second reading of the grammar.
	const command = state.selected;
	if (!command) return false;
	try {
		return (command.opts() as { json?: unknown }).json === true;
	} catch {
		// A command that cannot report its own options answers no request.
		return false;
	}
}

/** Builds the program. Nothing is parsed and nothing is executed here. */
export function buildProgram(context: ProgramContext): Command {
	const program = new Command();
	const diagnostics = context.diagnostics ?? context.writers;

	program
		.name("runway")
		.description("Scramjet conformance runner: plan, execute, and compare recorded runs")
		.version(context.version, "-V, --version", "print the installed Runway version")
		.helpOption("-h, --help", "print help for a command")
		.showHelpAfterError("(run `runway help <command>` for the full usage)")
		.configureOutput({
			writeOut: (text) => diagnostics.out(text),
			writeErr: (text) => diagnostics.err(text),
			// No colour is added anywhere, so piped and NO_COLOR output are identical.
			outputError: (text, write) => write(text),
		})
		.exitOverride();

	const dispatch = (handler: CommandHandler, includeComparisonFlags = true) => {
		return async (...args: unknown[]): Promise<void> => {
			const command = args[args.length - 1] as Command;
			const positionals = args.slice(0, -2).flatMap((value) => {
				if (Array.isArray(value)) return value.map(String);
				return value === undefined ? [] : [String(value)];
			});
			const flags = command.opts();
			const json = flags.json === true;
			context.result.json = json;
			context.result.exitCode = await handler({
				cwd: context.cwd,
				writers: context.writers,
				options: toRunwayOptions(flags, positionals, includeComparisonFlags),
				positionals: Object.freeze(positionals),
				json,
				flags,
				...(context.signal ? { signal: context.signal } : {}),
			});
		};
	};

	const run = program
		.command("run")
		.description("execute the planned tests and compare the recorded result")
		.argument("[filters...]", "substring filters on test id, name or title");
	addLaneOptions(run);
	addBrowserOptions(run);
	addAssetOptions(run);
	addPortOptions(run);
	run
		.addOption(
			new Option("--concurrency <count>", "tests in flight at once").argParser((value) =>
				parseInteger("--concurrency", value, 1, 1024)
			)
		)
		.addOption(
			new Option("--deadline-ms <ms>", "per-test deadline").argParser((value) =>
				parseInteger("--deadline-ms", value, 1, 86_400_000)
			)
		)
		.option("--expectations <file>", "expectations file applied at comparison time")
		.option("--output-dir <dir>", "run output root")
		.option(
			"--insecure-diagnostics",
			"disable certificate verification; results are never counted as verified"
		)
		.option("--coverage", "record raw V8 JS coverage per attempt as an artifact")
		.option("--trace-console", "record page console output as an artifact");
	addJsonOption(run).action(dispatch(context.handlers.run));

	const list = program
		.command("list")
		.description("print the inventory without executing anything")
		.argument("[filters...]", "substring filters on test id, name or title");
	addLaneOptions(list);
	addAssetOptions(list);
	addJsonOption(list).action(dispatch(context.handlers.list));

	const preflight = program
		.command("preflight")
		.description("verify assets, browser and harnesses without running tests")
		.allowExcessArguments(false);
	addLaneOptions(preflight);
	addBrowserOptions(preflight);
	addAssetOptions(preflight);
	addPortOptions(preflight);
	addJsonOption(preflight).action(dispatch(context.handlers.preflight));

	const compare = program
		.command("compare")
		.description("recompute a verdict from a recorded run directory, offline")
		.argument("<run-directory>", "directory holding plan.json and events.jsonl")
		.allowExcessArguments(false)
		.option("--expectations <file>", "expectations file applied instead of the plan's")
		.option("--output <file>", "write the derived report to this path instead of the run directory");
	addJsonOption(compare).action(dispatch(context.handlers.compare, false));

	const inspect = program
		.command("inspect")
		.description("open one test on one lane and keep the browser open")
		.argument("<filter>", "filter matching exactly one test")
		.allowExcessArguments(false);
	addLaneOptions(inspect);
	addBrowserOptions(inspect);
	addAssetOptions(inspect);
	addPortOptions(inspect);
	inspect.action(dispatch(context.handlers.inspect));

	return program;
}
