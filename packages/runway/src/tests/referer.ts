import http from "http";
import { fixtureTest, listen, type NativeTest } from "../testkit.ts";

function html(body: string) {
	return `<!doctype html><html><body>${body}</body></html>`;
}

function close(server?: http.Server): Promise<void> {
	if (!server) return Promise.resolve();

	return new Promise((resolve) => {
		server.closeAllConnections?.();
		server.close(() => resolve());
	});
}

function requestRefererTest(props: {
	name: string;
	expectedReferer: (sourcePort: number) => string;
	crossOrigin?: boolean;
}): NativeTest {
	const pagePath = "/source/page.html?token=runway";
	const pagePathname = "/source/page.html";

	return fixtureTest({
		name: props.name,
		verdict: "host",
		create: () => {
			let sourceServer: http.Server | undefined;
			let targetServer: http.Server | undefined;
			let sourcePort = 0;
			let targetPort = 0;
			let settled = false;
			return {
		async start({ pass, fail }) {
			settled = false;

			const finish = async (
				status: "pass" | "fail",
				message?: string,
				details?: any
			) => {
				if (settled) return;
				settled = true;
				if (status === "pass") {
					await pass(message, details);
				} else {
					await fail(message, details);
				}
			};

			const handleTargetRequest = (
				req: http.IncomingMessage,
				res: http.ServerResponse
			) => {
				if (req.url !== "/inspect") {
					res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
					res.end("Not found");
					return;
				}

				const actual = req.headers.referer ?? null;
				const expected = props.expectedReferer(sourcePort);

				res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
				res.end();

				if (actual === expected) {
					void finish("pass", `received expected referer: ${expected}`);
				} else {
					void finish("fail", "unexpected referer header", {
						actual,
						expected,
					});
				}
			};

			if (props.crossOrigin) {
				targetServer = http.createServer(handleTargetRequest);
				targetPort = await listen(targetServer);
			}

			sourceServer = http.createServer((req, res) => {
				const url = new URL(req.url ?? "/", "http://localhost");

				if (url.pathname === "/") {
					res.writeHead(302, { Location: pagePath });
					res.end();
					return;
				}

				if (
					url.pathname === pagePathname &&
					url.searchParams.get("token") === "runway"
				) {
					const inspectUrl = props.crossOrigin
						? `http://localhost:${targetPort}/inspect`
						: `http://localhost:${sourcePort}/inspect`;

					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(
						html(
							`<script>
								runTest(async () => {
									await fetch(${JSON.stringify(inspectUrl)});
								}, false);
							</script>`
						)
					);
					return;
				}

				if (!props.crossOrigin) {
					handleTargetRequest(req, res);
					return;
				}

				res.writeHead(404);
				res.end("Not found");
			});

			sourcePort = await listen(sourceServer);
			if (!props.crossOrigin) {
				targetPort = sourcePort;
			}
			// The fixture owns its listeners, so it reports the port the harness
			// should navigate to instead of mutating a shared test object.
			return sourcePort;
		},
		async stop() {
			await Promise.all([close(sourceServer), close(targetServer)]);
		},
			};
		},
	});
}

