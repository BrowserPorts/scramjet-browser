/// <reference lib="WebWorker" />
/// <reference types="@types/serviceworker" />

import type { RawHeaders } from "@mercuryworkshop/proxy-transports";
import { RpcHelper } from "@mercuryworkshop/rpc";
import type {
	Controllerbound,
	ControllerDetachRequest,
	ControllerDetachResponse,
	SWbound,
} from "./types.js";

function makeId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

function messageClientId(event: {
	source: ExtendableMessageEvent["source"];
}): string | null {
	const source = event.source;
	if (!source || typeof source !== "object" || !("id" in source)) return null;
	return typeof source.id === "string" ? source.id : null;
}

const cookieResolvers: Record<string, () => undefined> = {};
const workerId = makeId();
const REVIVAL_CLAIM_TIMEOUT_MS = 1000;
const controllerClaimResolvers = new Map<
	string,
	Set<(controller: ControllerReference) => undefined>
>();
let activeRevival:
	| {
			expiresAt: number;
			promise: Promise<undefined>;
	  }
	| undefined;

function controllerPrefixFromPath(pathname: string): string | null {
	const match =
		/\/([0-9a-f]{32})\/[0-9a-f]{32}\/https?(?:%3A%2F%2F|%253A%252F%252F)/.exec(
			pathname,
		);
	if (!match || match.index === undefined || !match[1]) return null;
	return pathname.slice(0, match.index + match[1].length + 2);
}

function currentController(prefix: string): ControllerReference | undefined {
	return tabs.find((tab) => prefix === tab.prefix && !tab.isClosed());
}

function requestControllerRevival(): Promise<undefined> {
	if (activeRevival && activeRevival.expiresAt > Date.now()) {
		return activeRevival.promise;
	}

	const revivalId = makeId();
	const expiresAt = Date.now() + REVIVAL_CLAIM_TIMEOUT_MS;
	const promise = (async () => {
		const liveClients = await clients.matchAll({
			includeUncontrolled: true,
			type: "window",
		});
		for (const client of liveClients) {
			client.postMessage({
				$controller$swrevive: { workerId, revivalId },
			});
		}
		await new Promise<undefined>((resolve) => {
			setTimeout(() => resolve(undefined), REVIVAL_CLAIM_TIMEOUT_MS);
		});
		return undefined;
	})();
	activeRevival = { expiresAt, promise };
	promise.then(
		() => {
			if (activeRevival?.promise === promise) activeRevival = undefined;
			return undefined;
		},
		() => {
			if (activeRevival?.promise === promise) activeRevival = undefined;
			return undefined;
		},
	);
	return promise;
}

async function waitForController(
	prefix: string,
): Promise<ControllerReference | undefined> {
	const existing = currentController(prefix);
	if (existing) return existing;

	let resolveClaim:
		| ((controller: ControllerReference) => undefined)
		| undefined;
	const claimed = new Promise<ControllerReference>((resolve) => {
		resolveClaim = (controller) => {
			resolve(controller);
			return undefined;
		};
		const resolvers = controllerClaimResolvers.get(prefix) ?? new Set();
		resolvers.add(resolveClaim);
		controllerClaimResolvers.set(prefix, resolvers);
	});
	try {
		await Promise.race([claimed, requestControllerRevival()]);
		return currentController(prefix);
	} finally {
		if (resolveClaim) {
			const resolvers = controllerClaimResolvers.get(prefix);
			resolvers?.delete(resolveClaim);
			if (resolvers?.size === 0) controllerClaimResolvers.delete(prefix);
		}
	}
}

// A service worker can be terminated and restarted without another activation.
// Begin a bounded ownership handshake whenever this worker global is created.
requestControllerRevival().catch((error) => {
	console.error("Controller revival request failed:", error);
});
addEventListener("message", (e) => {
	if (!e.data) return;
	if (typeof e.data != "object") return;
	if (e.data.$sw$setCookieDone && typeof e.data.$sw$setCookieDone == "object") {
		const done = e.data.$sw$setCookieDone;

		const resolver = cookieResolvers[done.id];
		if (resolver) {
			resolver();
			delete cookieResolvers[done.id];
		}
	}

	if (
		e.data.$sw$initRemoteTransport &&
		typeof e.data.$sw$initRemoteTransport == "object"
	) {
		const { port, prefix } = e.data.$sw$initRemoteTransport;

		const relevantcontroller = tabs.find((tab) =>
			new URL(prefix).pathname.startsWith(tab.prefix),
		);
		if (!relevantcontroller) {
			console.error("No relevant controller found for transport init");
			return;
		}
		relevantcontroller.rpc
			.call("initRemoteTransport", { port, prefix }, [port])
			.catch((error) => {
				if (!relevantcontroller.isClosed()) {
					console.error("Remote transport initialization failed:", error);
				}
			});
	}
});

class ControllerReference {
	rpc: RpcHelper<SWbound, Controllerbound>;
	private closed = false;

