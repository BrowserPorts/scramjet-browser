/**
 * @fileoverview
 * Contract tests for the content security policy a document gets in realm
 * mode. The hash is checked against Node's own SHA-256, and the header shapes
 * are the ones a real Chrome was shown to enforce: a nonce admits the scripts the
 * rewriter stubbed or injected, a listed hash admits an event handler stub, and
 * a hash does not admit a `javascript:` URL.
 */

import test from "ava";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const policy = await import(
	pathToFileURL(path.join(here, "../../packages/core/src/shared/rewriters/policy.ts")).href
);

const sha = (bytes) => createHash("sha256").update(bytes).digest();

test("sha256 matches Node across the padding boundaries", (t) => {
	for (const length of [0, 1, 3, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 65537]) {
		const bytes = Uint8Array.from({ length }, (_, index) => (index * 31 + length) & 0xff);
		t.deepEqual(Buffer.from(policy.sha256(bytes)), sha(bytes), `length ${length}`);
	}
});

test("sha256 matches Node for known strings", (t) => {
	const text = new TextEncoder();
	for (const value of ["", "abc", "var d={k:\"handler\"}", "caf\u00e9 \u{1f600}", "a".repeat(5000)]) {
		const bytes = text.encode(value);
		t.deepEqual(Buffer.from(policy.sha256(bytes)), sha(bytes), JSON.stringify(value).slice(0, 30));
	}
});

test("a handler hash is a base64 sha256 source of the exact text", (t) => {
	const source = "window.go(this)";
	t.is(policy.handlerHash(source), `'sha256-${sha(Buffer.from(source)).toString("base64")}'`);
	t.not(policy.handlerHash(source), policy.handlerHash(`${source} `));
});

test("every document gets a fresh nonce that is a valid CSP source", (t) => {
	const first = policy.createDocumentPolicy();
	const second = policy.createDocumentPolicy();
	t.not(first.nonce, second.nonce);
	t.regex(first.nonce, /^[A-Za-z0-9+/]+={0,2}$/);
	t.true(Buffer.from(first.nonce, "base64").length >= 16, "at least 128 bits");
	t.false(first.rewritten);
	t.is(first.handlerHashes.size, 0);
});

test("the nonce is derived from the random bytes it is given", (t) => {
	const made = policy.createDocumentPolicy((length) => new Uint8Array(length).fill(7));
	t.is(made.nonce, Buffer.alloc(18, 7).toString("base64"));
});

test("the header admits the nonce and wasm, and nothing else", (t) => {
	const made = policy.createDocumentPolicy(() => new Uint8Array(18));
	const header = policy.documentPolicyHeader(made);
	t.true(header.startsWith(`script-src 'nonce-${made.nonce}' 'wasm-unsafe-eval';`));
	t.regex(header, /script-src-attr 'none'/);
	t.regex(header, /object-src 'none'/);
	t.regex(header, /worker-src 'none'/);
	t.notRegex(header, /'unsafe-inline'|'unsafe-eval'|'strict-dynamic'|\*/);
	// wasm-unsafe-eval is the only unsafe keyword allowed, and eval itself stays refused
	t.deepEqual([...header.matchAll(/'[a-z-]*unsafe-[a-z-]+'/g)].map((match) => match[0]), ["'wasm-unsafe-eval'"]);
});

test("listed handler hashes are admitted for attributes only", (t) => {
	const made = policy.createDocumentPolicy();
	made.handlerHashes.add(policy.handlerHash("one()"));
	made.handlerHashes.add(policy.handlerHash("two()"));
	made.handlerHashes.add(policy.handlerHash("one()"));
	const header = policy.documentPolicyHeader(made);
	t.is(made.handlerHashes.size, 2, "identical handlers share a hash");
	t.regex(header, /script-src-attr 'unsafe-hashes' 'sha256-[^']+' 'sha256-[^']+';/);
	const scriptSrc = header.split(";")[0];
	t.notRegex(scriptSrc, /sha256/, "hashes are not admitted for script elements");
	t.notRegex(scriptSrc, /unsafe-hashes/);
});

test("a response that holds script but was not rewritten is locked", (t) => {
	t.regex(policy.LOCKED_DOCUMENT_POLICY, /^script-src 'none'; script-src-attr 'none'/);
	for (const destination of ["document", "iframe", "frame", "embed", "object"]) {
		t.is(policy.policyHeaderFor(destination, undefined), policy.LOCKED_DOCUMENT_POLICY, destination);
		const made = policy.createDocumentPolicy();
		t.is(policy.policyHeaderFor(destination, made), policy.LOCKED_DOCUMENT_POLICY, `${destination} not rewritten`);
	}
});

test("a rewritten document gets its nonce policy", (t) => {
	const made = policy.createDocumentPolicy();
	made.rewritten = true;
	t.is(policy.policyHeaderFor("document", made), policy.documentPolicyHeader(made));
	t.is(policy.policyHeaderFor("iframe", made), policy.documentPolicyHeader(made));
});

test("destinations that cannot hold a document get no policy", (t) => {
	for (const destination of ["script", "style", "image", "font", "worker", "audioworklet", ""]) {
		t.is(policy.policyHeaderFor(destination, undefined), null, destination);
	}
});
