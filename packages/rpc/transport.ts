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

export type TransportToController = {
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

	private rpc: RpcHelper<ControllerToTransport, TransportToController>;
	constructor(sink: RpcSink, options: { ready?: boolean } = {}) {
		const methods: MethodsDefinition<ControllerToTransport> = {
			ready: async () => {
				this.readyResolve(undefined);
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
		if (options.ready) this.readyResolve(undefined);
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
						onopen(response.protocol, response.extensions);
					} else {
						onerror(response.error);
					}
				},
				(error) => onerror(String(error))
			);
		port.onmessage = (ev) => {
			const message = ev.data as WebSocketMessage;
			if (message.type === "data") {
				onmessage(message.data);
			} else if (message.type === "close") {
				onclose(message.code, message.reason);
			}
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
		await this.rpc.call("sendSetCookie", {
			cookies: cookies.map(({ url, cookie }) => ({
				url: url.href,
				cookie,
			})),
			options,
		});
		return undefined;
	}

	async sendStorageMutation(mutations: StorageMutation[]): Promise<boolean> {
		await this.rpc.call("sendStorageMutation", { mutations });
		return true;
	}
}

export type ServeTransportOptions = {
	/** The transport, or a getter for a side that swaps its transport while connected */
	transport: ProxyTransport | (() => ProxyTransport);
	resolveProxy?: (url: URL) => string | null | undefined | Promise<string | null | undefined>;
	sendSetCookie?: MethodsDefinition<TransportToController>["sendSetCookie"];
	sendStorageMutation?: MethodsDefinition<TransportToController>["sendStorageMutation"];
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
