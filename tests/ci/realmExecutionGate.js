/**
 * @fileoverview
 * Contract tests for the `realmExecution` flag.
 *
 * With the flag on, page script text becomes a stub that hands the text to the
 * embedder's realm, and none of the page-facing `$scramjet*` helpers are
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

const config = { realm: { eventType: "evt-1" } };

test("script kinds follow the module and function body arguments", (t) => {
	t.is(gate.realmScriptKind(false, false), "classic");
	t.is(gate.realmScriptKind(true, false), "module");
	t.is(gate.realmScriptKind(false, true), "handler");
	// an event handler attribute is a function body whatever else is true
	t.is(gate.realmScriptKind(true, true), "handler");
});

test("javascript: urls keep a label the rewriter can recognise", (t) => {
	t.is(gate.JAVASCRIPT_URL_LABEL, "(javascript: url)");
});

test("a config with no realm event type is an error and never a fallback", (t) => {
	for (const bad of [{}, { realm: {} }, { realm: { eventType: "" } }]) {
		const error = t.throws(() => gate.realmScriptFor(bad, "x", null, false, false));
		t.regex(error.message, /names no realm event type/);
	}
});

test("classic and module text become stubs for the configured event", (t) => {
	const classic = gate.realmScriptFor(config, "run()", "https://a.test/x.js", false, false);
	t.true(gate.isRealmStub(classic, "evt-1"));
	t.false(gate.isRealmStub(classic, "evt-2"));
	t.is(gate.readRealmStubSource(classic, "evt-1"), "run()");
	t.regex(classic, /"classic"/);
	t.regex(classic, /"https:\/\/a\.test\/x\.js"/);

	const module = gate.realmScriptFor(config, "export {}", null, true, false);
	t.regex(module, /"module"/);
	t.regex(module, /await d\.p;$/);
	t.is(gate.readRealmStubSource(module, "evt-1"), "export {}");
});

test("placeholder labels are not urls a page could see", (t) => {
	const stub = gate.realmScriptFor(config, "x", "(inline script element)", false, false);
	t.regex(stub, /,u:null,/);
});

test("every event handler gets the same text, whatever its source", (t) => {
	const one = gate.realmScriptFor(config, "a()", "(inline onclick on element)", false, true);
	const two = gate.realmScriptFor(config, "b(); c()", "(inline onerror on element)", false, true);
	t.is(one, two);
	t.is(one, gate.createRealmHandlerStub("evt-1"));
	t.true(gate.isRealmStub(one, "evt-1"));
	t.is(gate.readRealmStubSource(one, "evt-1"), null, "it holds no source");
});

test("byte input is read as utf-8", (t) => {
	const bytes = new TextEncoder().encode("café()");
	const stub = gate.realmScriptFor(config, bytes, null, false, false);
	t.is(gate.readRealmStubSource(stub, "evt-1"), "café()");
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

test("a javascript: url is inert in realm mode before it reaches any rewriter", (t) => {
	const source = readFileSync(path.join(core, "shared/rewriters/url.ts"), "utf8");
	const inert = source.indexOf("REALM_INERT_JAVASCRIPT_URL;");
	const rewriter = source.indexOf("scriptTextRewriter(context, meta)");
	t.true(inert !== -1 && rewriter !== -1);
	t.true(inert < rewriter);
});
