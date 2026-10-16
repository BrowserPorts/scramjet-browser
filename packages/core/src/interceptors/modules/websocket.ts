import type { BareCompatibleWebSocket } from "@mercuryworkshop/proxy-transports";
import { Object_setPrototypeOf, Reflect_get } from "@/shared/snapshot";
import type { InterceptorClient } from "../client";
import { NativeURL, NativeWeakMap } from "../natives";

export const order = 0;

type FakeWebSocketState = {
	url: string;
	binaryType: BinaryType;
	barews: BareCompatibleWebSocket | null;
	readyState: number;
	closing: [number, string] | null;
	onopen: ((ev: Event) => any) | null;
	onmessage: ((ev: MessageEvent) => any) | null;
	onclose: ((ev: CloseEvent) => any) | null;
	onerror: ((ev: Event) => any) | null;
};

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

// Adapted from the Scramjet client's WebSocket hook, which already runs sockets over the transport
export default function (client: InterceptorClient, self: typeof globalThis) {
	if (!self.WebSocket) return;
	const sockets = new NativeWeakMap<WebSocket, FakeWebSocketState>();

	client.Proxy("WebSocket", {
		construct(ctx) {
			let url = client.resolve(String(ctx.args[0]));
			if (url?.protocol === "http:" || url?.protocol === "https:")
				url = new NativeURL(`ws${url.href.slice(4)}`);
			if (!url || client.route(url) === "native") {
				if (url) ctx.args[0] = url.href;
				return;
			}
			const fake = new EventTarget() as WebSocket;
			Object_setPrototypeOf(fake, ctx.fn.prototype);
			const state: FakeWebSocketState = {
				url: url.href,
				binaryType: "blob",
				barews: null,
				readyState: CONNECTING,
				closing: null,
				onopen: null,
				onmessage: null,
				onclose: null,
				onerror: null,
			};
			sockets.set(fake, state);
			const trusted = (event: Event) =>
				new Proxy(event, {
					get(target, prop) {
						if (prop === "isTrusted") return true;
						return Reflect_get(target, prop);
					},
				});
			const send = (event: Event) => {
				state[`on${event.type}` as "onopen"]?.call(fake, trusted(event));
				fake.dispatchEvent(event);
			};
			const fail = () => {
				state.readyState = CLOSED;
				send(new Event("error"));
				send(new CloseEvent("close", { code: 1006, wasClean: false }));
			};
			if (client.route(url) === "blocked") {
				queueMicrotask(fail);
				ctx.return(fake);
				return;
			}
			const barews = client.bare.createWebSocket(
				url.href,
				ctx.args[1] as string | string[] | undefined,
				[
					["User-Agent", self.navigator.userAgent],
					["Origin", client.origin],
				]
			);
			state.barews = barews;
			barews.addEventListener("open", () => {
				// A socket closed while connecting never reports that it opened
				if (state.closing) {
					barews.close(...state.closing);
					return;
				}
				state.readyState = OPEN;
				send(new Event("open"));
			});
			barews.addEventListener("close", (event) => {
				state.readyState = CLOSED;
				send(new CloseEvent("close", event as CloseEvent));
			});
			barews.addEventListener("message", async (event) => {
				let payload = (event as MessageEvent).data;
				if (typeof payload === "string") {
					// Text frames arrive as they are
				} else if ("byteLength" in payload) {
					if (state.binaryType === "blob") payload = new Blob([payload]);
					else Object_setPrototypeOf(payload, ArrayBuffer.prototype);
				} else if (
					"arrayBuffer" in payload &&
					state.binaryType === "arraybuffer"
				) {
					payload = await payload.arrayBuffer();
				}
				send(
					new MessageEvent("message", { data: payload, origin: url.origin })
				);
			});
			barews.addEventListener("error", () => {
				if (state.readyState === CLOSED) return;
				state.readyState = CLOSED;
				send(new Event("error"));
			});
			ctx.return(fake);
		},
	});

	const property = <K extends keyof FakeWebSocketState>(
		name: string,
		key: K,
		writable = false
	) =>
		client.Trap(`WebSocket.prototype.${name}`, {
			get(ctx) {
				const state = sockets.get(ctx.this as WebSocket);
				return state ? state[key] : ctx.get();
			},
			...(writable
				? {
						set(ctx: any, value: any) {
							const state = sockets.get(ctx.this as WebSocket);
							if (!state) return ctx.set(value);
							state[key] = typeof value === "function" ? value : null;
						},
					}
				: {}),
		});
	property("url", "url");
	property("readyState", "readyState");
	property("onopen", "onopen", true);
	property("onmessage", "onmessage", true);
	property("onclose", "onclose", true);
	property("onerror", "onerror", true);
	client.Trap("WebSocket.prototype.binaryType", {
		get(ctx) {
			const state = sockets.get(ctx.this as WebSocket);
			return state ? state.binaryType : ctx.get();
		},
		set(ctx, value: BinaryType) {
			const state = sockets.get(ctx.this as WebSocket);
			if (!state) return ctx.set(value);
			if (value === "blob" || value === "arraybuffer") state.binaryType = value;
		},
	});
	for (const [name, value] of [
		["bufferedAmount", 0],
		["extensions", ""],
	] as const)
		client.Trap(`WebSocket.prototype.${name}`, {
			get(ctx) {
				const state = sockets.get(ctx.this as WebSocket);
				if (!state) return ctx.get();
				return name === "extensions"
					? (state.barews?.extensions ?? value)
					: value;
			},
		});
	client.Trap("WebSocket.prototype.protocol", {
		get(ctx) {
			const state = sockets.get(ctx.this as WebSocket);
			return state ? (state.barews?.protocol ?? "") : ctx.get();
		},
	});

	client.Proxy("WebSocket.prototype.send", {
		apply(ctx) {
			const state = sockets.get(ctx.this as WebSocket);
			if (!state) return;
			if (state.readyState === CONNECTING)
				throw new DOMException(
					"Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
					"InvalidStateError"
				);
			ctx.return(undefined);
			if (state.readyState !== OPEN || !state.barews) return;
			state.barews
				.send(ctx.args[0] as Blob | ArrayBuffer | string)
				.catch(() => undefined);
		},
	});

	client.Proxy("WebSocket.prototype.close", {
		apply(ctx) {
			const state = sockets.get(ctx.this as WebSocket);
			if (!state) return;
			ctx.return(undefined);
			if (state.readyState >= CLOSING) return;
			const code = ctx.args[0] === undefined ? 1000 : Number(ctx.args[0]);
			const reason = ctx.args[1] === undefined ? "" : String(ctx.args[1]);
			if (state.readyState === CONNECTING) state.closing = [code, reason];
			else state.barews?.close(code, reason);
			state.readyState = CLOSING;
		},
	});
}
