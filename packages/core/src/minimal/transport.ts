import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
	WebSocketDataType,
} from "./types";

type Connect = ProxyTransport["connect"];

/**
 * Starts the real transport the first time a request needs it, so a page that never leaves its
 * own origin never downloads or connects one.
 */
export class LazyTransport implements ProxyTransport {
	ready = false;
	#inner: ProxyTransport | undefined;
	#loading: Promise<void> | undefined;

	/** How the transport starts; replaceable until the first request starts it */
	constructor(public load: () => Promise<ProxyTransport>) {}

	init(): Promise<void> {
		this.#loading ??= (async () => {
			try {
				const inner = await this.load();
				if (!inner.ready) await inner.init();
				this.#inner = inner;
				this.ready = true;
			} catch (error) {
				// A failed start, such as a dropped connection, is retried by the next request
				this.#loading = undefined;
				throw error;
			}
		})();
		return this.#loading;
	}

	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		signal: AbortSignal | undefined
	): Promise<TransferrableResponse> {
		await this.init();
		return this.#inner!.request(remote, method, body, headers, signal);
	}

	connect(...args: Parameters<Connect>): ReturnType<Connect> {
		// BareCompatibleWebSocket waits for init before it connects
		if (!this.#inner) throw new Error("The transport has not started");
		return this.#inner.connect(...args);
	}
}

type PortRequest = {
	type: "request";
	id: number;
	url: string;
	method: string;
	headers: RawHeaders;
	body: ArrayBuffer | null;
};
type PortConnect = {
	type: "connect";
	url: string;
	protocols: string[];
	headers: RawHeaders;
};

async function bodyBuffer(body: BodyInit | null): Promise<ArrayBuffer | null> {
	if (body === null || body === undefined) return null;
	return new Response(body).arrayBuffer();
}

/**
 * A worker's transport: every request and socket is relayed to the page that created the worker,
 * which owns the only Wisp connection.
 */
export class PortTransport implements ProxyTransport {
	ready = true;
	#next = 0;
	#pending = new Map<
		number,
		{
			resolve: (response: TransferrableResponse) => void;
			reject: (error: Error) => void;
		}
	>();

	constructor(private port: MessagePort) {
		port.onmessage = (event) => {
			const data = event.data;
			const pending = this.#pending.get(data?.id);
			if (!pending) return;
			this.#pending.delete(data.id);
			if (data.error) pending.reject(new TypeError(String(data.error)));
			else
				pending.resolve({
					body: data.body,
					headers: data.headers,
					status: data.status,
					statusText: data.statusText,
				});
		};
	}

	async init() {}

	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		signal: AbortSignal | undefined
	): Promise<TransferrableResponse> {
		signal?.throwIfAborted();
		const buffer = await bodyBuffer(body);
		const id = this.#next++;
		return new Promise((resolve, reject) => {
			const abort = () => {
				this.#pending.delete(id);
				this.port.postMessage({ type: "abort", id });
				reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
			};
			signal?.addEventListener("abort", abort, { once: true });
			const done = () => signal?.removeEventListener("abort", abort);
			this.#pending.set(id, {
				resolve: (response) => {
					done();
					resolve(response);
				},
				reject: (error) => {
					done();
					reject(error);
				},
			});
			const message: PortRequest = {
				type: "request",
				id,
				url: remote.href,
				method,
				headers,
				body: buffer,
			};
			this.port.postMessage(message, buffer ? [buffer] : []);
		});
	}

	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: WebSocketDataType) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void
	): ReturnType<Connect> {
		const channel = new MessageChannel();
		channel.port1.onmessage = (event) => {
			const data = event.data;
			if (data.type === "open") onopen(data.protocol, data.extensions);
			else if (data.type === "message") onmessage(data.data);
			else if (data.type === "error") onerror(data.error);
			else if (data.type === "close") {
				onclose(data.code, data.reason);
				channel.port1.close();
			}
		};
		const message: PortConnect = {
			type: "connect",
			url: url.href,
			protocols,
			headers: requestHeaders,
		};
		this.port.postMessage(message, [channel.port2]);
		return [
			(data) => channel.port1.postMessage({ type: "send", data }),
			(code, reason) =>
				channel.port1.postMessage({ type: "close", code, reason }),
		];
	}
}

/** Answers a worker's {@link PortTransport} with the page's own transport */
export function serveTransport(port: MessagePort, transport: ProxyTransport) {
	const active = new Map<number, AbortController>();
	port.onmessage = async (event) => {
		const data = event.data as
			| PortRequest
			| PortConnect
			| { type: "abort"; id: number };
		if (data?.type === "abort") {
			active.get(data.id)?.abort();
			active.delete(data.id);
			return;
		}
		if (data?.type === "connect") {
			const socket = event.ports[0];
			if (!socket) return;
			try {
				if (!transport.ready) await transport.init();
				const [send, close] = transport.connect(
					new URL(data.url),
					data.protocols,
					data.headers,
					(protocol, extensions) =>
						socket.postMessage({ type: "open", protocol, extensions }),
					(message) => socket.postMessage({ type: "message", data: message }),
					(code, reason) => {
						socket.postMessage({ type: "close", code, reason });
						socket.close();
					},
					(error) => socket.postMessage({ type: "error", error })
				);
				socket.onmessage = (message) => {
					if (message.data?.type === "send") send(message.data.data);
					else if (message.data?.type === "close")
						close(message.data.code, message.data.reason);
				};
			} catch (error) {
				socket.postMessage({ type: "error", error: String(error) });
				socket.postMessage({ type: "close", code: 1006, reason: "" });
				socket.close();
			}
			return;
		}
		if (data?.type !== "request") return;
		const abort = new AbortController();
		active.set(data.id, abort);
		try {
			const response = await transport.request(
				new URL(data.url),
				data.method,
				data.body,
				data.headers,
				abort.signal
			);
			if (abort.signal.aborted) return;
			const answer = {
				id: data.id,
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
				body: response.body,
			};
			try {
				port.postMessage(
					answer,
					response.body instanceof ReadableStream ? [response.body] : []
				);
			} catch {
				// Browsers without transferable streams get the whole body at once
				const body = await new Response(response.body).arrayBuffer();
				port.postMessage({ ...answer, body }, [body]);
			}
		} catch (error) {
			if (!abort.signal.aborted)
				port.postMessage({
					id: data.id,
					error: error instanceof Error ? error.message : String(error),
				});
		} finally {
			active.delete(data.id);
		}
	};
}
