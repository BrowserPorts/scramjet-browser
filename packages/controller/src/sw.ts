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

addEventListener("message", (e) => {
	if (!e.data) return;
	if (typeof e.data != "object") return;
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
		private port: MessagePort,
	) {
		this.rpc = new RpcHelper<SWbound, Controllerbound>(
			{
				sendSetCookie: async () => {
					// cookies sync over each frame's transport port now, so this only keeps tabs that
					// loaded the previous controller from waiting forever once this worker takes over
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

		this.rpc.call("ready", undefined).catch((error) => {
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
		if (typeof detach.id !== "string" || !responsePort) return;

		const existing = tabs.findIndex((tab) => tab.id === detach.id);
		let detached = detachedControllerIds.has(detach.id);
		if (existing !== -1) {
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
	if (
		typeof init.id !== "string" ||
		typeof init.prefix !== "string" ||
		!e.ports[0]
	) {
		return;
	}

	const existing = tabs.findIndex((t) => t.id === init.id);
	if (existing !== -1) {
		const [reference] = tabs.splice(existing, 1);
		reference.close();
	}
	detachedControllerIds.delete(init.id);
	tabs.push(new ControllerReference(init.prefix, init.id, e.ports[0]));
});

export function shouldRoute(event: FetchEvent): boolean {
	const url = new URL(event.request.url);
	const tab = tabs.find((tab) => url.pathname.startsWith(tab.prefix));
	return tab !== undefined;
}

export async function route(event: FetchEvent): Promise<Response> {
	try {
		const url = new URL(event.request.url);
		const tab = tabs.find((tab) => url.pathname.startsWith(tab.prefix))!;
		const client = await clients.get(event.clientId);

		const rawheaders: RawHeaders = [...event.request.headers];

		const response = await tab.rpc.call(
			"request",
			{
				rawUrl: event.request.url,
				rawReferrer: event.request.referrer,
				destination: event.request.destination,
				mode: event.request.mode,
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
			headers: response.headers,
		});
	} catch (e) {
		console.error("Service Worker error:", e);
		return new Response(
			"Internal Service Worker Error: " + (e as Error).message,
			{
				status: 500,
			},
		);
	}
}

addEventListener("install", () => {
	self.skipWaiting();
});

addEventListener("activate", (event: ExtendableEvent) => {
	event.waitUntil(clients.claim());
});

// the only way to know if a service worker has suddenly died is if this code runs again
// notify all clients to send over their messageports again
setTimeout(async () => {
	console.log("service worker activated, notifying clients to revive");
	for (const client of await clients.matchAll()) {
		client.postMessage({
			$controller$swrevive: {},
		});
	}
	// short delay is apparently needed
}, 100);
