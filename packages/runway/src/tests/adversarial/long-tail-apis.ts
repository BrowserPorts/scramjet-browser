import http from "node:http";
import { fixtureTest, listen, scriptTest } from "../../testkit.ts";

/* eslint-disable quotes -- browser snippets are clearer as template literals */

// KNOWN FAILURES in APIs that Scramjet already intercepts but that sit well
// outside the primary DOM/fetch/navigation paths. Keep these as differential
// tests: the bare harness is the browser oracle and each case is issue-sized.
const probe = (name: string, js: string) =>
	scriptTest({
		name: `longtail-api-${name}`,
		js: `
			const snapshot = async () => {
				try {
					return { value: await (${js}) };
				} catch (error) {
					return { error: error && error.name, message: error && error.message };
				}
			};
			await assertConsistent(${JSON.stringify(name)}, await snapshot());
		`,
	});

/**
 * Describes a URL a browser API reported, relative to the host-known fixture origin.
 *
 * Each lane gets its own fixture instance on its own OS-allocated port, so an
 * absolute resource URL never matches across lanes and a raw comparison reports a
 * disagreement about the port instead of about the API. The fix is not to scrub
 * strings: only the fixture origin the *host* knows it served is folded away, and
 * that origin is embedded in the script by the fixture itself when the port is
 * allocated. The guest's `location.origin` is never trusted for this — it is the
 * thing under test, so comparing through it would fold away exactly the leak the
 * probe is meant to catch.
 *
 * Any other origin — the proxy's origin, a leaked harness origin, a different
 * fixture — is reported verbatim, so a cross-origin regression still shows up as a
 * difference between the lanes. The pathname and search survive intact, because
 * that is the part these APIs are being asked about.
 *
 * `expectedOrigin` is the fixture origin serialized by the host. The reported
 * value must be an absolute URL and is parsed with no base: a relative value is
 * evidence (`kind: "relative"`), never coerced into the expected origin to make
 * the comparison pass.
 */
export const DESCRIBE_URL = `
	const describeAgainstHostOrigin = (expectedOrigin, raw) => {
		if (typeof raw !== "string") return { kind: "not-a-string", type: typeof raw, raw: raw };
		let parsed;
		try {
			parsed = new URL(raw);
		} catch (error) {
			return { kind: "unparsable", raw: raw };
		}
		if (parsed.origin === "null") {
			return { kind: "opaque", href: parsed.href };
		}
		if (parsed.origin !== expectedOrigin) {
			return {
				kind: "foreign-origin",
				origin: parsed.origin,
				pathname: parsed.pathname,
				search: parsed.search,
			};
		}
		return {
			kind: "expected-origin",
			pathname: parsed.pathname,
			search: parsed.search,
			hash: parsed.hash,
		};
	};
`;

/**
 * A probe whose value is a URL, compared against the host-known fixture origin.
 *
 * The fixture owns its listener, so it knows the port it bound and embeds that
 * exact origin into the served script: the expected origin comes from the host
 * that allocated it, never from the guest. The page asserts it actually loaded
 * on that origin before normalizing — if the proxy navigated somewhere else, the
 * mismatch is a page failure, not a quietly folded comparison.
 *
 * `performance.getEntriesByName` and company stay plain `probe`s: only these two
 * URL-reporting snapshots take a host origin.
 */
const urlProbe = (name: string, js: string) =>
	fixtureTest({
		name: `longtail-api-${name}`,
		create: () => {
			let server: http.Server | null = null;
			const fullName = `longtail-api-${name}`;
			return {
				start: async () => {
					server = http.createServer((req, res) => {
						if (req.url === "/") {
							res.writeHead(200, { "Content-Type": "text/html" });
							res.end(
								`<!DOCTYPE html><html><head></head><body><h1>Test - ${fullName}</h1>` +
									`<script src="/script.js"></script></body></html>`
							);
							return;
						}
						if (req.url === "/script.js") {
							// Read back from the listening socket at request time, so the
							// embedded origin is always the one this instance bound.
							const address = server?.address();
							const bound =
								address && typeof address === "object" ? address.port : 0;
							const expectedOrigin = `http://localhost:${bound}`;
							res.writeHead(200, { "Content-Type": "application/javascript" });
							res.end(
								`runTest(async () => {\n` +
									`${DESCRIBE_URL}\n` +
									`assertEqual(location.origin, ${JSON.stringify(expectedOrigin)}, "the document must load on the fixture origin");\n` +
									`const value = await (${js});\n` +
									`await assertConsistent(${JSON.stringify(name)}, { value: describeAgainstHostOrigin(${JSON.stringify(expectedOrigin)}, value) });\n` +
									`}, true);`
							);
							return;
						}
						res.writeHead(404);
						res.end("Not found");
					});
					return listen(server);
				},
				stop: async () => {
					if (!server) return;
					const closing = server;
					server = null;
					closing.closeAllConnections?.();
					await new Promise<void>((resolve) => closing.close(() => resolve()));
				},
			};
		},
	});

