/**
 * Native regression suite: inventory.
 *
 * Discovery imports the suite's test modules and turns each declaration into an
 * inventory entry before anything launches, so the denominator exists independently
 * of execution. A module that fails to import is an error: silently shrinking the
 * inventory is the accounting bug the inventory exists to prevent.
 */
import { glob, realpath, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RunwayError } from "../core/errors.ts";
import { composeTestId, laneId, suiteId, type LaneId, type SuiteId, type TestId } from "../core/ids.ts";
import { CAPABILITIES, type CapabilityId, type InventoryEntry } from "../core/inventory.ts";
import type { NativeTest } from "../testkit.ts";

export const NATIVE_SUITE: SuiteId = suiteId("native");

const BARE_LANE: LaneId = laneId("bare");
const SCRAMJET_LANE: LaneId = laneId("scramjet");

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/** `.ts` in a checkout, `.js` in the compiled package. */
const MODULE_EXTENSION = import.meta.url.endsWith(".ts") ? ".ts" : ".js";

/** Root of the test modules: `src/tests` in a checkout, `dist/tests` installed. */
export const NATIVE_TESTS_ROOT = path.join(moduleDirectory, "..", "tests");

/**
 * Upstream fixture payloads are served to the browser verbatim and sit beside the
 * test modules in the compiled package. Importing one would evaluate browser code
 * in the runner, so any `vendored` path segment is excluded from discovery.
 *
 * Discovery applies this to two paths per candidate: the name glob yielded, and
 * the canonical path that name resolves to. The exclusion is a property of the
 * file, not of the spelling used to reach it, so a link whose name looks clean
 * cannot smuggle a payload past it.
 */
export function isVendoredFixture(relativePath: string): boolean {
	return relativePath.split("/").includes("vendored");
}

export type SkippedModule = {
	readonly module: string;
	readonly reason: string;
};

export type NativeDiscovery = {
	readonly entries: readonly InventoryEntry[];
	readonly tests: ReadonlyMap<TestId, NativeTest>;
	readonly skippedModules: readonly SkippedModule[];
};

function capabilitiesFor(test: NativeTest): readonly CapabilityId[] {
	const extras: CapabilityId[] = [];
	if (test.requireOwner) extras.push(CAPABILITIES.ownerSignal);
	if (test.remoteNetwork) extras.push(CAPABILITIES.remoteNetwork);
	switch (test.execution.kind) {
		case "node":
			return [CAPABILITIES.inProcess, ...extras];
		case "page-control":
			return [
				CAPABILITIES.browser,
				CAPABILITIES.localFixtures,
				CAPABILITIES.playwrightControl,
				CAPABILITIES.proxyRoute,
				...extras,
			];
		default:
			return [CAPABILITIES.browser, CAPABILITIES.localFixtures, CAPABILITIES.proxyRoute, ...extras];
	}
}

function lanesFor(test: NativeTest): readonly LaneId[] {
	// In-process tests exercise the candidate's Node-side code and have no browser
	// lane of their own; they are attributed to the candidate.
	if (test.execution.kind === "node") return [SCRAMJET_LANE];
	return test.laneScope === "both" ? [BARE_LANE, SCRAMJET_LANE] : [SCRAMJET_LANE];
}

const EXECUTION_KINDS = ["in-page", "page-control", "node"] as const;
const LANE_SCOPES = ["both", "candidate"] as const;

/** Longest deadline a declaration may ask for: one hour, in whole milliseconds. */
const MAX_DEADLINE_MS = 3_600_000;
/** Beyond this an `ok()` budget is a typo, not an expectation. */
const MAX_EXPECTED_OK_CALLS = 100_000;

function declarationFailure(
	message: string,
	details: Readonly<Record<string, unknown>>,
	remedy = "Build tests with the factories exported from runway/testkit."
): RunwayError {
	return new RunwayError("suite/discovery-failed", message, { details, remedy });
}

function requireCallback(
	value: unknown,
	what: string,
	details: Readonly<Record<string, unknown>>
): void {
	if (typeof value !== "function") {
		throw declarationFailure(`${what} must be a function`, { ...details, received: typeof value });
	}
}

