import { serverTest } from "../../testcommon.ts";

// document.cookie is emulated against the proxy's own jar, so a script write
// has to be reflected in two places: back through document.cookie, and in the
// Cookie header of subsequent requests.
//
// Existing coverage (tests/cookies.ts) checks the server-to-script direction.
// These go the other way, which is the direction the classic pattern uses:
//   document.cookie = "csrftoken=…"; fetch("/api", {method: "POST"})
//
// The write reaches the jar asynchronously, so a request issued in the same task
// can go out without the cookie - reproducible on an idle machine with either
// fetch or a synchronous XHR, but it stops reproducing under load, so it is not
// asserted here. What is asserted is the shape around it: the cookie is present
// after a short delay, and after any intervening request.

const jarTest = (name: string, js: string) =>
	serverTest({
		name,
		autoPass: true,
		js,
		start: async (server) => {
			server.on("request", (req, res) => {
				if (res.headersSent) return;
				const path = (req.url || "/").split("?")[0];
				if (path === "/" || path === "/script.js") return;
				if (path === "/plain-frame") {
					res.writeHead(200, { "Content-Type": "text/plain" });
					res.end("A frame without an injected cookie receiver");
					return;
				}
				if (path === "/slow-parser-frame.html") {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(
						'<!doctype html><html><body><script>parent.postMessage("parser-loading", "*")</script><script src="/slow-parser.js"></script></body></html>',
					);
					return;
				}
				if (path === "/slow-parser.js") {
					setTimeout(() => {
						res.writeHead(200, { "Content-Type": "application/javascript" });
						res.end("window.parserFinished = true;");
					}, 1800);
					return;
				}
				if (path === "/early-write-frame.html") {
					// Writes during parsing, then checks the cookie between every posted message task,
					// the task source the jar sync arrives on, until the sync has settled
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(`<!doctype html><html><body><script>
						document.cookie = "early=1; Path=/";
						const started = performance.now();
						let lost = false;
						const ticks = new MessageChannel();
						ticks.port1.onmessage = () => {
							if (!document.cookie.includes("early=1")) lost = true;
							if (performance.now() - started < 500) ticks.port2.postMessage(0);
							else parent.postMessage({ earlyCookieLost: lost }, "*");
						};
						ticks.port2.postMessage(0);
					</script></body></html>`);
					return;
				}
				if (path === "/written-child-frame.html") {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(`<!doctype html><html><body><iframe id="child"></iframe><script>
						const child = document.getElementById("child").contentDocument;
						child.open();
						child.write("<p>Written child</p>");
						child.close();
					</script></body></html>`);
					return;
				}
				if (path === "/frame.html" || path === "/nested.html") {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(
						path === "/nested.html"
							? '<!doctype html><html><body><iframe src="/frame.html"></iframe></body></html>'
							: "<!doctype html><html><body>Cookie frame</body></html>",
					);
					return;
				}
				if (path === "/setcookie") {
					res.writeHead(200, {
						"Content-Type": "text/plain",
						"Set-Cookie": "srv=srvvalue; Path=/",
					});
					res.end("ok");
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
			});
		},
	});

export default [
	jarTest(
		"ckjar-write-then-read",
		`
			document.cookie = "a=1";
			assert(document.cookie.includes("a=1"), "document.cookie reads back its own write: " + document.cookie);
			document.cookie = "b=2; Path=/";
			assert(document.cookie.includes("b=2"), "a second cookie: " + document.cookie);
			assert(document.cookie.includes("a=1"), "the first one survives: " + document.cookie);
		`,
	),
	jarTest(
		"ckjar-overwrite",
		`
			document.cookie = "o=first; Path=/";
			document.cookie = "o=second; Path=/";
			const matches = document.cookie.split("; ").filter((c) => c.startsWith("o="));
			assertDeepEqual(matches, ["o=second"], "overwriting replaces rather than duplicates: " + document.cookie);
		`,
	),
	jarTest(
		"ckjar-delete",
		`
			document.cookie = "d=1; Path=/";
			assert(document.cookie.includes("d=1"), "precondition: " + document.cookie);
			document.cookie = "d=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
			assert(!document.cookie.includes("d=1"), "an expired cookie is gone: " + document.cookie);
			document.cookie = "e=1; Path=/";
			document.cookie = "e=1; Path=/; Max-Age=0";
			assert(!document.cookie.includes("e=1"), "Max-Age=0 removes it: " + document.cookie);
		`,
	),
	jarTest(
		"ckjar-path-scoping",
		`
			document.cookie = "scoped=v; Path=/deep/other";
			assert(!document.cookie.includes("scoped=v"),
				"a cookie scoped to another path must not be readable here: " + document.cookie);
			document.cookie = "here=v; Path=/";
			assert(document.cookie.includes("here=v"), "Path=/ is readable: " + document.cookie);
		`,
	),
	jarTest(
		"ckjar-value-encoding",
		`
			document.cookie = "enc=" + encodeURIComponent("a b&c=d");
			assert(document.cookie.includes("enc=a%20b%26c%3Dd"), "an encoded value round trips verbatim: " + document.cookie);
			document.cookie = "eq=x=y; Path=/";
			assert(document.cookie.includes("eq=x=y"), "a value containing = is preserved: " + document.cookie);
		`,
	),
	jarTest(
		"ckjar-server-cookie-sent",
		`
			await fetch("/setcookie");
			const j = await (await fetch("/echo")).json();
			assert((j.cookie || "").includes("srv=srvvalue"), "a server-set cookie is sent: " + JSON.stringify(j.cookie));
			assert(document.cookie.includes("srv=srvvalue"), "and is visible to script: " + document.cookie);
		`,
	),
	jarTest(
		"ckjar-server-cookie-nested-frames",
		`
			const frame = document.createElement("iframe");
			const loaded = new Promise((resolve) => { frame.onload = resolve; });
			frame.src = "/nested.html";
			document.body.appendChild(frame);
			await loaded;
			const response = await fetch("/setcookie");
			assertEqual(response.status, 200, "setting a cookie completes with nested frames open");
			assert(document.cookie.includes("srv=srvvalue"), "the parent receives the cookie");
			assert(frame.contentDocument.cookie.includes("srv=srvvalue"), "the child receives the cookie");
			const nested = frame.contentDocument.querySelector("iframe");
			assert(nested.contentDocument.cookie.includes("srv=srvvalue"), "the nested child receives the cookie");
		`,
	),
	jarTest(
		"ckjar-server-cookie-slow-parser-frame",
		`
			const frame = document.createElement("iframe");
			const loaded = new Promise((resolve) => { frame.onload = resolve; });
			const parsing = new Promise((resolve) => {
				const handler = (event) => {
					if (event.data !== "parser-loading") return;
					window.removeEventListener("message", handler);
					resolve();
				};
				window.addEventListener("message", handler);
			});
			frame.src = "/slow-parser-frame.html";
			document.body.appendChild(frame);
			await parsing;
			const response = await fetch("/setcookie");
			assertEqual(response.status, 200, "a parser-blocking script does not delay cookie readiness: " + await response.text());
			assertEqual(frame.contentDocument.readyState, "loading", "cookies synchronize before DOMContentLoaded");
			assert(document.cookie.includes("srv=srvvalue"), "the parent receives the cookie");
			assert(frame.contentDocument.cookie.includes("srv=srvvalue"), "the child receives the cookie");
			await loaded;
		`,
	),
	jarTest(
		"ckjar-server-cookie-uninitialized-frame",
		`
			const frame = document.createElement("iframe");
			const loaded = new Promise((resolve) => { frame.onload = resolve; });
			frame.src = "/plain-frame";
			document.body.appendChild(frame);
			await loaded;
			const response = await fetch("/setcookie");
			assertEqual(response.status, 200, "a non-HTML frame does not block cookie propagation");
			assert(document.cookie.includes("srv=srvvalue"), "the initialized parent receives the cookie");
			const echo = await (await fetch("/echo")).json();
			assert((echo.cookie || "").includes("srv=srvvalue"), "the next request sends the cookie");
		`,
	),
	jarTest(
		"ckjar-server-cookie-document-write-frame",
		`
			const frame = document.createElement("iframe");
			document.body.appendChild(frame);
			const doc = frame.contentDocument;
			doc.open();
			doc.writeln("<!doctype html><html><body>Written cookie frame</body></html>");
			doc.close();
			const response = await fetch("/setcookie");
			assertEqual(response.status, 200, "document-written frames do not block cookie propagation: " + await response.text());
			assert(document.cookie.includes("srv=srvvalue"), "the parent receives the cookie");
			assert(frame.contentDocument.cookie.includes("srv=srvvalue"), "the written frame receives the cookie");
		`,
	),
	jarTest(
		"ckjar-server-cookie-removed-frame",
		`
			const frame = document.createElement("iframe");
			const loaded = new Promise((resolve) => { frame.onload = resolve; });
			frame.src = "/frame.html";
			document.body.appendChild(frame);
			await loaded;
			const started = performance.now();
			const pending = fetch("/setcookie");
			frame.remove();
			const response = await pending;
			assertEqual(response.status, 200, "a removed receiver does not block cookie propagation");
			assert(performance.now() - started < 800, "a removed receiver does not stall the response");
			assert(document.cookie.includes("srv=srvvalue"), "the remaining parent receives the cookie");
		`,
	),
	jarTest(
		"ckjar-server-cookie-departed-written-child",
		`
			const frame = document.createElement("iframe");
			const loaded = () => new Promise((resolve) => { frame.onload = resolve; });
			let next = loaded();
			frame.src = "/written-child-frame.html";
			document.body.appendChild(frame);
			await next;
			next = loaded();
			frame.src = "/frame.html";
			await next;
			const started = performance.now();
			const response = await fetch("/setcookie");
			assertEqual(response.status, 200, "setting a cookie completes after a written child went away with its page");
			const elapsed = Math.round(performance.now() - started);
			assert(elapsed < 800, "a written child that went away with its page does not stall the response: " + elapsed + "ms");
			assert(frame.contentDocument.cookie.includes("srv=srvvalue"), "the frame's new page receives the cookie");
		`,
	),
	jarTest(
		"ckjar-script-cookie-survives-snapshot",
		`
			const frame = document.createElement("iframe");
			const result = new Promise((resolve) => {
				const handler = (event) => {
					if (typeof event.data?.earlyCookieLost !== "boolean") return;
					window.removeEventListener("message", handler);
					resolve(event.data.earlyCookieLost);
				};
				window.addEventListener("message", handler);
			});
			frame.src = "/early-write-frame.html";
			document.body.appendChild(frame);
			assertEqual(await result, false, "a cookie written during parsing never drops out of document.cookie");
		`,
	),
	jarTest(
		"ckjar-cookie-sync-hidden-from-site",
		`
			const seen = [];
			const record = (event) => { seen.push(event.data); };
			navigator.serviceWorker.onmessage = record;
			navigator.serviceWorker.addEventListener("message", record);
			const frame = document.createElement("iframe");
			const loaded = new Promise((resolve) => { frame.onload = resolve; });
			frame.src = "/frame.html";
			document.body.appendChild(frame);
			await loaded;
			await fetch("/setcookie");
			await new Promise((resolve) => setTimeout(resolve, 200));
			const internal = seen.filter((data) =>
				data && typeof data === "object" && Object.keys(data).some((key) => /cookie/i.test(key)));
			assertEqual(internal.length, 0, "the site's service worker listeners see no cookie sync traffic");
		`,
	),
	jarTest(
		"ckjar-script-cookie-sent-eventually",
		`
			// the companion to ckjar-script-cookie-sent-immediately: the write does
			// arrive, it just isn't in place for a request made in the same tick
			document.cookie = "later=v; Path=/";
			await new Promise((r) => setTimeout(r, 300));
			const j = await (await fetch("/echo")).json();
			assert((j.cookie || "").includes("later=v"), "sent after a delay: " + JSON.stringify(j.cookie));
		`,
	),
	jarTest(
		"ckjar-script-cookie-sent-after-request",
		`
			document.cookie = "afterreq=v; Path=/";
			await fetch("/echo");
			const j = await (await fetch("/echo")).json();
			assert((j.cookie || "").includes("afterreq=v"), "sent on the second request: " + JSON.stringify(j.cookie));
		`,
	),

	// ------------------------------------------------------------------
];