export default [
	// Navigator protocol-handler methods are explicitly intercepted as no-ops.
	probe(
		"protocol-register-missing-arguments",
		`(() => navigator.registerProtocolHandler())()`
	),
	probe(
		"protocol-register-forbidden-scheme",
		`(() => navigator.registerProtocolHandler("http", location.origin + "/open?url=%s"))()`
	),
	probe(
		"protocol-register-invalid-scheme",
		`(() => navigator.registerProtocolHandler("not a scheme", location.origin + "/open?url=%s"))()`
	),
	probe(
		"protocol-register-missing-placeholder",
		`(() => navigator.registerProtocolHandler("web+runway", location.origin + "/open"))()`
	),
	probe(
		"protocol-register-cross-origin-template",
		`(() => navigator.registerProtocolHandler("web+runway", "https://example.com/open?url=%s"))()`
	),
	probe(
		"protocol-unregister-missing-arguments",
		`(() => navigator.unregisterProtocolHandler())()`
	),
	probe(
		"protocol-unregister-invalid-scheme",
		`(() => navigator.unregisterProtocolHandler("not a scheme", location.origin + "/open?url=%s"))()`
	),

	// PerformanceEntry.name and all entry-list methods are intercepted. These two
	// report absolute URLs, so they are compared as descriptions relative to the
	// host-known fixture origin rather than as absolute strings containing a
	// per-attempt port.
	urlProbe(
		"performance-resource-tojson-name",
		`(() => performance.getEntriesByType("resource").find((e) => e.name.endsWith("/script.js")).toJSON().name)()`
	),
	urlProbe(
		"performance-navigation-tojson-name",
		`(() => performance.getEntriesByType("navigation")[0].toJSON().name)()`
	),
	probe(
		"performance-getentriesbyname-author-url",
		`(() => performance.getEntriesByName(location.origin + "/script.js").length)()`
	),
	probe(
		"performance-user-mark-masked-name",
		`(() => { performance.mark("inject.js"); const count = performance.getEntriesByType("mark").filter((e) => e.name === "inject.js").length; performance.clearMarks("inject.js"); return count; })()`
	),

	// document.domain is a deprecated but still-intercepted Document surface.
	probe(
		"document-domain-invalid-setter",
		`(() => { document.domain = "example.com"; return document.domain; })()`
	),
	probe(
		"document-domain-getter-brand",
		`(() => Object.getOwnPropertyDescriptor(Document.prototype, "domain").get.call({}))()`
	),
	probe(
		"document-domain-setter-brand",
		`(() => Object.getOwnPropertyDescriptor(Document.prototype, "domain").set.call({}, "localhost"))()`
	),

	// CSS Typed OM parse() is intercepted even though the rest of Typed OM is not.
	probe(
		"typed-om-background-image-readback",
		`(() => typeof CSSStyleValue === "undefined" ? "unsupported" : CSSStyleValue.parse("background-image", "url(/a.png)").toString())()`
	),
	probe(
		"typed-om-background-shorthand-readback",
		`(() => typeof CSSStyleValue === "undefined" ? "unsupported" : CSSStyleValue.parse("background", "url(/a.png) center").toString())()`
	),
	probe(
		"typed-om-custom-property-readback",
		`(() => typeof CSSStyleValue === "undefined" ? "unsupported" : CSSStyleValue.parse("--asset", "url(/a.png)").toString())()`
	),

	// getSVGDocument() and embedded contentDocument/contentWindow are intercepted.
	probe(
		"svgdocument-object-blob",
		`(async () => {
			const url = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>'], {type:"image/svg+xml"}));
			const object = document.createElement("object");
			object.type = "image/svg+xml";
			object.data = url;
			document.body.append(object);
			await new Promise((resolve) => { object.onload = resolve; object.onerror = resolve; });
			const doc = object.getSVGDocument();
			const value = doc && [doc === object.contentDocument, doc.documentElement.localName];
			object.remove();
			URL.revokeObjectURL(url);
			return value;
		})()`
	),
	probe(
		"svgdocument-embed-blob",
		`(async () => {
			const url = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>'], {type:"image/svg+xml"}));
			const embed = document.createElement("embed");
			embed.type = "image/svg+xml";
			embed.src = url;
			document.body.append(embed);
			await new Promise((resolve) => { embed.onload = resolve; embed.onerror = resolve; });
			const doc = embed.getSVGDocument();
			const value = doc && [doc === embed.contentDocument, doc.documentElement.localName];
			embed.remove();
			URL.revokeObjectURL(url);
			return value;
		})()`
	),
	// The new HTML serialization APIs have dedicated interceptors.
	probe(
		"gethtml-serializable-boolean-attribute",
		`(() => {
			if (!Element.prototype.getHTML) return "unsupported";
			const host = document.createElement("div");
			host.attachShadow({mode:"open", serializable:true}).innerHTML = "<span></span>";
			return host.getHTML({serializableShadowRoots:true});
		})()`
	),
	probe(
		"parsehtmlunsafe-secondary-document-url",
		`(() => {
			if (!Document.parseHTMLUnsafe) return "unsupported";
			const parsed = Document.parseHTMLUnsafe("<p>x</p>");
			return [parsed.URL, parsed.documentURI, parsed.baseURI];
		})()`
	),
];
