import { originTest } from "../testkit.ts";

/**
 * `<meta http-equiv="refresh">` rewriting.
 *
 * The navigation cases are settled host-side by the fixture's `pass` hook; the
 * time-only case is settled in the document and therefore reports through the
 * harness helpers, which attach the attempt nonce. The raw bindings do not.
 */
function refreshNavigationServerTest(props: { name: string; content: string }) {
	return originTest({
		name: props.name,
		// The refresh navigation is observed by the fixture, not reported by the
		// document: the origin server seeing the request *is* the result. A page
		// verdict cannot be satisfied here, and the attempt would only ever time out
		// waiting for a document that never reports.
		verdict: "host",
		start: async (server, _port, { pass }) => {
			let seenRefreshRequest = false;
			server.on("request", (req, res) => {
				if (req.url === "/") {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(`
						<!doctype html>
						<html>
							<head>
								<meta http-equiv="refresh" content="${props.content}">
							</head>
							<body>ok</body>
						</html>
					`);
					return;
				}

				if (req.url === "/next/page.html") {
					seenRefreshRequest = true;
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end("<!doctype html><html><body>next</body></html>");
					pass("refresh navigation reached origin server");
					return;
				}

				if (req.url === "/favicon.ico") {
					res.writeHead(204);
					res.end();
					return;
				}

				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Not found");
			});
		},
		autoPass: false,
	});
}

export default [
	refreshNavigationServerTest({
		name: "rewriter-refresh-lowercase-url-label",
		content: "5; url=/next/page.html",
	}),
	refreshNavigationServerTest({
		name: "rewriter-refresh-uppercase-url-label",
		content: "5; URL=/next/page.html",
	}),
	refreshNavigationServerTest({
		name: "rewriter-refresh-quoted-url",
		content: "0; URL='/next/page.html'",
	}),
	originTest({
		name: "rewriter-refresh-time-only",
		start: async (server) => {
			server.on("request", (req, res) => {
				if (req.url === "/") {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(`
						<!doctype html>
						<html>
							<head>
								<meta http-equiv="refresh" content="300">
							</head>
							<body>
								<script>
									const meta = document.querySelector('meta[http-equiv="refresh" i]');
									const actual = meta?.getAttribute("content") || "";
									if (actual === "300") {
										pass("time-only refresh unchanged");
									} else {
										fail("time-only refresh should be unchanged", { actual, expected: "300" });
									}
								</script>
							</body>
						</html>
					`);
					return;
				}

				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Not found");
			});
		},
	}),
];
