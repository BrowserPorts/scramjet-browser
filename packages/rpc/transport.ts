import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
} from "@mercuryworkshop/proxy-transports";
import type { MethodsDefinition } from "./helper";
import { RpcHelper } from "./helper";

// The transport relayed over a port: a page, frame or worker that cannot hold the Wisp connection
// itself asks the side that does. The controller and the service-worker-free runtimes both use it.

export type StorageType = "localStorage" | "sessionStorage";

export type StorageMutation =
	| { type: "setItem"; storageType: StorageType; origin: string; key: string; value: string }
	| { type: "removeItem"; storageType: StorageType; origin: string; key: string }
	| { type: "clear"; storageType: StorageType; origin: string };

export type CookieSyncOptions = { clear?: boolean };

export type SerializedCookieSyncEntry = { url: string; cookie: string };

/** A snapshot replaces a page's jar before any cookies in the same update are set */
export type CookieSyncUpdate = {
	snapshot?: string;
	cookies?: SerializedCookieSyncEntry[];
	options?: CookieSyncOptions;
};

/**
 * Where a page keeps its copy of the serving side's cookie jar. A cookie the page set stays tracked
 * until the serving side has applied it, so a snapshot that arrives first can't drop it
 */
export type CookieSyncSink = {
	apply(update: CookieSyncUpdate): unknown;
	track(entries: SerializedCookieSyncEntry[], applied: Promise<unknown>): Promise<unknown>;
};

export type TransportToController = {
	linkWorkerTransport: [{ port: MessagePort }];
	request: [
		{
			remote: string;
			method: string;
			body: BodyInit | null;
			headers: RawHeaders;
			proxy?: string | null;
		},
		TransferrableResponse,
	];
	sendSetCookie: [
		{
			cookies: SerializedCookieSyncEntry[];
			options?: CookieSyncOptions;
		},
	];
	sendStorageMutation: [
		{
			mutations: StorageMutation[];
		},
	];
	/** A page that is hidden or gone stops receiving cookie updates, and gets a snapshot when shown */
	setCookieReceiver: [{ active: boolean }];
	connect: [
		{
			url: string;
			protocols: string[];
			requestHeaders: RawHeaders;
			port: MessagePort;
			proxy?: string | null;
		},
		(
			| { result: "success"; protocol: string; extensions: string }
			| { result: "failure"; error: string }
		),
	];
};

export type ControllerToTransport = {
	ready: [];
	/** Keeps the page's cookie jar in step with the serving side's, in order */
	cookieSync: [CookieSyncUpdate];
};

export type WebSocketData = string | ArrayBuffer | Blob;
export type WebSocketMessage =
	| { type: "data"; data: WebSocketData }
	| { type: "close"; code: number; reason: string };

type ProxyAwareTransport = ProxyTransport & {
	connect(
		...args: [
			...Parameters<ProxyTransport["connect"]>,
			options?: { proxy?: string | null },
		]
	): ReturnType<ProxyTransport["connect"]>;
	request(
		...args: [
			...Parameters<ProxyTransport["request"]>,
			options?: { proxy?: string | null },
		]
	): ReturnType<ProxyTransport["request"]>;
};

const MessagePort_postMessage = MessagePort.prototype.postMessage;
const post = (port: MessagePort, data: any, transfer?: Transferable[]) => {
	MessagePort_postMessage.call(port, data, transfer as any);
};

/** Where a {@link RemoteTransport} sends its RPC messages */
export type RpcSink =
	| MessagePort
	| {
			channel(
				id: string,
				methods: MethodsDefinition<ControllerToTransport>
			): RpcHelper<ControllerToTransport, TransportToController>;
	  };

/**
 * A transport whose requests and sockets are performed by the other end of a port, which owns the
 * real Wisp connection. Pass a MessagePort to own the port, or an RpcLink to share it.
 */
export class RemoteTransport implements ProxyTransport {
	private readyResolve!: (value: undefined) => unknown;
	private readyReject!: (reason: unknown) => unknown;
	private readyPromise: Promise<undefined> = new Promise((resolve, reject) => {
		this.readyResolve = resolve;
		this.readyReject = reject;
	});

	public ready = false;
	async init() {
		await this.readyPromise;
		this.ready = true;
	}

	fail(error: Error): undefined {
		this.readyReject(error);
		return undefined;
	}

	/** Transfers a worker's channel to the controller that owns this transport */
	async linkWorkerTransport(port: MessagePort): Promise<undefined> {
		await this.rpc.call("linkWorkerTransport", { port }, [port]);
		return undefined;
	}

