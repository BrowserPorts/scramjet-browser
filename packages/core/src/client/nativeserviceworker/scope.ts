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
	const virtualScript = new URL(self.location.href).searchParams.get("$script");
	if (virtualScript) {
		Object.defineProperty(client, "url", {
			get: () => new URL(virtualScript),
			configurable: true,
		});
	}
	const virtualOrigin = swrealmscope ? new URL(swrealmscope).origin : null;
	const handled = new WeakSet<FetchEvent>();
	const nativeRespondWith = client.natives.store[
		"FetchEvent.prototype.respondWith"
	] as FetchEvent["respondWith"];

	async function serializeRequest(
		event: FetchEvent,
	): Promise<NativeServiceWorkerRequest> {
		const request = event.request;
		let rawClientUrl: string | undefined;
		const sourceClientId = event.clientId;
		const resultingClientId = event.resultingClientId;
		const id = sourceClientId || resultingClientId;
		if (id) rawClientUrl = (await self.clients.get(id))?.url;

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
		const clients = await self.clients.matchAll({
			type: "window",
			includeUncontrolled: true,
		});
		const target = clients[0];
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
		const result = await response;
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
		const body =
			resolved.status === 101 ||
			resolved.status === 204 ||
			resolved.status === 205 ||
			resolved.status === 304
				? null
				: await resolved.clone().arrayBuffer();

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