function requireBoundedInteger(
	value: unknown,
	what: string,
	bounds: { readonly min: number; readonly max: number },
	details: Readonly<Record<string, unknown>>
): void {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < bounds.min ||
		value > bounds.max
	) {
		throw declarationFailure(
			`${what} must be a whole number between ${bounds.min} and ${bounds.max}`,
			{ ...details, received: value },
			"Declare a concrete numeric budget; the inventory records it verbatim."
		);
	}
}

function requireBoolean(
	value: unknown,
	what: string,
	details: Readonly<Record<string, unknown>>
): void {
	if (typeof value !== "boolean") {
		throw declarationFailure(`${what} must be true or false`, {
			...details,
			received: typeof value,
		});
	}
}

/**
 * Checks a declaration before it becomes an inventory entry.
 *
 * The entry builder normalizes: a `deadlineMs` of `0` or `NaN` is simply dropped,
 * a non-numeric `expectedOkCalls` becomes meta the executor ignores, and an
 * unknown execution kind falls into the in-page branch. Each of those turns an
 * authoring mistake into a test that runs as something other than what it says,
 * so the shape is checked here — the declaration is data, and it is validated as
 * data rather than by reading the test's source text.
 */
export function validateDeclaration(test: NativeTest, module: string): void {
	const details = { module, name: test.name };
	const execution: NativeTest["execution"] | undefined = test.execution;
	if (!execution || typeof execution !== "object" || typeof execution.kind !== "string") {
		throw declarationFailure(`the test ${test.name} in ${module} declares no execution kind`, details);
	}
	if (!(EXECUTION_KINDS as readonly string[]).includes(execution.kind)) {
		throw declarationFailure(
			`the test ${test.name} in ${module} declares the unknown execution kind ${JSON.stringify(execution.kind)}`,
			{ ...details, kind: execution.kind, supported: EXECUTION_KINDS },
			`Supported kinds are ${EXECUTION_KINDS.join(", ")}; use a runway/testkit factory.`
		);
	}
	switch (execution.kind) {
		case "in-page":
			requireCallback(execution.createFixture, `${test.name}: an in-page test's createFixture`, details);
			break;
		case "page-control":
			requireCallback(execution.fn, `${test.name}: a page-control test's fn`, details);
			if (execution.createFixture !== undefined) {
				requireCallback(
					execution.createFixture,
					`${test.name}: a page-control test's createFixture`,
					details
				);
			}
			break;
		default:
			requireCallback(execution.fn, `${test.name}: a node test's fn`, details);
			break;
	}
	if (!(LANE_SCOPES as readonly string[]).includes(test.laneScope)) {
		throw declarationFailure(
			`the test ${test.name} in ${module} declares the unknown lane scope ${JSON.stringify(test.laneScope)}`,
			{ ...details, laneScope: test.laneScope, supported: LANE_SCOPES },
			`A lane scope is ${LANE_SCOPES.join(" or ")}.`
		);
	}
	if (test.deadlineMs !== undefined) {
		requireBoundedInteger(test.deadlineMs, `${test.name}: deadlineMs`, { min: 1, max: MAX_DEADLINE_MS }, details);
	}
	if (test.expectedOkCalls !== undefined) {
		requireBoundedInteger(
			test.expectedOkCalls,
			`${test.name}: expectedOkCalls`,
			{ min: 0, max: MAX_EXPECTED_OK_CALLS },
			details
		);
	}
	for (const flag of ["serialLanes", "warmProxiedRoute", "requireOwner", "remoteNetwork"] as const) {
		if (test[flag] !== undefined) requireBoolean(test[flag], `${test.name}: ${flag}`, details);
	}
	if (test.verdict !== undefined && test.verdict !== "page" && test.verdict !== "host") {
		throw declarationFailure(
			`the test ${test.name} in ${module} declares the unknown verdict ${JSON.stringify(test.verdict)}`,
			{ ...details, verdict: test.verdict },
			"A verdict is page or host."
		);
	}
	// A host verdict is settled by the fixture in Node; the other kinds have no
	// fixture to settle it, so the declaration would never be satisfiable.
	if (test.verdict === "host" && execution.kind !== "in-page") {
		throw declarationFailure(
			`the test ${test.name} in ${module} declares a host verdict, which only an in-page fixture can settle`,
			{ ...details, kind: execution.kind },
			"Use an originTest/fixtureTest declaration for a host verdict."
		);
	}
}