	private rpc: RpcHelper<ControllerToTransport, TransportToController>;
	private cookies: CookieSyncSink | undefined;
	constructor(sink: RpcSink, options: { ready?: boolean; cookies?: CookieSyncSink } = {}) {
		this.cookies = options.cookies;
		const methods: MethodsDefinition<ControllerToTransport> = {
			ready: async () => {
				// The handshake publishes readiness before a socket can ask for initialization
				this.ready = true;
				this.readyResolve(undefined);
			},
			// A side with no jar of its own, such as a worker, has nothing to keep in step
			cookieSync: async (update) => {
				this.cookies?.apply(update);
			},
		};
		if ("channel" in sink) {
			this.rpc = sink.channel("transport", methods);
		} else {
			const port = sink;
			this.rpc = new RpcHelper<ControllerToTransport, TransportToController>(
				methods,
				"transport",
				(data, transfer) => post(port, data, transfer)
			);
			port.onmessageerror = (ev) => {
				console.error("onmessageerror (this should never happen!)", ev);
			};
			port.onmessage = (ev) => {
				this.rpc.recieve(ev.data);
			};
			port.start();
		}
		// A link that was handed over already connected needs no ready message
		if (options.ready) {
			this.ready = true;
			this.readyResolve(undefined);
		}
	}

	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => unknown,
		onmessage: (data: Blob | ArrayBuffer | string) => unknown,
		onclose: (code: number, reason: string) => unknown,
		onerror: (error: string) => unknown,
		options: { proxy?: string | null } = {}
	): [
		(data: Blob | ArrayBuffer | string) => unknown,
		(code: number, reason: string) => unknown,
	] {
		const channel = new MessageChannel();
		const port = channel.port1;
		let settled = false;
		const pending: WebSocketMessage[] = [];
		const receive = (message: WebSocketMessage) => {
			if (message.type === "data") onmessage(message.data);
			else if (message.type === "close") onclose(message.code, message.reason);
		};
		// Socket events and the connect reply arrive over separate ports
		const complete = (notify: () => unknown) => {
			settled = true;
			notify();
			queueMicrotask(() => {
				for (const message of pending.splice(0)) receive(message);
			});
		};
		this.rpc
			.call(
				"connect",
				{
					url: url.href,
					protocols,
					requestHeaders,
					port: channel.port2,
					proxy: options.proxy,
				},
				[channel.port2]
			)
			.then(
				(response) => {
					if (response.result === "success") {
						complete(() => onopen(response.protocol, response.extensions));
					} else {
						complete(() => onerror(response.error));
					}
				},
				(error) => complete(() => onerror(String(error)))
			);
		port.onmessage = (ev) => {
			const message = ev.data as WebSocketMessage;
			if (settled) receive(message);
			else pending.push(message);
		};
		port.onmessageerror = (ev) => {
			console.error("onmessageerror (this should never happen!)", ev);
			onerror("Message error in transport port");
		};

		return [
			(data) => {
				post(
					port,
					{
						type: "data",
						data: data,
					},
					data instanceof ArrayBuffer ? [data] : []
				);
			},
			(code, reason) => {
				post(port, {
					type: "close",
					code: code,
					reason,
				});
			},
		];
	}

	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		_signal: AbortSignal | undefined,
		options: { proxy?: string | null } = {}
	): Promise<TransferrableResponse> {
		return await this.rpc.call("request", {
			remote: remote.href,
			method,
			body,
			headers,
			proxy: options.proxy,
		});
	}

	async sendSetCookie(
		cookies: Array<{ url: URL; cookie: string }>,
		options: CookieSyncOptions = {}
	): Promise<undefined> {
		const entries = cookies.map(({ url, cookie }) => ({
			url: url.href,
			cookie,
		}));
		const applied = this.rpc.call("sendSetCookie", { cookies: entries, options });
		await (this.cookies ? this.cookies.track(entries, applied) : applied);
		return undefined;
	}

	/** Says whether this page can receive cookie updates; a hidden page must not hold up responses */
	setCookieReceiver(active: boolean): undefined {
		this.rpc.call("setCookieReceiver", { active }).catch((error) => {
			console.error("Scramjet cookie receiver update failed:", error);
		});
		return undefined;
	}

	async sendStorageMutation(mutations: StorageMutation[]): Promise<boolean> {
		await this.rpc.call("sendStorageMutation", { mutations });
		return true;
	}
}

