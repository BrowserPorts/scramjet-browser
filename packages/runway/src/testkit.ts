/**
 * Test authoring API for the native regression suite.
 *
 * This is the v2 authoring surface. There is no compatibility layer with the
 * pre-v2 `Test` shape: a test declares what it needs (a fixture origin, direct
 * page control, or nothing but the Node process), which lanes it is meaningful in,
 * and its own deadline. The runner derives capabilities and evidence requirements
 * from that declaration rather than guessing.
 *
 * Fixture origins are always allocated by the operating system and read back from
 * the listening socket, so a test never names a port and no port constant appears
 * in a test file.
 */
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { FrameLocator, Page } from "playwright";
import { activeRouteObserver, endpointFromSocket } from "./fixtures/route.ts";

/** Host-side verdict hooks handed to a fixture that decides the result itself. */
export type ResultHooks = {
	readonly pass: (message?: string, details?: unknown) => Promise<void>;
	readonly fail: (message?: string, details?: unknown) => Promise<void>;
};

/**
 * Mapping that lets a fixture answer for a hostname it does not really own.
 *
 * The candidate transport sends `https://<root>/…` to the fixture's real loopback
 * port while keeping the logical host, which is how origin-sensitive behaviour is
 * tested without touching the host's DNS or certificates.
 */
export type HostMapping = {
	readonly hosts: readonly string[];
	readonly site: {
		readonly roots: readonly string[];
		readonly httpPort: number;
	} | null;
};

/** Where the harness should navigate, and the mapping it needs to get there. */
export type FixtureTarget = {
	readonly url: string;
	readonly hostMapping: HostMapping | null;
	/** The port the fixture actually bound, read back from the listening socket. */
	readonly listenPort: number;
};

export type Fixture = {
	/** Starts this instance's origin(s). One fixture instance is created per lane. */
	readonly start: (hooks: ResultHooks) => Promise<void>;
	readonly stop: () => Promise<void>;
	/** Called after `start`, when the real ports are known. */
	readonly target: () => FixtureTarget;
};

export type PageControlContext = {
	readonly page: Page;
	readonly frame: FrameLocator;
	readonly navigate: (url: string) => Promise<void>;
	/** Instrumented origin for this attempt, when the test declared `html`. */
	readonly originUrl: string | null;
	readonly originPort: number | null;
	/** Origin of the harness this lane attached to. */
	readonly harnessOrigin: string;
	readonly laneId: string;
	/** Directory inside the run output this attempt may write artifacts into. */
	readonly artifactDirectory: string;
	readonly browser: {
		readonly engine: string;
		readonly version: string;
		readonly selection: string;
		readonly explicitlySelected: boolean;
	};
	readonly pluginProfileName: string;
};

export type NodeTestContext = {
	readonly assert: (condition: unknown, message?: string) => void;
	readonly assertEqual: (actual: unknown, expected: unknown, message?: string) => void;
};

/** `both` runs the reference and candidate lanes; `candidate` only the candidate. */
export type LaneScope = "both" | "candidate";

export type NativeTest = {
	readonly name: string;
	readonly laneScope: LaneScope;
	readonly deadlineMs?: number;
	/** Exact number of `ok()` calls the page must make for a pass. */
	readonly expectedOkCalls?: number;
	/** Runs the lanes one after another; for fixtures with shared state. */
	readonly serialLanes?: boolean;
	/** Pre-fetches the proxied document before navigating. */
	readonly warmProxiedRoute?: boolean;
	/**
	 * When true, this test requires a host-correlated owner receipt. Builtin
	 * proxy regressions must leave this unset: owner is then not required and
	 * never recorded as verified.
	 */
	readonly requireOwner?: boolean;
	/** When true, the candidate transport may dial non-loopback destinations. */
	readonly remoteNetwork?: boolean;
	/** Host-fixture tests settle in Node; they do not echo a page nonce. */
	readonly verdict?: "page" | "host";
	readonly execution:
		| { readonly kind: "in-page"; readonly createFixture: () => Fixture }
		| {
				readonly kind: "page-control";
				readonly fn: (context: PageControlContext) => Promise<void>;
				readonly createFixture?: () => Fixture;
			}
		| {
				readonly kind: "node";
				readonly fn: (context: NodeTestContext) => Promise<void> | void;
			};
};