	constructor(
		public prefix: string,
		public id: string,
		public ownerClientId: string,
		private connectionId: string | undefined,
		private port: MessagePort,
	) {
		this.rpc = new RpcHelper(
			{
				sendSetCookie: async ({ cookies, options }) => {
					const clients = (await self.clients.matchAll()).filter((client) =>
						new URL(client.url).pathname.startsWith(this.prefix),
					);
					const ids: string[] = [];
					const promises: Promise<string>[] = [];
					let timeoutId: ReturnType<typeof setTimeout> | undefined;
					try {
						for (const client of clients) {
							const id = makeId();
							ids.push(id);
							promises.push(
								new Promise<string>((resolve) => {
									cookieResolvers[id] = () => {
										resolve(id);
										return undefined;
									};
								}),
							);
							client.postMessage({
								$controller$setCookie: {
									cookies,
									options,
									id,
								},
							});
						}

						if (promises.length > 0) {
							const timeoutPromise = new Promise<undefined>((resolve) => {
								timeoutId = setTimeout(() => {
									const pending = ids.filter(
										(id) => cookieResolvers[id] !== undefined,
									);
									// A frame can navigate away during delivery. The controller's
									// cookie jar is already updated; a missed frame acknowledgement
									// must not turn a successful upstream response into a failure.
									console.warn(
										`Cookie sync acknowledgement expired for ${pending.length} frame(s)`,
									);
									resolve(undefined);
								}, 1000);
							});

							await Promise.race([Promise.all(promises), timeoutPromise]);
						}
					} finally {
						if (timeoutId !== undefined) clearTimeout(timeoutId);
						for (const id of ids) {
							delete cookieResolvers[id];
						}
					}
				},
			},
			"tabchannel-" + id,
			(data, transfer) => {
				port.postMessage(data, transfer);
			},
		);
		port.onmessage = (e: MessageEvent) => {
			this.rpc.recieve(e.data);
		};
		port.onmessageerror = console.error;

		this.rpc
			.call("ready", { workerId, connectionId: this.connectionId })
			.catch((error) => {
				if (!this.closed) {
					console.error("Controller ready acknowledgement failed:", error);
				}
			});
	}

	isClosed(): boolean {
		return this.closed;
	}

	close(): undefined {
		if (this.closed) return undefined;
		this.closed = true;

		const error = new Error("Scramjet Controller reference closed");
		for (const callback of this.rpc.promiseCallbacks.values()) {
			callback.reject(error);
		}
		this.rpc.promiseCallbacks.clear();
		this.port.onmessage = null;
		this.port.onmessageerror = null;
		try {
			this.port.close();
		} catch {
			// the channel was already closed
		}

		return undefined;
	}
}

const tabs: ControllerReference[] = [];
const detachedControllerIds = new Set<string>();

addEventListener("message", (e) => {
	if (!e.data) return;
	if (typeof e.data != "object") return;
	if (
		e.data.$controller$detach &&
		typeof e.data.$controller$detach == "object"
	) {
		const detach = e.data
			.$controller$detach as Partial<ControllerDetachRequest>;
		const responsePort = e.ports[0];
		const ownerClientId = messageClientId(e);
		if (typeof detach.id !== "string" || !responsePort || !ownerClientId)
			return;

		const existing = tabs.findIndex((tab) => tab.id === detach.id);
		let detached = detachedControllerIds.has(detach.id);
		if (existing !== -1 && tabs[existing]?.ownerClientId === ownerClientId) {
			const [reference] = tabs.splice(existing, 1);
			reference.close();
			detachedControllerIds.add(detach.id);
			detached = true;
		}

		const response: ControllerDetachResponse = {
			id: detach.id,
			detached,
		};
		responsePort.postMessage({ $controller$detached: response });
		responsePort.close();
		return;
	}
	if (!e.data.$controller$init) return;
	if (typeof e.data.$controller$init != "object") return;
	const init = e.data.$controller$init;
	const ownerClientId = messageClientId(e);
	if (
		typeof init.id !== "string" ||
		!/^[0-9a-f]{32}$/.test(init.id) ||
		typeof init.prefix !== "string" ||
		(init.workerId !== undefined && init.workerId !== workerId) ||
		!ownerClientId ||
		!e.ports[0]
	) {
		return;
	}
	let prefix: string;
	try {
		const url = new URL(init.prefix, location.origin);
		if (
			url.origin !== location.origin ||
			!url.pathname.endsWith(`/${init.id}/`)
		) {
			return;
		}
		prefix = url.pathname;
	} catch {
		return;
	}

	const existing = tabs.findIndex((t) => t.id === init.id);
	if (existing !== -1) {
		if (tabs[existing]?.ownerClientId !== ownerClientId) {
			e.ports[0].close();
			return;
		}
		const [reference] = tabs.splice(existing, 1);
		reference.close();
	}
	detachedControllerIds.delete(init.id);
	const reference = new ControllerReference(
		prefix,
		init.id,
		ownerClientId,
		typeof init.connectionId === "string" ? init.connectionId : undefined,
		e.ports[0],
	);
	tabs.push(reference);
	for (const resolveClaim of controllerClaimResolvers.get(prefix) ?? []) {
		resolveClaim(reference);
	}
});