export function inventoryEntryFor(test: NativeTest, module: string): InventoryEntry {
	return {
		testId: composeTestId(NATIVE_SUITE, test.name),
		suite: NATIVE_SUITE,
		localName: test.name,
		title: test.name,
		lanes: lanesFor(test),
		requiredCapabilities: capabilitiesFor(test),
		executable: true,
		...(test.deadlineMs ? { deadlineMs: test.deadlineMs } : {}),
		meta: {
			module,
			executionMode: test.execution.kind,
			verdict:
				test.verdict ??
				(test.execution.kind === "page-control"
					? "playwright"
					: test.execution.kind === "node"
						? "node"
						: "page"),
			serialLanes: test.serialLanes === true,
			warmProxiedRoute: test.warmProxiedRoute === true,
			...(test.expectedOkCalls === undefined
				? {}
				: { expectedOkCalls: test.expectedOkCalls }),
		},
	};
}

export async function discoverNativeTests(
	options: {
		readonly root?: string;
		/** Extension of the compiled or checked-out modules; defaults to this build's. */
		readonly moduleExtension?: string;
	} = {}
): Promise<NativeDiscovery> {
	// An absolute root keeps discovery independent of the working directory, and
	// it is what makes the file URL below unambiguous. It is resolved through
	// the filesystem so symlink comparisons below are against the real directory,
	// not the spelling the caller used.
	const root = path.resolve(options.root ?? NATIVE_TESTS_ROOT);
	let rootReal: string;
	try {
		rootReal = await realpath(root);
	} catch (cause) {
		throw new RunwayError(
			"suite/discovery-failed",
			`the suite root ${root} could not be resolved`,
			{ details: { root }, cause }
		);
	}
	// External suites may contain compiled ESM or directly runnable TypeScript.
	// Builtin discovery still selects only this build's own extension.
	const extensions = options.moduleExtension
		? [options.moduleExtension]
		: options.root ? [".js", ".mjs", ".ts", ".mts"] : [MODULE_EXTENSION];
	const entries: InventoryEntry[] = [];
	const tests = new Map<TestId, NativeTest>();
	const skipped: SkippedModule[] = [];
	const seenNames = new Map<string, string>();
	// Canonical paths already inventoried, by import target. Discovery executes
	// whatever it imports, so two names for one file import once: the test names
	// are the suite's primary key and an alias must not mint a second identity.
	const seenTargets = new Map<string, string>();

	const files: string[] = [];
	for (const extension of extensions) {
		for await (const file of glob(`**/*${extension}`, { cwd: root, exclude: ["**/node_modules/**", "**/.git/**"] })) {
			if (/\.d\.(?:ts|mts)$/.test(file)) continue;
			files.push(file.split(path.sep).join("/"));
		}
	}
	files.sort();

	for (const relative of files) {
		if (isVendoredFixture(relative)) {
			skipped.push({
				module: relative,
				reason: "vendored upstream fixture: served to the browser, never imported",
			});
			continue;
		}
		const full = path.resolve(root, relative);
		// The suite is the caller's own checkout, not a sandbox: discovery
		// intentionally executes every module it keeps. The boundary is which files
		// that execution can reach. A lexical check is not enough, because glob
		// yields symlink names without resolving them: a `root/escape.ts` pointing
		// outside the root is lexically inside and would import the outside file.
		// So the import target is canonicalized first, and what is outside,
		// dangling, or otherwise unresolvable is refused before it is evaluated.
		let target: string;
		try {
			target = await realpath(full);
		} catch (cause) {
			throw new RunwayError(
				"suite/discovery-failed",
				`the test module ${relative} could not be resolved: ${cause instanceof Error ? cause.message : String(cause)}`,
				{
					details: { module: relative, root },
					remedy: "A suite module must exist, and a symlink in the suite must have a target.",
					cause,
				}
			);
		}
		if (target !== rootReal && !target.startsWith(`${rootReal}${path.sep}`)) {
			throw new RunwayError(
				"suite/discovery-failed",
				`the test module ${relative} is a link out of the suite root and was not imported`,
				{
					details: { module: relative, root: rootReal, resolved: target },
					remedy: "Keep test modules inside the suite root; discovery never imports outside it.",
				}
			);
		}
		// The vendored exclusion above only saw the name glob yielded. That name is
		// not the file: `root/alias.ts -> root/vendored/payload.ts` has no vendored
		// segment, resolves inside the canonical root, and would evaluate a browser
		// payload in the runner. So the canonical path is checked too, before the
		// import, and the skip is recorded under the name that reached it.
		const canonicalRelative = path.relative(rootReal, target).split(path.sep).join("/");
		if (isVendoredFixture(canonicalRelative)) {
			skipped.push({
				module: relative,
				reason: `vendored upstream fixture (resolves to ${canonicalRelative}): served to the browser, never imported`,
			});
			continue;
		}
		// An internal alias is a second name for a module already inventoried: it is
		// evaluated once, under its first name. Its declarations were already
		// validated then; without dedup the same module would be imported twice and
		// its tests rejected as duplicates of themselves, which misreports an
		// alias as two authors claiming one name.
		const firstName = seenTargets.get(target);
		if (firstName !== undefined) {
			skipped.push({
				module: relative,
				reason: `alias of the already imported module ${firstName}: evaluated once`,
			});
			continue;
		}
		seenTargets.set(target, relative);
		const moduleSha256 = options.root
			? createHash("sha256").update(await readFile(target)).digest("hex")
			: undefined;
		let loaded: { default?: unknown };
		try {
			// A file URL, not a path: `#`, `?`, `%` and spaces are legal in directory
			// names, and a bare path passed to import() would parse them as URL
			// syntax (or as a bare specifier on a relative path).
			const moduleURL = pathToFileURL(target);
			// A second in-process discovery after an edit must not hash new bytes
			// while executing Node's cached copy of the old entry module.
			if (moduleSha256) moduleURL.searchParams.set("runwaySource", moduleSha256);
			loaded = (await import(moduleURL.href)) as { default?: unknown };
		} catch (cause) {
			throw new RunwayError(
				"suite/discovery-failed",
				`the test module ${relative} could not be imported: ${cause instanceof Error ? cause.message : String(cause)}`,
				{
					details: { module: relative }, cause,
					remedy: /\.(?:ts|mts)$/.test(relative)
						? "Use Node >=22.18 with type stripping enabled, set NODE_OPTIONS=--experimental-strip-types on older supported Node 22 versions, or compile tests to ESM JavaScript."
						: "Check this module and its dependencies in the consumer project.",
				}
			);
		}
		const exported = loaded.default;
		if (!exported) {
			skipped.push({ module: relative, reason: "no default export" });
			continue;
		}
		const list: NativeTest[] = Array.isArray(exported)
			? (exported as NativeTest[])
			: [exported as NativeTest];
		for (const test of list) {
			if (!test || typeof test !== "object" || typeof test.name !== "string" || test.name.trim() === "") {
				throw new RunwayError(
					"suite/discovery-failed",
					`the test module ${relative} exported a test without a name`,
					{ details: { module: relative } }
				);
			}
			validateDeclaration(test, relative);
			const previous = seenNames.get(test.name);
			if (previous !== undefined) {
				throw new RunwayError(
					"suite/duplicate-test-id",
					`the test name ${JSON.stringify(test.name)} is declared by both ${previous} and ${relative}`,
					{
						details: { name: test.name, modules: [previous, relative] },
						remedy: "Test names are the suite's primary key; rename one of them.",
					}
				);
			}
			seenNames.set(test.name, relative);
			const base = inventoryEntryFor(test, relative);
			const entry = moduleSha256 === undefined ? base : {
				...base,
				meta: { ...base.meta, moduleSha256 },
			};
			entries.push(entry);
			tests.set(entry.testId, test);
		}
	}

	return Object.freeze({
		entries: Object.freeze(entries),
		tests,
		skippedModules: Object.freeze(skipped),
	});
}