export type OriginOptions = {
	/**
	 * Logical hostname the document is served as. A hostname other than
	 * `localhost`/`127.0.0.1` only resolves through the candidate transport, so such
	 * a test is candidate-only.
	 */
	readonly hostname?: string;
	/** Further hostnames the same fixture answers for. */
	readonly extraHosts?: readonly string[];
	readonly scheme?: "http" | "https";
	readonly path?: string;
	/** Keeps the real port in the URL even when a hostname is used. */
	readonly explicitPort?: boolean;
};

export type CommonOptions = OriginOptions & {
	readonly name: string;
	readonly candidateOnly?: boolean;
	readonly expectedOkCalls?: number;
	readonly deadlineMs?: number;
	readonly serialLanes?: boolean;
	readonly warmProxiedRoute?: boolean;
	readonly requireOwner?: boolean;
	readonly remoteNetwork?: boolean;
	readonly verdict?: "page" | "host";
};

function hostRoots(options: OriginOptions): readonly string[] {
	if (!options.hostname) return [];
	return [...new Set([options.hostname, ...(options.extraHosts ?? [])])];
}

/** Builds the navigation target once the fixture's real port is known. */
export function buildTarget(options: OriginOptions, port: number): FixtureTarget {
	const hostname = options.hostname ?? "localhost";
	const scheme =
		options.scheme ??
		(hostname !== "localhost" && hostname !== "127.0.0.1" ? "https" : "http");
	const requestPath = options.path ?? "/";
	const normalized = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
	const roots = hostRoots(options);
	const usesDefaultPort = options.hostname !== undefined && options.explicitPort !== true;
	return {
		url: usesDefaultPort
			? `${scheme}://${hostname}${normalized}`
			: `${scheme}://${hostname}:${port}${normalized}`,
		listenPort: port,
		hostMapping:
			roots.length > 0
				? {
						hosts: [...new Set([...roots, "localhost", "127.0.0.1"])],
						site: { roots, httpPort: port },
					}
				: null,
	};
}

/**
 * A logical hostname or a proxy-internals assertion is only meaningful in the
 * candidate lane; `candidateOnly` states it explicitly when it is not obvious.
 */
function laneScopeFor(options: CommonOptions, source: string): LaneScope {
	if (options.candidateOnly !== undefined) {
		return options.candidateOnly ? "candidate" : "both";
	}
	if (options.hostname !== undefined) return "candidate";
	// `checkglobal` inspects the proxy's own realm isolation, which the reference
	// lane has nothing to compare against.
	return /checkglobal\s*\(/i.test(source) ? "candidate" : "both";
}

function common(options: CommonOptions, source: string): Omit<NativeTest, "execution"> {
	return {
		name: options.name,
		laneScope: laneScopeFor(options, source),
		...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
		...(options.expectedOkCalls === undefined
			? {}
			: { expectedOkCalls: options.expectedOkCalls }),
		...(options.serialLanes === undefined ? {} : { serialLanes: options.serialLanes }),
		...(options.warmProxiedRoute === undefined
			? {}
			: { warmProxiedRoute: options.warmProxiedRoute }),
		...(options.requireOwner === undefined ? {} : { requireOwner: options.requireOwner }),
		...(options.remoteNetwork === undefined ? {} : { remoteNetwork: options.remoteNetwork }),
		...(options.verdict === undefined ? {} : { verdict: options.verdict }),
	};
}

/**
 * Binds a fixture origin on loopback and counts the HTTP requests it handles.
 *
 * The count is host-side evidence for route qualification. Guest headers are not
 * consulted.
 */
export async function listen(server: http.Server): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as AddressInfo).port;
			server.on("request", (req) => {
				const observer = activeRouteObserver();
				if (!observer) return;
				const remote = endpointFromSocket(req.socket, "remote");
				const local = endpointFromSocket(req.socket, "local");
				if (!remote || !local) return;
				observer.http({
					method: req.method ?? "GET",
					url: req.url ?? "/",
					remote,
					local,
				});
			});
			resolve(port);
		});
	});
}

