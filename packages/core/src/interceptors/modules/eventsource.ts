import { Object_setPrototypeOf } from "@/shared/snapshot";
import type { InterceptorClient } from "../client";
import { NativeWeakMap } from "../natives";

export const order = 0;

type FakeEventSourceState = {
	url: string;
	readyState: number;
	withCredentials: boolean;
	abort: AbortController;
	onopen: ((ev: Event) => any) | null;
	onmessage: ((ev: MessageEvent) => any) | null;
	onerror: ((ev: Event) => any) | null;
};

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

export default function (client: InterceptorClient, self: typeof globalThis) {
	if (!self.EventSource) return;
	const sources = new NativeWeakMap<EventSource, FakeEventSourceState>();

	client.Proxy("EventSource", {
		construct(ctx) {
			const url = client.resolve(String(ctx.args[0]));
			if (!url || client.route(url) === "native") {
				if (url) ctx.args[0] = url.href;
				return;
			}
			const fake = new EventTarget() as EventSource;
			Object_setPrototypeOf(fake, ctx.fn.prototype);
			const state: FakeEventSourceState = {
				url: url.href,
				readyState: CONNECTING,
				withCredentials: Boolean(
					(ctx.args[1] as EventSourceInit | undefined)?.withCredentials
				),
				abort: new AbortController(),
				onopen: null,
				onmessage: null,
				onerror: null,
			};
			sources.set(fake, state);
			const fire = (event: Event) => {
				const handler = (state as Record<string, any>)[`on${event.type}`];
				if (typeof handler === "function") handler.call(fake, event);
				fake.dispatchEvent(event);
			};
			let lastEventId = "";
			let retry = 3000;
			const connect = async () => {
				const headers: Record<string, string> = {
					Accept: "text/event-stream",
					"Cache-Control": "no-cache",
				};
				if (lastEventId) headers["Last-Event-ID"] = lastEventId;
				const response = await client.fetch(
					new Request(url.href, { headers, signal: state.abort.signal })
				);
				if (
					!response.ok ||
					!/^text\/event-stream/i.test(
						response.headers.get("content-type") ?? ""
					) ||
					!response.body
				) {
					// A wrong answer ends the stream for good, as it does in browsers
					state.readyState = CLOSED;
					fire(new Event("error"));
					return false;
				}
				state.readyState = OPEN;
				fire(new Event("open"));
				const reader = response.body
					.pipeThrough(new TextDecoderStream())
					.getReader();
				let buffer = "";
				let data = "";
				let type = "";
				for (;;) {
					const next = await reader.read();
					if (next.done) return true;
					buffer += next.value;
					const lines = buffer.split(/\r\n|\r|\n/);
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						if (line === "") {
							if (data) {
								fire(
									new MessageEvent(type || "message", {
										data: data.slice(0, -1),
										lastEventId,
										origin: url.origin,
									})
								);
							}
							data = "";
							type = "";
							continue;
						}
						if (line.startsWith(":")) continue;
						const colon = line.indexOf(":");
						const field = colon === -1 ? line : line.slice(0, colon);
						let value = colon === -1 ? "" : line.slice(colon + 1);
						if (value.startsWith(" ")) value = value.slice(1);
						if (field === "data") data += `${value}\n`;
						else if (field === "event") type = value;
						else if (field === "id" && !value.includes("\0"))
							lastEventId = value;
						else if (field === "retry" && /^\d+$/.test(value))
							retry = Number(value);
					}
				}
			};
			const run = async () => {
				while (state.readyState !== CLOSED) {
					let reconnect = true;
					try {
						reconnect = await connect();
					} catch (error) {
						if (state.abort.signal.aborted) return;
						client.report(error, url.href);
					}
					if (state.readyState === CLOSED || !reconnect) return;
					state.readyState = CONNECTING;
					fire(new Event("error"));
					await new Promise((resolve) => setTimeout(resolve, retry));
				}
			};
			if (client.route(url) === "blocked")
				queueMicrotask(() => {
					state.readyState = CLOSED;
					fire(new Event("error"));
				});
			else run();
			ctx.return(fake);
		},
	});

	for (const name of ["url", "readyState", "withCredentials"] as const)
		client.Trap(`EventSource.prototype.${name}`, {
			get(ctx) {
				const state = sources.get(ctx.this as EventSource);
				return state ? state[name] : ctx.get();
			},
		});
	for (const name of ["onopen", "onmessage", "onerror"] as const)
		client.Trap(`EventSource.prototype.${name}`, {
			get(ctx) {
				const state = sources.get(ctx.this as EventSource);
				return state ? state[name] : ctx.get();
			},
			set(ctx, value: any) {
				const state = sources.get(ctx.this as EventSource);
				if (!state) return ctx.set(value);
				state[name] = typeof value === "function" ? value : null;
			},
		});
	client.Proxy("EventSource.prototype.close", {
		apply(ctx) {
			const state = sources.get(ctx.this as EventSource);
			if (!state) return;
			state.readyState = CLOSED;
			state.abort.abort();
			ctx.return(undefined);
		},
	});
}
