import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli/main.ts";
import { option } from "../src/config/options.ts";
import { resolveRunConfiguration } from "../src/config/resolve.ts";
import { loadPlan, planHashFor } from "../src/core/plan.ts";
import { executeRun, prepareRun } from "../src/run.ts";
import { discoverNativeTests } from "../src/suites/native.ts";

const testkit = new URL("../src/testkit.ts", import.meta.url).href;
const declaration = (name) => `
import { nodeTest } from ${JSON.stringify(testkit)};
export default nodeTest({name: ${JSON.stringify(name)}, fn({assertEqual}) {
  assertEqual(6 * 7, 42);
}});
`;

async function workspace(t) {
	const parent = path.join(tmpdir(), "opencode");
	await mkdir(parent, { recursive: true });
	const root = await mkdtemp(path.join(parent, "runway-consumer-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "tests"));
	await mkdir(path.join(root, "assets"));
	await writeFile(path.join(root, "package.json"), '{"type":"module"}');
	for (const file of ["scramjet.js", "controller.api.js", "index.js"]) {
		// Node-only tests never load browser payloads, but resolution validates paths.
		await writeFile(path.join(root, "assets", file), "");
	}
	return root;
}

const assetFlags = ["--scramjet-dist", "assets", "--controller-dist", "assets", "--libcurl-dist", "assets"];
async function cli(root, args) {
	let stdout = "", stderr = "";
	const exit = await runCli(args, {
		cwd: root,
		version: "test",
		writers: { out: (text) => { stdout += text; }, err: (text) => { stderr += text; } },
	});
	return { exit, stdout, stderr };
}

function configuration(root) {
	const flag = (name, value) => option(value, "cli", name);
	return resolveRunConfiguration({
		testRoot: flag("--test-root", "tests"),
		lanes: flag("--lanes", ["scramjet"]),
		scramjetDist: flag("--scramjet-dist", "assets"),
		controllerDist: flag("--controller-dist", "assets"),
		libcurlDist: flag("--libcurl-dist", "assets"),
	}, { cwd: root });
}

test("consumer ESM/TS tests list, execute, and compare without their source", async (t) => {
	const root = await workspace(t);
	for (const [extension, name] of [["mjs", "consumer-esm"], ["js", "consumer-js"], ["ts", "consumer-ts"], ["mts", "consumer-mts"]]) {
		const source = declaration(name);
		await writeFile(path.join(root, "tests", `test.${extension}`),
			extension.endsWith("ts") ? `const typed: number = 42;\n${source}` : source);
	}
	await writeFile(path.join(root, "tests", "ignored.d.ts"), "this is not executable JavaScript");
	await mkdir(path.join(root, "tests", "node_modules"));
	await writeFile(path.join(root, "tests", "node_modules", "not-a-test.mjs"), 'throw new Error("must not load dependencies as tests")');
	const list = await cli(root, ["list", "--test-root", "tests", "--json", ...assetFlags]);
	assert.equal(list.exit, 0, list.stderr);
	const inventory = JSON.parse(list.stdout);
	assert.equal(inventory.tests.length, 4);
	assert(inventory.tests.every((entry) => entry.localName.startsWith("consumer-")));
	assert(inventory.tests.every((entry) => /^[a-f0-9]{64}$/.test(entry.configuration.moduleSha256)));

	const run = await cli(root, ["run", "--test-root", "tests", "--output-dir", "results", "--json", ...assetFlags]);
	// No browser is selected or launched for this Node-only run. The existing
	// runner policy records passes but deliberately withholds conformance credit.
	assert.equal(run.exit, 1, run.stderr + run.stdout);
	const report = JSON.parse(run.stdout);
	assert.equal(report.totals.byOutcome.pass, 4);
	assert.equal(report.totals.rawPassesMissingEvidence, 4);
	assert.equal(report.totals.unexpectedFailures, 4);
	assert.equal(report.completion.reason, "completed");
	const { readdir } = await import("node:fs/promises");
	const [runId] = await readdir(path.join(root, "results"));
	const directory = path.join(root, "results", runId);
	const plan = await loadPlan(path.join(directory, "plan.json"));
	assert.equal(plan.testRoot, path.join(root, "tests"));
	assert.notEqual(planHashFor({ ...plan, testRoot: path.join(root, "other") }, plan.inventory.digest), plan.planHash);
	await rm(path.join(root, "tests"), { recursive: true });
	const comparison = await cli(root, ["compare", directory, "--json"]);
	assert.equal(comparison.exit, run.exit, comparison.stderr + comparison.stdout);
	assert.deepEqual(JSON.parse(comparison.stdout).totals, report.totals);

	const raw = JSON.parse(await readFile(path.join(directory, "plan.json"), "utf8"));
	raw.testRoot = path.join(root, "other");
	await writeFile(path.join(root, "tampered.json"), JSON.stringify(raw));
	await assert.rejects(loadPlan(path.join(root, "tampered.json")), { code: "plan/hash-mismatch" });
});

test("bad consumer roots fail rather than select builtin tests", async (t) => {
	const root = await workspace(t);
	const missing = await cli(root, ["list", "--test-root", "missing", "--json", ...assetFlags]);
	assert.notEqual(missing.exit, 0);
	assert.match(missing.stdout + missing.stderr, /test directory does not exist/);
	await assert.rejects(prepareRun(configuration(root)), /contains no tests/);
	const conflict = await cli(root, ["list", "--suite", "wpt", "--test-root", "tests", "--json", ...assetFlags]);
	assert.notEqual(conflict.exit, 0);
	assert.match(conflict.stdout + conflict.stderr, /requires --suite native/);
});

test("duplicate names, broken modules and out-of-root links are refused", async (t) => {
	const root = await workspace(t);
	const tests = path.join(root, "tests");
	await writeFile(path.join(tests, "first.mjs"), declaration("duplicate"));
	await writeFile(path.join(tests, "second.mjs"), declaration("duplicate"));
	await assert.rejects(discoverNativeTests({ root: tests }), { code: "suite/duplicate-test-id" });
	await rm(path.join(tests, "second.mjs"));
	await writeFile(path.join(tests, "broken.mjs"), 'throw new Error("consumer import failed")');
	await assert.rejects(discoverNativeTests({ root: tests }), /consumer import failed/);
	await rm(path.join(tests, "broken.mjs"));
	await writeFile(path.join(root, "outside.mjs"), 'throw new Error("must not execute")');
	await symlink(path.join(root, "outside.mjs"), path.join(tests, "escape.mjs"));
	await assert.rejects(discoverNativeTests({ root: tests }), /link out of the suite root/);
});

test("consumer runtime profiles coexist with independently defined tests", async (t) => {
	const root = await workspace(t);
	await writeFile(path.join(root, "tests", "test.mjs"), declaration("consumer-profile"));
	await writeFile(path.join(root, "plugin.mjs"), "export default () => ({ plugins: [] });");
	await writeFile(path.join(root, "plugin.json"), JSON.stringify({ name: "consumer", plugins: [{ entry: "./plugin.mjs" }] }));
	const result = await cli(root, ["list", "--test-root", "tests", "--plugin-manifest", "plugin.json", "--json", ...assetFlags]);
	assert.equal(result.exit, 0, result.stderr);
	assert.equal(JSON.parse(result.stdout).tests[0].localName, "consumer-profile");
});

test("saved consumer plans refuse changed entry modules", async (t) => {
	const root = await workspace(t);
	const file = path.join(root, "tests", "test.mjs");
	await writeFile(file, declaration("before-edit"));
	const prepared = await prepareRun(configuration(root));
	await writeFile(file, declaration("after-edit"));
	const changed = await discoverNativeTests({ root: path.join(root, "tests") });
	assert.equal(changed.entries[0].localName, "after-edit");
	await assert.rejects(executeRun({ plan: prepared.plan }), /consumer test source changed after planning/);
	const events = await readFile(path.join(prepared.plan.output.runDirectory, "events.jsonl"), "utf8");
	assert.match(events, /setupError|infrastructureError/);
});