/*
 * `Clear-Site-Data` is excluded when a guest response is handed to the browser.
 *
 * An ordinary response already loses it upstream, in core's `SEC_HEADERS` strip
 * (`core/src/fetch/headers.ts`). But a reply can arrive here without having gone
 * through that strip: the emulated service worker intercept branch, a response
 * hook replacement, and the error hook's `setResponse` replacement each hand back
 * headers of their own. This is the one boundary every guest reply shares, so the
 * invariant is enforced here and holds no matter which header backend produced
 * the reply.
 *
 * This is delivery-only, and deliberately not a policy: the serialized reply's
 * own metadata is left as it was, and nothing here decides who may clear a
 * guest's storage.
 *
 * The limit is worth stating plainly. This governs only the headers Scramjet
 * itself hands to the browser on a synthetic response. It cannot undo a
 * `Clear-Site-Data` delivered as a real physical HTTP header -- by then the
 * browser may already have processed an eligible header, and nothing here can
 * reach that.
 */
const DELIVERY_EXCLUDED_HEADERS = new Set(["clear-site-data"]);

function deliverableHeaders(headers: RawHeaders): RawHeaders {
	// a new array: the reply's own headers keep their contents
	return headers.filter(
		([name]) => !DELIVERY_EXCLUDED_HEADERS.has(name.toLowerCase()),
	);
}

export function shouldRoute(event: FetchEvent): boolean {
	const url = new URL(event.request.url);
	if (url.origin !== location.origin) return false;
	if (tabs.some((tab) => url.pathname.startsWith(tab.prefix))) return true;
	return Boolean(
		(event.clientId || event.resultingClientId) &&
			controllerPrefixFromPath(url.pathname),
	);
}

export async function route(event: FetchEvent): Promise<Response> {
	try {
		const url = new URL(event.request.url);
		let tab = tabs.find((candidate) =>
			url.pathname.startsWith(candidate.prefix),
		);
		if (!tab) {
			const prefix = controllerPrefixFromPath(url.pathname);
			if (!prefix || (!event.clientId && !event.resultingClientId)) {
				return new Response(
					"Scramjet Controller ownership was not established",
					{
						status: 503,
					},
				);
			}
			tab = await waitForController(prefix);
			if (!tab) {
				return new Response("Scramjet Controller revival expired", {
					status: 503,
				});
			}
		}
		const client = await clients.get(event.clientId);

		const rawheaders: RawHeaders = [...event.request.headers];

		const response = await tab.rpc.call(
			"request",
			{
				rawUrl: event.request.url,
				rawReferrer: event.request.referrer,
				destination: event.request.destination,
				mode: event.request.mode,
				credentials: event.request.credentials,
				referrer: event.request.referrer,
				method: event.request.method,
				body: event.request.body,
				cache: event.request.cache,
				forceCrossOriginIsolated: false,
				initialHeaders: rawheaders,
				rawClientUrl: client ? client.url : undefined,
				clientId: event.resultingClientId || event.clientId,
				sourceClientId: event.clientId,
				resultingClientId: event.resultingClientId,
			},
			event.request.body instanceof ReadableStream ||
				// @ts-expect-error the types for fetchevent are messed up
				event.request.body instanceof ArrayBuffer
				? [event.request.body]
				: undefined,
		);

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: deliverableHeaders(response.headers),
		});
	} catch (e) {
		console.error("Service Worker error:", e);
		/*
		 * Reaching here means the handler produced NO response, which is a network
		 * error -- not an HTTP result.
		 *
		 * Answering with a synthetic 500 made the guest's `fetch()` RESOLVE with a
		 * proxy error page, so a load that must fail looked like a successful one:
		 * `fetch("data:;base64,a")` has to reject with `TypeError`, and instead the
		 * page saw `status: 500`.
		 *
		 * This does not reclassify HTTP failures. A remote 4xx/5xx never arrives
		 * here: `doNetworkFetch` returns it as an ordinary response, so only a load
		 * that threw -- i.e. produced nothing -- is caught. The discriminant is the
		 * existing structural one, threw vs returned.
		 *
		 * `Response.error()` is the platform's own way to say this from a fetch
		 * handler: it "will cause the fetch() call in the main app code to reject
		 * the promise" (MDN, Response.error()).
		 */
		if (event.request.mode === "navigate") {
			// A navigation has no promise to reject, and the browser would replace
			// the failure with its own generic error page. The readable diagnostic
			// is kept here, where a human is the one reading it.
			return new Response(
				"Internal Service Worker Error: " + (e as Error).message,
				{
					status: 500,
				},
			);
		}
		return Response.error();
	}
}

addEventListener("install", () => {
	self.skipWaiting();
});

addEventListener("activate", (event: ExtendableEvent) => {
	event.waitUntil(
		(async () => {
			await clients.claim();
			await requestControllerRevival();
		})(),
	);
});