function iframeRefererTest(props: {
	name: string;
	expectedReferer: (sourcePort: number) => string;
	crossOrigin?: boolean;
	sameDocumentNavigation?: boolean;
	mode: "document" | "request";
}): NativeTest {
	const parentPath = "/source/parent.html?token=runway-iframe";
	const parentPathname = "/source/parent.html";
	const childPathname = "/child/frame.html";

	const childHtml = (actualRefererHeader: string | null, sourcePort: number) => {
		const expected = props.expectedReferer(sourcePort);
		const assertions =
			props.mode === "request"
				? `
					assertEqual(
						${JSON.stringify(actualRefererHeader)},
						${JSON.stringify(expected)},
						"iframe navigation should send the expected Referer header"
					);
				`
				: `
					assertEqual(
						document.referrer,
						${JSON.stringify(expected)},
						"iframe document.referrer should match the expected parent referrer"
					);
					assert(
						document.referrer !== location.href,
						"iframe document.referrer should not equal the iframe location"
					);
					${props.sameDocumentNavigation ? `
						const referrerBefore = document.referrer;
						history.pushState(null, "", "?after-push-state");
						assertEqual(
							document.referrer,
							referrerBefore,
							"same-document navigation should preserve document.referrer"
						);
					` : ""}
				`;
		return html(
			`<script>
				runTest(async () => {
					${assertions}
				}, true);
			</script>`
		);
	};

	return fixtureTest({
		name: props.name,
		create: () => {
			let sourceServer: http.Server | undefined;
			let targetServer: http.Server | undefined;
			let sourcePort = 0;
			let targetPort = 0;
			return {
		async start() {
			const handleChildRequest = (
				req: http.IncomingMessage,
				res: http.ServerResponse
			) => {
				if (
					new URL(req.url ?? "/", "http://localhost").pathname !== childPathname
				) {
					res.writeHead(404);
					res.end("Not found");
					return;
				}

				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(childHtml(req.headers.referer ?? null, sourcePort));
			};

			if (props.crossOrigin) {
				targetServer = http.createServer(handleChildRequest);
				targetPort = await listen(targetServer);
			}

			sourceServer = http.createServer((req, res) => {
				const url = new URL(req.url ?? "/", "http://localhost");

				if (url.pathname === "/") {
					res.writeHead(302, { Location: parentPath });
					res.end();
					return;
				}

				if (
					url.pathname === parentPathname &&
					url.searchParams.get("token") === "runway-iframe"
				) {
					const childUrl = props.crossOrigin
						? `http://localhost:${targetPort}${childPathname}`
						: `http://localhost:${sourcePort}${childPathname}`;
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(html(`<iframe src="${childUrl}" id="child"></iframe>`));
					return;
				}

				if (!props.crossOrigin) {
					handleChildRequest(req, res);
					return;
				}

				res.writeHead(404);
				res.end("Not found");
			});

			sourcePort = await listen(sourceServer);
			if (!props.crossOrigin) {
				targetPort = sourcePort;
			}
			// The fixture owns its listeners, so it reports the port the harness
			// should navigate to instead of mutating a shared test object.
			return sourcePort;
		},
		async stop() {
			await Promise.all([close(sourceServer), close(targetServer)]);
		},
			};
		},
	});
}

export default [
	iframeRefererTest({
		name: "referer-document-referrer-is-not-current-location",
		mode: "document",
		sameDocumentNavigation: true,
		expectedReferer: (sourcePort) =>
			`http://localhost:${sourcePort}/source/parent.html?token=runway-iframe`,
	}),
	requestRefererTest({
		name: "referer-fetch-same-origin-sends-full-url",
		expectedReferer: (sourcePort) =>
			`http://localhost:${sourcePort}/source/page.html?token=runway`,
	}),
	requestRefererTest({
		name: "referer-fetch-cross-origin-sends-origin-only",
		crossOrigin: true,
		expectedReferer: (sourcePort) => `http://localhost:${sourcePort}/`,
	}),
	iframeRefererTest({
		name: "referer-iframe-document-same-origin-uses-full-url",
		mode: "document",
		expectedReferer: (sourcePort) =>
			`http://localhost:${sourcePort}/source/parent.html?token=runway-iframe`,
	}),
	iframeRefererTest({
		name: "referer-iframe-document-cross-origin-uses-origin-only",
		mode: "document",
		crossOrigin: true,
		expectedReferer: (sourcePort) => `http://localhost:${sourcePort}/`,
	}),
	iframeRefererTest({
		name: "referer-iframe-request-same-origin-sends-full-url",
		mode: "request",
		expectedReferer: (sourcePort) =>
			`http://localhost:${sourcePort}/source/parent.html?token=runway-iframe`,
	}),
	iframeRefererTest({
		name: "referer-iframe-request-cross-origin-sends-origin-only",
		mode: "request",
		crossOrigin: true,
		expectedReferer: (sourcePort) => `http://localhost:${sourcePort}/`,
	}),
];