function websocketUpgradeOptions(): http.ServerOptions {
	const options: http.ServerOptions = {};
	if ("shouldUpgradeCallback" in http.Server.prototype) {
		(
			options as http.ServerOptions & {
				shouldUpgradeCallback: (req: http.IncomingMessage) => boolean;
			}
		).shouldUpgradeCallback = (req: http.IncomingMessage) =>
			req.headers.upgrade?.toLowerCase() === "websocket";
	}
	return options;
}

async function shutdown(server: http.Server, sockets?: Set<Socket>): Promise<void> {
	server.closeAllConnections?.();
	for (const socket of sockets ?? []) socket.destroy();
	sockets?.clear();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Serves a page that loads `js` through the in-page harness helpers. */
export function scriptTest(
	options: CommonOptions & { readonly js: string; readonly autoPass?: boolean }
): NativeTest {
	return {
		...common(options, options.js),
		execution: {
			kind: "in-page",
			createFixture: () => {
				let server: http.Server | null = null;
				let port = 0;
				return {
					start: async () => {
						server = http.createServer((req, res) => {
							if (req.url === "/") {
								res.writeHead(200, { "Content-Type": "text/html" });
								res.end(
									`<!DOCTYPE html><html><head></head><body><h1>Test - ${options.name}</h1>` +
										`<script src="/script.js"></script></body></html>`
								);
								return;
							}
							if (req.url === "/script.js") {
								res.writeHead(200, { "Content-Type": "application/javascript" });
								res.end(
									`runTest(async () => {\n${options.js}\n}, ${options.autoPass ?? true});`
								);
								return;
							}
							res.writeHead(404);
							res.end("Not found");
						});
						port = await listen(server);
					},
					stop: async () => {
						if (server) await shutdown(server);
						server = null;
					},
					target: () => buildTarget(options, port),
				};
			},
		},
	};
}

/** Serves `html` verbatim as the document under test. */
export function documentTest(options: CommonOptions & { readonly html: string }): NativeTest {
	return {
		...common(options, options.html),
		execution: {
			kind: "in-page",
			createFixture: () => {
				let server: http.Server | null = null;
				let port = 0;
				return {
					start: async () => {
						server = http.createServer((req, res) => {
							if (req.url === "/") {
								res.writeHead(200, { "Content-Type": "text/html" });
								res.end(options.html);
								return;
							}
							res.writeHead(404);
							res.end("Not found");
						});
						port = await listen(server);
					},
					stop: async () => {
						if (server) await shutdown(server);
						server = null;
					},
					target: () => buildTarget(options, port),
				};
			},
		},
	};
}

/**
 * Gives the test its own origin.
 *
 * `start` receives the server before it accepts requests, so extra routes,
 * upgrades and header behaviour can be installed, plus the verdict hooks for
 * fixtures that decide the result host-side.
 */
export function originTest(
	options: CommonOptions & {
		readonly start: (
			server: http.Server,
			port: number,
			hooks: ResultHooks
		) => Promise<void> | void;
		readonly js?: string;
		readonly autoPass?: boolean;
	}
): NativeTest {
	return {
		...common(options, options.js ?? ""),
		execution: {
			kind: "in-page",
			createFixture: () => {
				let server: http.Server | null = null;
				let port = 0;
				const sockets = new Set<Socket>();
				return {
					start: async (hooks) => {
						server = http.createServer(websocketUpgradeOptions(), (req, res) => {
							if (!options.js) return;
							if (req.url === "/") {
								res.writeHead(200, { "Content-Type": "text/html" });
								res.end(
									`<!DOCTYPE html><html><head></head><body><h1>Test - ${options.name}</h1>` +
										`<script src="/script.js"></script></body></html>`
								);
								return;
							}
							if (req.url === "/script.js") {
								res.writeHead(200, { "Content-Type": "application/javascript" });
								res.end(
									`runTest(async () => {\n${options.js}\n}, ${options.autoPass ?? false});`
								);
							}
						});
						server.on("connection", (socket) => {
							sockets.add(socket);
							socket.on("close", () => sockets.delete(socket));
						});
						port = await listen(server);
						await options.start(server, port, hooks);
					},
					stop: async () => {
						if (server) await shutdown(server, sockets);
						server = null;
					},
					target: () => buildTarget(options, port),
				};
			},
		},
	};
}

/**
 * A test that brings its own origins.
 *
 * `start` returns the port the harness should navigate to, which keeps port
 * allocation with the code that owns the listener.
 */
export function fixtureTest(
	options: CommonOptions & {
		/**
		 * Called once per lane so each attempt gets its own origin, hooks and
		 * `settled` flag. Closing over a single flag across lanes is how a
		 * candidate used to copy the reference verdict.
		 */
		readonly create: () => {
			readonly start: (hooks: ResultHooks) => Promise<number>;
			readonly stop: () => Promise<void>;
		};
	}
): NativeTest {
	return {
		...common(options, ""),
		execution: {
			kind: "in-page",
			createFixture: () => {
				const instance = options.create();
				let port = 0;
				return {
					start: async (hooks) => {
						port = await instance.start(hooks);
					},
					stop: instance.stop,
					target: () => buildTarget(options, port),
				};
			},
		},
	};
}

/** A test that drives the browser itself through Playwright. */
export function pageTest(options: {
	readonly name: string;
	readonly fn: (context: PageControlContext) => Promise<void>;
	readonly deadlineMs?: number;
	readonly candidateOnly?: boolean;
	readonly remoteNetwork?: boolean;
	readonly requireOwner?: boolean;
	/** Served as `/` on an instrumented loopback origin the executor starts per lane. */
	readonly html?: string;
}): NativeTest {
	return {
		name: options.name,
		laneScope: options.candidateOnly === false ? "both" : "candidate",
		...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
		...(options.remoteNetwork === undefined ? {} : { remoteNetwork: options.remoteNetwork }),
		...(options.requireOwner === undefined ? {} : { requireOwner: options.requireOwner }),
		execution: {
			kind: "page-control",
			fn: options.fn,
			...(options.html
				? {
						createFixture: () => {
							let server: http.Server | null = null;
							let port = 0;
							const html = options.html!;
							return {
								start: async () => {
									server = http.createServer((req, res) => {
										if (req.url === "/") {
											res.writeHead(200, { "Content-Type": "text/html" });
											res.end(html);
											return;
										}
										res.writeHead(404);
										res.end("Not found");
									});
									port = await listen(server);
								},
								stop: async () => {
									if (server) await shutdown(server);
									server = null;
								},
								target: () => buildTarget({}, port),
							};
						},
					}
				: {}),
		},
	};
}

/** A test that runs in the Node process with no browser at all. */
export function nodeTest(options: {
	readonly name: string;
	readonly fn: (context: NodeTestContext) => Promise<void> | void;
	readonly deadlineMs?: number;
}): NativeTest {
	return {
		name: options.name,
		laneScope: "candidate",
		...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
		execution: {
			kind: "node",
			fn: (context) => options.fn(context),
		},
	};
}

export type FrameNode = {
	readonly js: (context: { readonly url: string }) => string;
	readonly id?: string;
	readonly originId?: string;
	readonly subframes?: readonly FrameNode[];
};

/**
 * A tree of documents across several origins.
 *
 * Every origin is a separate loopback listener with an allocated port, and the
 * frame markup is generated per request, so the tree is built from the ports the
 * fixtures actually bound.
 */
export function frameTreeTest(options: {
	readonly name: string;
	readonly root: FrameNode;
	readonly expectedOkCalls?: number;
	readonly deadlineMs?: number;
}): NativeTest {
	type Origin = {
		server: http.Server;
		port: number;
		js: Record<string, string>;
		subframes: Record<string, string[]>;
	};

	const rootId = options.root.id ?? "main";
	const rootOriginId = options.root.originId ?? "main";

	return {
		name: options.name,
		laneScope: "both",
		...(options.expectedOkCalls === undefined
			? {}
			: { expectedOkCalls: options.expectedOkCalls }),
		...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
		execution: {
			kind: "in-page",
			createFixture: () => {
				const origins = new Map<string, Origin>();
				const originFor = (originId: string): Origin => {
					const existing = origins.get(originId);
					if (existing) return existing;
					const entry: Origin = {
						server: undefined as unknown as http.Server,
						port: 0,
						js: {},
						subframes: {},
					};
					entry.server = http.createServer((req, res) => {
						const requestUrl = req.url ?? "/";
						if (requestUrl === "/") {
							res.writeHead(302, { Location: `http://localhost:${entry.port}/${rootId}` });
							res.end();
							return;
						}
						const leaf = requestUrl.split("/").pop() ?? "";
						if (leaf.endsWith(".js")) {
							const id = leaf.slice(0, -3);
							const body = entry.js[id];
							if (body === undefined) {
								res.writeHead(404);
								res.end("Not found");
								return;
							}
							res.writeHead(200, { "Content-Type": "application/javascript" });
							res.end(body);
							return;
						}
						const children = entry.subframes[leaf] ?? [];
						const frames = children.map((child) => {
							const host = [...origins.values()].find((candidate) => candidate.js[child]);
							return host
								? `<iframe src="http://localhost:${host.port}/${child}"></iframe>`
								: "";
						});
						res.writeHead(200, { "Content-Type": "text/html" });
						res.end(
							`<!DOCTYPE html><html><head></head><body><h1>Frame ${originId}/${leaf}</h1>` +
								`${frames.join("<br>")}<script src="/${leaf}.js"></script></body></html>`
						);
					});
					origins.set(originId, entry);
					return entry;
				};
				const walk = (node: FrameNode, inheritedOrigin: string): void => {
					const id = node.id ?? "main";
					const originId = node.originId ?? inheritedOrigin;
					const origin = originFor(originId);
					origin.js[id] = node.js({ url: `pending://${originId}/${id}` });
					origin.subframes[id] = (node.subframes ?? []).map((child) => child.id ?? "main");
					for (const child of node.subframes ?? []) walk(child, originId);
				};
				return {
					start: async () => {
						walk(options.root, rootOriginId);
						for (const origin of origins.values()) {
							origin.port = await listen(origin.server);
						}
						const rebuild = (node: FrameNode, inheritedOrigin: string): void => {
							const id = node.id ?? "main";
							const originId = node.originId ?? inheritedOrigin;
							const origin = origins.get(originId)!;
							origin.js[id] = node.js({
								url: `http://localhost:${origin.port}/${id}`,
							});
							for (const child of node.subframes ?? []) rebuild(child, originId);
						};
						rebuild(options.root, rootOriginId);
					},
					stop: async () => {
						for (const origin of origins.values()) await shutdown(origin.server);
					},
					target: () => ({
						url: `http://localhost:${origins.get(rootOriginId)!.port}/`,
						listenPort: origins.get(rootOriginId)!.port,
						hostMapping: null,
					}),
				};
			},
		},
	};
}
