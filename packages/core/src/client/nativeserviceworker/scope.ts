import { swrealmscope } from "@client/entry";
import type { ScramjetClient } from "@client/index";
import type {
	NativeServiceWorkerGatewayMetadata,
	NativeServiceWorkerRequest,
} from "@/shared";

const INTERNAL_MESSAGE = "$scramjet$nativeServiceWorker";
const FINALIZE = "$scramjet$finalizeNativeServiceWorker";

export const order = 10;

export default function (
	client: ScramjetClient,
	self: ServiceWorkerGlobalScope,
) {
	const virtualOrigin = swrealmscope ? new URL(swrealmscope).origin : null;
	const handled = new WeakSet<FetchEvent>();
	const nativeRespondWith = client.natives.store[
		"FetchEvent.prototype.respondWith"
	] as FetchEvent["respondWith"];
	const nativeMatchAll = client.natives.store["Clients.prototype.matchAll"] as Clients["matchAll"];
	const nativeGet = client.natives.store["Clients.prototype.get"] as Clients["get"];
	const rawClientUrl = (target: Client) => client.descriptors.get("Client.prototype.url", target) as string;
	const belongsToOrigin = (target: Client) => {
		const raw = rawClientUrl(target);
		if (!raw.startsWith(client.context.prefix.href)) return false;
		return new URL(client.unrewriteUrl(raw)).origin === virtualOrigin;
	};
	client.Proxy("Clients.prototype.matchAll", {
		apply(ctx) {
			ctx.return(nativeMatchAll.apply(ctx.this, ctx.args).then((items) => items.filter(belongsToOrigin)));
		},
	});
	client.Proxy("Clients.prototype.get", {
		apply(ctx) {
			ctx.return(nativeGet.apply(ctx.this, ctx.args).then((target) => target && belongsToOrigin(target) ? target : undefined));
		},
	});

	async function serializeRequest(
		event: FetchEvent,
	): Promise<NativeServiceWorkerRequest> {
		const request = event.request;
		let rawClientUrl: string | undefined;
		const sourceClientId = event.clientId;
		const resultingClientId = event.resultingClientId;
		const id = sourceClientId || resultingClientId;
		if (id) {
			const target = await nativeGet.call(self.clients, id);
			if (target) rawClientUrl = client.descriptors.get("Client.prototype.url", target) as string;
		}

		let body: ArrayBuffer | null = null;
		if (request.method !== "GET" && request.method !== "HEAD") {
			body = await request.clone().arrayBuffer();
		}

		const rawUrl = client.descriptors.get(
			"Request.prototype.url",
			request,
		) as string;
		const rawReferrer = client.descriptors.get(
			"Request.prototype.referrer",
			request,
		) as string;

		return {
			rawUrl,
			rawReferrer: rawReferrer || null,
			destination: request.destination,
			mode: request.mode,
			credentials: request.credentials,
			referrer: rawReferrer,
			method: request.method,
			cache: request.cache,
			initialHeaders: [...request.headers],
			body,
			rawClientUrl,
			clientId: id || undefined,
			sourceClientId: sourceClientId || undefined,
			resultingClientId: resultingClientId || undefined,
		};
	}

	async function callPage(
		metadata: NativeServiceWorkerGatewayMetadata,
	): Promise<Response> {
		const channel = new MessageChannel();
		const clients = await nativeMatchAll.call(self.clients, {
			type: "window",
			includeUncontrolled: true,
		});
		const target = clients.find(belongsToOrigin);
		if (!target)
			throw new TypeError(
				"No Scramjet client is available for this service worker",
			);

		const response = new Promise<any>((resolve, reject) => {
			const timer = setTimeout(
				() =>
					reject(new TypeError("Scramjet service worker request timed out")),
				30_000,
			);
			channel.port1.onmessage = (event) => {
				clearTimeout(timer);
				if (event.data?.error) reject(new TypeError(event.data.error));
				else resolve(event.data);
			};
			channel.port1.start();
		});

		target.postMessage({ [INTERNAL_MESSAGE]: metadata }, [channel.port2]);
		const result = await response.finally(() => channel.port1.close());
		return new Response(result.body, {
			status: result.status,
			statusText: result.statusText,
			headers: result.headers,
		});
	}

	async function routeRequest(event: FetchEvent): Promise<Response> {
		return callPage({
			kind: "request",
			request: await serializeRequest(event),
		});
	}

	client.Proxy("fetch", {
		apply(ctx) {
			const input = ctx.args[0];
			const init = ctx.args[1] as RequestInit | undefined;
			const request = client.natives.construct(
				"Request",
				client.box.instanceof(input, "Request")
					? input
					: client.rewriteUrl(String(input), {
							mode: init?.mode ?? "cors",
							credentials: init?.credentials,
						}),
				init,
			) as Request;
			const syntheticEvent = {
				request,
				clientId: "",
				resultingClientId: "",
			} as FetchEvent;
			ctx.return(routeRequest(syntheticEvent));
		},
	});

	async function routeResponse(
		event: FetchEvent,
		response: Response | PromiseLike<Response>,
	): Promise<Response> {
		const resolved = await response;
		if (!(resolved instanceof Response)) {
			throw new TypeError(
				"Failed to execute 'respondWith': value is not a Response",
			);
		}
		if (resolved.bodyUsed || resolved.body?.locked) {
			throw new TypeError("The response body is already used or locked");
		}
		if (resolved.type === "error") return Response.error();
		const body =
			resolved.status === 101 ||
			resolved.status === 204 ||
			resolved.status === 205 ||
			resolved.status === 304
				? null
				: await resolved.arrayBuffer();

		return callPage({
			kind: "response",
			request: await serializeRequest(event),
			response: {
				status: resolved.status,
				statusText: resolved.statusText,
				headers: [...resolved.headers],
				body,
			},
		});
	}

	client.Proxy("FetchEvent.prototype.respondWith", {
		apply(ctx) {
			const event = ctx.this as FetchEvent;
			handled.add(event);
			ctx.return(
				nativeRespondWith.call(event, routeResponse(event, ctx.args[0])),
			);
		},
	});

	Object.defineProperty(self, FINALIZE, {
		value() {
			self.addEventListener("fetch", (event) => {
				if (handled.has(event)) return;
				handled.add(event);
				nativeRespondWith.call(event, routeRequest(event));
			});
		},
		configurable: true,
	});

	client.Trap("ServiceWorkerRegistration.prototype.scope", {
		get(ctx) {
			if (ctx.this === self.registration && swrealmscope) return swrealmscope;
			return client.unrewriteUrl(ctx.get() as string);
		},
	});
	client.Trap("ServiceWorker.prototype.scriptURL", {
		get(ctx) {
			const raw = ctx.get() as string;
			return new URL(raw).searchParams.get("$script") ?? raw;
		},
	});
	client.Trap("Client.prototype.url", {
		get(ctx) {
			return client.unrewriteUrl(ctx.get() as string);
		},
	});
	client.Trap("ExtendableMessageEvent.prototype.origin", {
		get(ctx) {
			return virtualOrigin ?? ctx.get();
		},
	});
}
