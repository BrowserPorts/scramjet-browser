import type { InterceptorClient } from "../client";
import { NativeWeakMap } from "../natives";

export const order = 0;

/** A request the interceptors run over the transport while the page holds a native XHR */
type Remote = {
	method: string;
	url: string;
	sync: boolean;
	blocked: boolean;
	headers: Headers;
	responseType: XMLHttpRequestResponseType;
	timeout: number;
	readyState: number;
	status: number;
	statusText: string;
	responseURL: string;
	response: unknown;
	text: string;
	mime: string;
	responseHeaders: Headers;
	active: AbortController | undefined;
	timer: ReturnType<typeof setTimeout> | undefined;
	loaded: number;
	total: number;
	lengthKnown: boolean;
	xml: Document | null | undefined;
};

export default function (client: InterceptorClient, self: typeof globalThis) {
	if (!self.XMLHttpRequest) return;
	const remotes = new NativeWeakMap<XMLHttpRequest, Remote>();
	const emit = (xhr: XMLHttpRequest, state: Remote, type: string) =>
		xhr.dispatchEvent(
			type === "readystatechange"
				? new Event(type)
				: new ProgressEvent(type, {
						loaded: state.loaded,
						total: state.total,
						lengthComputable: state.lengthKnown,
					})
		);
	const clear = (state: Remote) => {
		clearTimeout(state.timer);
		state.timer = undefined;
		state.active = undefined;
	};
	const fail = (
		xhr: XMLHttpRequest,
		state: Remote,
		type: "error" | "timeout" | "abort"
	) => {
		state.active?.abort();
		clear(state);
		Object.assign(state, {
			status: 0,
			statusText: "",
			responseURL: "",
			response: null,
			text: "",
			xml: undefined,
			responseHeaders: new Headers(),
			readyState: 4,
		});
		emit(xhr, state, "readystatechange");
		emit(xhr, state, type);
		emit(xhr, state, "loadend");
	};
	const nativeValue = (xhr: XMLHttpRequest, name: string) =>
		client.descriptors[`XMLHttpRequest.prototype.${name}`]?.get?.call(xhr);

	client.Proxy("XMLHttpRequest.prototype.open", {
		apply(ctx) {
			const xhr = ctx.this as XMLHttpRequest;
			const previous = remotes.get(xhr);
			if (previous) {
				previous.active?.abort();
				clear(previous);
				remotes.delete(xhr);
			}
			const url = client.resolve(String(ctx.args[1]));
			if (!url) return;
			const route = client.route(url);
			if (route === "native") {
				ctx.args[1] = url.href;
				return;
			}
			const method = String(ctx.args[0]);
			if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(method))
				throw new DOMException("Invalid request method", "SyntaxError");
			if (/^(CONNECT|TRACE|TRACK)$/i.test(method))
				throw new DOMException("Unsupported request method", "SecurityError");
			const state: Remote = {
				method: /^(DELETE|GET|HEAD|OPTIONS|POST|PUT|PATCH)$/i.test(method)
					? method.toUpperCase()
					: method,
				url: url.href,
				sync: ctx.args.length > 2 && !ctx.args[2],
				blocked: route === "blocked",
				headers: new Headers(),
				responseType: nativeValue(xhr, "responseType") ?? "",
				timeout: nativeValue(xhr, "timeout") ?? 0,
				readyState: 1,
				status: 0,
				statusText: "",
				responseURL: "",
				response: null,
				text: "",
				mime: "",
				responseHeaders: new Headers(),
				active: undefined,
				timer: undefined,
				loaded: 0,
				total: 0,
				lengthKnown: false,
				xml: undefined,
			};
			remotes.set(xhr, state);
			ctx.return(undefined);
			emit(xhr, state, "readystatechange");
		},
	});

	client.Proxy("XMLHttpRequest.prototype.setRequestHeader", {
		apply(ctx) {
			const state = remotes.get(ctx.this as XMLHttpRequest);
			if (!state) return;
			if (state.readyState !== 1 || state.active)
				throw new DOMException(
					"The request is already active",
					"InvalidStateError"
				);
			state.headers.append(String(ctx.args[0]), String(ctx.args[1]));
			ctx.return(undefined);
		},
	});

	client.Proxy("XMLHttpRequest.prototype.overrideMimeType", {
		apply(ctx) {
			const state = remotes.get(ctx.this as XMLHttpRequest);
			if (!state) return;
			if (state.readyState >= 3)
				throw new DOMException("The response has started", "InvalidStateError");
			state.mime = String(ctx.args[0]);
			ctx.return(undefined);
		},
	});

	client.Proxy("XMLHttpRequest.prototype.getResponseHeader", {
		apply(ctx) {
			const state = remotes.get(ctx.this as XMLHttpRequest);
			if (!state) return;
			ctx.return(
				state.readyState < 2
					? null
					: state.responseHeaders.get(String(ctx.args[0]))
			);
		},
	});

	client.Proxy("XMLHttpRequest.prototype.getAllResponseHeaders", {
		apply(ctx) {
			const state = remotes.get(ctx.this as XMLHttpRequest);
			if (!state) return;
			let all = "";
			if (state.readyState >= 2)
				state.responseHeaders.forEach((value, name) => {
					all += `${name}: ${value}\r\n`;
				});
			ctx.return(all);
		},
	});

	client.Proxy("XMLHttpRequest.prototype.abort", {
		apply(ctx) {
			const xhr = ctx.this as XMLHttpRequest;
			const state = remotes.get(xhr);
			if (!state) return;
			ctx.return(undefined);
			if (state.active) fail(xhr, state, "abort");
			state.readyState = 0;
		},
	});

	client.Proxy("XMLHttpRequest.prototype.send", {
		apply(ctx) {
			const xhr = ctx.this as XMLHttpRequest;
			const state = remotes.get(xhr);
			if (!state) return;
			if (state.readyState !== 1 || state.active)
				throw new DOMException("The request is not open", "InvalidStateError");
			// A synchronous request cannot wait on a socket, so it fails as a network error would
			if (state.sync)
				throw new DOMException(
					`Failed to load '${state.url}' synchronously`,
					"NetworkError"
				);
			ctx.return(undefined);
			const active = new AbortController();
			state.active = active;
			if (state.timeout > 0)
				state.timer = setTimeout(() => {
					if (state.active === active) fail(xhr, state, "timeout");
				}, state.timeout);
			emit(xhr, state, "loadstart");
			if (state.active !== active) return;
			if (state.blocked) {
				queueMicrotask(() => {
					if (state.active === active) fail(xhr, state, "error");
				});
				return;
			}
			let body = ctx.args[0] as BodyInit | Document | null | undefined;
			if (typeof Document !== "undefined" && body instanceof Document)
				body = new XMLSerializer().serializeToString(body);
			client
				.fetch(
					new Request(state.url, {
						method: state.method,
						headers: state.headers,
						body: /^(GET|HEAD)$/.test(state.method)
							? null
							: ((body as BodyInit | undefined) ?? null),
						signal: active.signal,
					})
				)
				.then(async (response) => {
					if (state.active !== active) return;
					state.status = response.status;
					state.statusText = response.statusText;
					state.responseURL = response.url || state.url;
					state.responseHeaders = response.headers;
					const length = response.headers.get("content-length");
					state.lengthKnown = length !== null && /^\d+$/.test(length);
					state.total = state.lengthKnown ? Number(length) : 0;
					state.readyState = 2;
					emit(xhr, state, "readystatechange");
					const reader = response.body?.getReader();
					const cancel = () => reader?.cancel().catch(() => undefined);
					active.signal.addEventListener("abort", cancel, { once: true });
					const chunks: Uint8Array[] = [];
					const decoder = new TextDecoder();
					const textual = !state.responseType || state.responseType === "text";
					try {
						while (reader && state.active === active) {
							const next = await reader.read();
							if (next.done || state.active !== active) break;
							chunks.push(next.value);
							state.loaded += next.value.byteLength;
							if (textual)
								state.text += decoder.decode(next.value, { stream: true });
							state.readyState = 3;
							emit(xhr, state, "readystatechange");
							if (state.active === active) emit(xhr, state, "progress");
						}
					} finally {
						active.signal.removeEventListener("abort", cancel);
					}
					if (state.active !== active) return;
					const bytes = new Uint8Array(state.loaded);
					let offset = 0;
					for (const chunk of chunks) {
						bytes.set(chunk, offset);
						offset += chunk.byteLength;
					}
					const mime = state.mime || response.headers.get("content-type") || "";
					if (state.responseType === "arraybuffer")
						state.response = bytes.buffer;
					else if (state.responseType === "blob")
						state.response = new Blob([bytes], { type: mime });
					else {
						state.text = textual
							? state.text + decoder.decode()
							: decoder.decode(bytes);
						if (state.responseType === "json") {
							try {
								state.response = JSON.parse(state.text);
							} catch {
								state.response = null;
							}
						} else if (state.responseType === "document") {
							state.response = parse(state.text, mime);
						} else state.response = state.text;
					}
					clear(state);
					state.readyState = 4;
					emit(xhr, state, "readystatechange");
					emit(xhr, state, "load");
					emit(xhr, state, "loadend");
				})
				.catch((error) => {
					if (state.active !== active) return;
					client.report(error, state.url);
					fail(xhr, state, "error");
				});
		},
	});

	const parse = (text: string, mime: string): Document | null =>
		typeof DOMParser === "undefined"
			? null
			: new DOMParser().parseFromString(
					text,
					/html/.test(mime) ? "text/html" : "application/xml"
				);

	const read = <K extends keyof Remote>(name: string, key: K) =>
		client.Trap(`XMLHttpRequest.prototype.${name}`, {
			get(ctx) {
				const state = remotes.get(ctx.this);
				return state ? state[key] : ctx.get();
			},
		});
	read("readyState", "readyState");
	read("status", "status");
	read("statusText", "statusText");
	read("responseURL", "responseURL");

	client.Trap("XMLHttpRequest.prototype.response", {
		get(ctx) {
			const state = remotes.get(ctx.this);
			if (!state) return ctx.get();
			if (!state.responseType || state.responseType === "text")
				return state.readyState >= 3 ? state.text : "";
			return state.readyState === 4 ? state.response : null;
		},
	});
	client.Trap("XMLHttpRequest.prototype.responseText", {
		get(ctx) {
			const state = remotes.get(ctx.this);
			if (!state) return ctx.get();
			if (state.responseType && state.responseType !== "text")
				throw new DOMException("The response is not text", "InvalidStateError");
			return state.readyState >= 3 ? state.text : "";
		},
	});
	client.Trap("XMLHttpRequest.prototype.responseXML", {
		get(ctx) {
			const state = remotes.get(ctx.this);
			if (!state) return ctx.get();
			if (state.responseType === "document")
				return state.readyState === 4 ? state.response : null;
			if (state.responseType || state.readyState !== 4) return null;
			const mime =
				state.mime || state.responseHeaders.get("content-type") || "";
			if (!/xml|html/.test(mime)) return null;
			state.xml ??= parse(state.text, mime);
			return state.xml;
		},
	});
	for (const [name, key] of [
		["responseType", "responseType"],
		["timeout", "timeout"],
	] as const)
		client.Trap(`XMLHttpRequest.prototype.${name}`, {
			get(ctx) {
				const state = remotes.get(ctx.this);
				return state ? state[key] : ctx.get();
			},
			set(ctx, value) {
				const state = remotes.get(ctx.this);
				if (!state) return ctx.set(value);
				if (key === "timeout") state.timeout = Number(value) || 0;
				else if (state.readyState >= 3)
					throw new DOMException(
						"The response has started",
						"InvalidStateError"
					);
				// The native setter ignores values outside the enumeration
				else if (
					["", "arraybuffer", "blob", "document", "json", "text"].includes(
						value
					)
				)
					state.responseType = value;
			},
		});
}