export type ServeTransportOptions = {
	linkWorkerTransport?: MethodsDefinition<TransportToController>["linkWorkerTransport"];
	/** The transport, or a getter for a side that swaps its transport while connected */
	transport: ProxyTransport | (() => ProxyTransport);
	resolveProxy?: (url: URL) => string | null | undefined | Promise<string | null | undefined>;
	sendSetCookie?: MethodsDefinition<TransportToController>["sendSetCookie"];
	sendStorageMutation?: MethodsDefinition<TransportToController>["sendStorageMutation"];
	/** Defaults to ignoring it, for a serving side that sends no cookie updates */
	setCookieReceiver?: MethodsDefinition<TransportToController>["setCookieReceiver"];
	/** Lets the serving side rewrite or refuse a request before it leaves */
	onRequest?: (
		args: TransportToController["request"][0]
	) => void | TransferrableResponse | Promise<void | TransferrableResponse>;
};

/** The methods that answer a {@link RemoteTransport}, for a port or an RpcLink channel */
export function remoteTransportMethods(
	options: ServeTransportOptions
): MethodsDefinition<TransportToController> {
	const refuse = (name: string) => async () => {
		throw new Error(`${name} is not served on this transport`);
	};
	const current = () =>
		(typeof options.transport === "function"
			? options.transport()
			: options.transport) as ProxyAwareTransport;
	const proxyFor = async (url: URL, proxy?: string | null) =>
		proxy ?? (await options.resolveProxy?.(url)) ?? null;
	return {
		linkWorkerTransport: options.linkWorkerTransport ?? refuse("linkWorkerTransport"),
		request: async (args) => {
			const answered = await options.onRequest?.(args);
			if (answered) return [answered, answered.body instanceof ReadableStream ? [answered.body] : []];
			const transport = current();
			if (!transport.ready) await transport.init();
			const url = new URL(args.remote);
			const response = await transport.request(
				url,
				args.method,
				args.body,
				args.headers,
				undefined,
				{ proxy: await proxyFor(url, args.proxy) }
			);
			return [
				response,
				response.body instanceof ReadableStream || response.body instanceof ArrayBuffer
					? [response.body]
					: [],
			];
		},
		sendSetCookie: options.sendSetCookie ?? refuse("sendSetCookie"),
		sendStorageMutation:
			options.sendStorageMutation ?? refuse("sendStorageMutation"),
		setCookieReceiver: options.setCookieReceiver ?? (async () => {}),
		connect: async ({ url, protocols, requestHeaders, port, proxy }) => {
			let resolve!: (arg: TransportToController["connect"][1]) => unknown;
			const promise = new Promise<TransportToController["connect"][1]>(
				(res) => (resolve = res)
			);
			const transport = current();
			if (!transport.ready) await transport.init();
			const remote = new URL(url);
			const [send, close] = transport.connect(
				remote,
				protocols,
				requestHeaders,
				(protocol, extensions) => {
					resolve({ result: "success", protocol, extensions });
				},
				(data) => {
					port.postMessage(
						{ type: "data", data } as WebSocketMessage,
						data instanceof ArrayBuffer ? [data] : []
					);
				},
				(code, reason) => {
					port.postMessage({ type: "close", code, reason } as WebSocketMessage);
				},
				(error) => {
					resolve({ result: "failure", error });
				},
				{ proxy: await proxyFor(remote, proxy) }
			);
			port.onmessageerror = (ev) => {
				console.error("Transport port messageerror (this should never happen!)", ev);
			};
			port.onmessage = ({ data }: { data: WebSocketMessage }) => {
				if (data.type === "data") {
					send(data.data);
				} else if (data.type === "close") {
					close(data.code, data.reason);
				}
			};
			return [await promise, []];
		},
	};
}

/** Answers a {@link RemoteTransport} on its own port */
export function serveRemoteTransport(
	port: MessagePort,
	options: ServeTransportOptions
): RpcHelper<TransportToController, ControllerToTransport> {
	const rpc = new RpcHelper<TransportToController, ControllerToTransport>(
		remoteTransportMethods(options),
		"transport",
		(data, transfer) => post(port, data, transfer)
	);
	port.onmessageerror = (ev) => {
		console.error("Transport port messageerror (this should never happen!)", ev);
	};
	port.onmessage = (e) => {
		rpc.recieve(e.data);
	};
	port.start();
	rpc.call("ready", undefined, []);
	return rpc;
}
