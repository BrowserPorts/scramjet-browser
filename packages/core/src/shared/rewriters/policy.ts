// This file imports nothing at runtime so tests can load it without the build's
// path aliases. That also rules out the snapshotted natives the rest of core
// uses, so the few globals here carry a scoped exception. They are only reached
// with realmExecution on, where page code does not run in this realm to tamper
// with them.
/* eslint-disable scramjet-core/no-globals */

/**
 * The content security policy a document gets in realm mode.
 *
 * Realm mode never lets page code run in the frame's own realm, and the
 * rewriter is what keeps that true. A rewriter that misreads the markup, or a
 * DOM sink it does not cover, would put page code there anyway, so the browser
 * is asked to refuse it too: the policy admits only the scripts the rewriter
 * stubbed or injected, which carry the document's nonce, and the event handler
 * stubs it listed by hash. Everything else is refused by the browser itself,
 * including `eval`, string timers, workers and `javascript:` URLs.
 */
export interface DocumentPolicy {
	/** Carried by every script element the rewriter stubbed or injected */
	readonly nonce: string;
	/** Hashes of the event handler stubs in the markup, each as a CSP source */
	readonly handlerHashes: Set<string>;
	/** Set once the document's markup went through the HTML rewriter */
	rewritten: boolean;
}

/** For a response that can hold script but was not rewritten, so nothing in it may run */
export const LOCKED_DOCUMENT_POLICY =
	"script-src 'none'; script-src-attr 'none'; object-src 'none'; worker-src 'none'";

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256, synchronously, because rewriting markup is synchronous and a handler's hash is needed as it is rewritten */
export function sha256(message: Uint8Array): Uint8Array {
	const length = message.length;
	const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
	padded.set(message);
	padded[length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, Math.floor((length * 8) / 0x100000000), false);
	view.setUint32(padded.length - 4, (length * 8) >>> 0, false);

	const h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	]);
	const w = new Uint32Array(64);
	const rotr = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
	for (let offset = 0; offset < padded.length; offset += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, hh] = h;
		for (let i = 0; i < 64; i++) {
			const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const choose = (e & f) ^ (~e & g);
			const t1 = (hh + s1 + choose + K[i] + w[i]) >>> 0;
			const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (s0 + majority) >>> 0;
			hh = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		h[0] += a;
		h[1] += b;
		h[2] += c;
		h[3] += d;
		h[4] += e;
		h[5] += f;
		h[6] += g;
		h[7] += hh;
	}
	const digest = new Uint8Array(32);
	const out = new DataView(digest.buffer);
	for (let i = 0; i < 8; i++) out.setUint32(i * 4, h[i], false);
	return digest;
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** A CSP hash source for the exact text of an event handler attribute */
export function handlerHash(source: string): string {
	return `'sha256-${base64(sha256(new TextEncoder().encode(source)))}'`;
}

/** A policy with a fresh nonce for one document response */
export function createDocumentPolicy(
	randomBytes: (length: number) => Uint8Array = (length) => crypto.getRandomValues(new Uint8Array(length))
): DocumentPolicy {
	return { nonce: base64(randomBytes(18)), handlerHashes: new Set(), rewritten: false };
}

/**
 * The name of the one Trusted Types policy a document of this nonce may create. It is made
 * from the nonce, so the page, which never learns the nonce, cannot name it, and it is taken
 * by the client before any page code runs.
 */
export function trustedTypesPolicyName(nonce: string): string {
	return `tt-${nonce.replace(/[^A-Za-z0-9]/gu, "")}`;
}

/** The header for a document the rewriter handled */
export function documentPolicyHeader(policy: DocumentPolicy): string {
	// A hash admits an event handler attribute only with unsafe-hashes. Hashes do
	// not admit javascript: URLs in Chrome, so those never run in this mode.
	const attributes =
		policy.handlerHashes.size > 0 ? `'unsafe-hashes' ${[...policy.handlerHashes].join(" ")}` : "'none'";
	// Script text must come from a trusted source. The browser compares the text of a script
	// with what was last given through a trusted sink, and refuses a script whose text was
	// changed any other way, which no list of DOM paths the client hooks could promise. Only
	// the client makes a trusted script. The default policy lets every other sink take its
	// string, since only script is required to be trusted
	return `script-src 'nonce-${policy.nonce}' 'wasm-unsafe-eval'; script-src-attr ${attributes}; object-src 'none'; worker-src 'none'; require-trusted-types-for 'script'; trusted-types default ${trustedTypesPolicyName(policy.nonce)}`;
}

/** Destinations that can hold a document, and so script, of their own */
const SCRIPTED_DESTINATIONS = new Set(["document", "iframe", "frame", "embed", "object"]);

/** Whether a response for this destination needs a policy of its own */
export function carriesScript(destination: string): boolean {
	return SCRIPTED_DESTINATIONS.has(destination);
}

/**
 * The header for a response of a given destination: the nonce policy when its
 * markup was rewritten, and the locked one for anything else that can hold script.
 */
export function policyHeaderFor(destination: string, policy: DocumentPolicy | undefined): string | null {
	if (!carriesScript(destination)) return null;
	return policy?.rewritten ? documentPolicyHeader(policy) : LOCKED_DOCUMENT_POLICY;
}
