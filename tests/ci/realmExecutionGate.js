/**
 * @fileoverview
 * Contract tests for the `realmExecution` flag.
 *
 * With the flag on, page script text goes to the `realmScript` provider instead
 * of the wasm rewriter, and none of the page-facing `$scramjet*` helpers are
 * installed. These tests cover the pure gate logic by loading
 * `shared/rewriters/realm.ts` on its own (it holds only type imports), and they
 * guard the helper side with a source scan: any client module that defines a
 * `config.globals.*` property must mention `realmExecution`, so a helper added
 * later cannot leak into realm mode unnoticed.
 */

import test from "ava";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.resolve(here, "../../packages/core/src");

const gate = await import(
	pathToFileURL(path.join(core, "shared/rewriters/realm.ts")).href
);

test("script kinds follow the module and function body arguments", (t) => {
	t.is(gate.realmScriptKind(false, false), "classic");
	t.is(gate.realmScriptKind(true, false), "module");
	t.is(gate.realmScriptKind(false, true), "handler");
	// an event handler attribute is a function body whatever else is true
	t.is(gate.realmScriptKind(true, true), "handler");
});

test("javascript: urls keep a label the provider can recognise", (t) => {
	t.is(gate.JAVASCRIPT_URL_LABEL, "(javascript: url)");
});

test("a missing provider is an error and never a fallback", (t) => {
	const error = t.throws(() =>
		gate.realmScriptFor(undefined, "x", null, {}, {}, false, false)
	);
	t.regex(error.message, /no realmScript provider is registered/);
});

test("the provider receives the source, label, context and kind unchanged", (t) => {
	const calls = [];
	const context = { id: "context" };
	const meta = { id: "meta" };
	const provider = (...args) => {
		calls.push(args);
		return "stub";
	};

	t.is(
		gate.realmScriptFor(provider, "run()", "https://a.test/x.js", context, meta, true, false),
		"stub"
	);
	t.is(calls.length, 1);
	t.deepEqual(calls[0], ["run()", "https://a.test/x.js", context, meta, "module"]);
});

test("byte input and byte output pass through untouched", (t) => {
	const input = new Uint8Array([1, 2, 3]);
	const output = new Uint8Array([9]);
	const provider = (js) => {
		t.is(js, input);
		return output;
	};
	t.is(gate.realmScriptFor(provider, input, null, {}, {}, false, false), output);
});

function sources(dir) {
	const found = [];
	for (const entry of readdirSync(dir)) {
		const file = path.join(dir, entry);
		if (statSync(file).isDirectory()) found.push(...sources(file));
		else if (file.endsWith(".ts")) found.push(file);
	}
	return found;
}

test("every client module that defines a global helper is gated on realmExecution", (t) => {
	const offenders = sources(path.join(core, "client"))
		.filter((file) => /config\.globals\./.test(readFileSync(file, "utf8")))
		.filter((file) => !/realmExecution/.test(readFileSync(file, "utf8")))
		.map((file) => path.relative(core, file));

	t.deepEqual(
		offenders,
		[],
		"these modules define page-facing globals without checking realmExecution"
	);
});

test("the rewriter consults realmExecution before it reaches the wasm rewriter", (t) => {
	const source = readFileSync(path.join(core, "shared/rewriters/js.ts"), "utf8");
	const gateAt = source.indexOf('flagEnabled("realmExecution"');
	const wasmAt = source.indexOf("rewriteJsInner(js, url, context, meta, isModule)");
	t.true(gateAt !== -1, "the gate is present");
	t.true(wasmAt !== -1, "the rewriter call is present");
	t.true(gateAt < wasmAt, "the gate comes first");
});

test("script text in markup and urls only reaches a rewriter through scriptTextRewriter", (t) => {
	// A read of the registered rewriter anywhere else would leave script text raw
	// in realm mode whenever that rewriter is absent
	const strays = sources(core)
		.filter((file) => !file.endsWith(path.join("rewriters", "script-text.ts")))
		.filter((file) => /providers\(\)\.rewriteJs/.test(readFileSync(file, "utf8")))
		.map((file) => path.relative(core, file));
	t.deepEqual(strays, []);
});

test("an inline script keeps its comment markers in realm mode", (t) => {
	const source = readFileSync(path.join(core, "shared/rewriters/html.ts"), "utf8");
	const strip = source.indexOf("js = js.replace(htmlcomment");
	const guard = source.lastIndexOf('flagEnabled("realmExecution"', strip);
	t.true(strip !== -1 && guard !== -1, "the comment strip sits behind a realm check");
});
