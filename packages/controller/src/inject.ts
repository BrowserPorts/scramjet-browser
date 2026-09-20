import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
} from "@mercuryworkshop/proxy-transports";

import { RpcHelper } from "@mercuryworkshop/rpc";
import {
	CookieJar,
	type CookieSyncOptions,
	type NativeServiceWorkerGatewayMetadata,
	SCRAMJETCLIENT,
	ScramjetClient,
	type ScramjetConfig,
	type ScramjetContext,
	type ScramjetSerializedStorageState,
	ScramjetStorageJar,
	type ScramjetStorageManager,
	type ScramjetStorageMutation,
	type ServiceWorkerHost,
	type ServiceWorkerHostEvent,
	type ServiceWorkerPageOps,
	setWasm,
	Tap,
	type TrackedHistoryState,
} from "@mercuryworkshop/scramjet";
import type { Config } from ".";
import { CONTROLLERFRAME } from "./symbols";
import type {
	ControllerToTransport,
	SerializedCookieSyncEntry,
	TransportToController,
	WebSocketMessage,
} from "./types";

const MessagePort_postMessage = MessagePort.prototype.postMessage;
const postMessage = (
	port: MessagePort,
	data: any,
	transfer?: Transferable[],
) => {
	MessagePort_postMessage.call(port, data, transfer as any);
};

class RemoteTransport implements ProxyTransport {
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

	private swListeners = new Set<(event: ServiceWorkerHostEvent) => unknown>();
	private swOps: ServiceWorkerPageOps | null = null;
	private swAttachFailure: Error | null = null;

	fail(error: Error): undefined {
		this.readyReject(error);
		return undefined;
	}

	// the emulated navigator.serviceWorker talks to the controller over this
	// same channel
	public serviceWorkerHost: ServiceWorkerHost = {
		register: (options) => this.rpc.call("swRegister", options),
		getRegistrations: (clientUrl) =>
			this.rpc.call("swGetRegistrations", { clientUrl }),
		getController: (clientUrl) =>
			this.rpc.call("swGetController", { clientUrl }),
		unregister: (id) => this.rpc.call("swUnregister", { id }),
		update: (id) => this.rpc.call("swUpdate", { id }),
		postMessage: (id, workerId, data, transfer, clientUrl) =>
			this.rpc.call(
				"swPostMessage",
				{ id, workerId, data, ports: transfer as MessagePort[], clientUrl },
				transfer,
			),
		subscribe: (listener) => {
			this.swListeners.add(listener);

			return () => this.swListeners.delete(listener);
		},
		serve: (ops) => {
			this.swOps = ops;
			this.swAttachFailure = null;
			// only now is there a browsing context behind this channel that can run
			// a realm's client operations
			this.rpc
				.call("swAttachClient", { clientUrl: ops.clientUrl() })
				.catch((cause) => {
					if (this.swOps !== ops) return;
					this.swOps = null;
					this.swAttachFailure =
						cause instanceof Error ? cause : new Error(String(cause));
				});

			return () => {
				if (this.swOps === ops) this.swOps = null;
			};
		},
	};

	private swOp<T>(run: (ops: ServiceWorkerPageOps) => Promise<T>): Promise<T> {
		if (this.swAttachFailure !== null) {
			return Promise.reject(this.swAttachFailure);
		}
		const ops = this.swOps;
		if (!ops) {
			return Promise.reject(
				new Error("no service worker container is listening in this context"),
			);
		}

		return run(ops);
	}

	private rpc: RpcHelper<ControllerToTransport, TransportToController>;
	constructor(public port: MessagePort) {
		this.rpc = new RpcHelper<ControllerToTransport, TransportToController>(
			{
				ready: async () => {
					this.readyResolve(undefined);
				},
				swEvent: async (event) => {
					for (const listener of this.swListeners) {
						try {
							listener(event);
						} catch (error) {
							console.error("service worker event listener threw:", error);
						}
					}
				},
				swOpenWindow: async ({ url }) => [
					await this.swOp((ops) => ops.openWindow(url)),
					[],
				],
				swFocus: async () => {
					await this.swOp((ops) => ops.focus());
				},
				swNavigate: async ({ url }) => [
					await this.swOp((ops) => ops.navigate(url)),
					[],
				],
				swShowNotification: async ({ title, options }) => {
					await this.swOp((ops) => ops.showNotification(title, options));
				},
			},
			"transport",
			(data, transfer) => {
				postMessage(port, data, transfer);
			},
		);
		port.onmessageerror = (ev) => {
			console.error("onmessageerror (this should never happen!)", ev);
		};
		port.onmessage = (ev) => {
			this.rpc.recieve(ev.data);
		};
		port.start();
	}
	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => unknown,
		onmessage: (data: Blob | ArrayBuffer | string) => unknown,
		onclose: (code: number, reason: string) => unknown,
		onerror: (error: string) => unknown,
		options: { proxy?: string | null } = {},
	): [
		(data: Blob | ArrayBuffer | string) => unknown,
		(code: number, reason: string) => unknown,
	] {
		const channel = new MessageChannel();
		const port = channel.port1;
		console.warn("connecting");
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
				[channel.port2],
			)
			.then((response) => {
				console.log(response);
				if (response.result === "success") {
					onopen(response.protocol, response.extensions);
				} else {
					onerror(response.error);
				}
			});
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
				postMessage(
					port,
					{
						type: "data",
						data: data,
					},
					data instanceof ArrayBuffer ? [data] : [],
				);
			},
			(code) => {
				postMessage(port, {
					type: "close",
					code: code,
				});
			},
		];
	}

	async nativeServiceWorkerRequest(
		metadata: NativeServiceWorkerGatewayMetadata,
	) {
		return await this.rpc.call("nativeServiceWorkerRequest", metadata);
	}

	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		_signal: AbortSignal | undefined,
		options: { proxy?: string | null } = {},
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
		options: CookieSyncOptions = {},
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

	async sendStorageMutation(
		mutations: ScramjetStorageMutation[],
	): Promise<boolean> {
		await this.rpc.call("sendStorageMutation", { mutations });
		return true;
	}
}

const rootServiceWorker = navigator.serviceWorker
	.getRegistration(new URL("/", location.href).href)
	.then(
		(registration) =>
			registration?.active ?? navigator.serviceWorker.controller,
	);

type Init = {
	serviceWorkerClient?: { name: string; script: string };
	config: Config;
	sjconfig: ScramjetConfig;
	prefix: URL;
	cookies: string;
	storage?: ScramjetSerializedStorageState | null;
	storagePartitionKey: string;
	yieldGetInjectScripts: (
		config: Config,
		sjconfig: ScramjetConfig,
		prefix: URL,
		cookieJar: CookieJar,
		storage: ScramjetStorageManager | undefined,
		codecEncode: (input: string) => string,
		codecDecode: (input: string) => string,
		storagePartitionKey: string,
		serviceWorkerClient?: { name: string; script: string },
	) => any;
	codecEncode: (input: string) => string;
	codecDecode: (input: string) => string;
	initHeaders: RawHeaders;
	history: TrackedHistoryState[];
};

export function load(init: Init) {
	if (SCRAMJETCLIENT in globalThis) {
		((globalThis as any)[SCRAMJETCLIENT] as ScramjetClient).syncDocumentInit({
			initHeaders: init.initHeaders,
			history: init.history,
			cookies: init.cookies,
		});
		return;
	}
	if (!("WASM" in self)) {
		throw new Error("WASM not found in global scope!");
	}
	if (
		typeof init.storagePartitionKey !== "string" ||
		init.storagePartitionKey.length === 0
	) {
		throw new Error(
			"Scramjet document injection requires its storage partition key",
		);
	}
	const wasm = Uint8Array.from(atob(String(self.WASM)), (c) => c.charCodeAt(0));
	delete (self as any).WASM;
	setWasm(wasm);

	new ExecutionContextWrapper(globalThis, init);
}

function createFrameId() {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

class ExecutionContextWrapper {
	client!: ScramjetClient;
	cookieJar: CookieJar;
	storage: ScramjetStorageJar | undefined;
	transport: RemoteTransport;
	private handleServiceWorkerCookieMessage: (event: MessageEvent) => unknown;

	constructor(
		public global: typeof globalThis,
		public init: Init,
	) {
		const channel = new MessageChannel();
		this.transport = new RemoteTransport(channel.port1);
		rootServiceWorker
			.then((worker) => {
				if (worker === null) {
					throw new Error(
						"Scramjet transport requires the root service worker",
					);
				}
				worker.postMessage(
					{
						$sw$initRemoteTransport: {
							port: channel.port2,
							prefix: this.init.prefix.href,
						},
					},
					[channel.port2],
				);
			})
			.catch((cause) => {
				this.transport.fail(
					cause instanceof Error ? cause : new Error(String(cause)),
				);
			});

		this.cookieJar = new CookieJar();
		this.cookieJar.load(this.init.cookies);
		this.storage = this.init.storage
			? new ScramjetStorageJar(this.init.storage, async (mutation) => {
					return await this.transport.sendStorageMutation([mutation]);
				})
			: undefined;

		this.handleServiceWorkerCookieMessage = (event: MessageEvent) => {
			const nativeRequest = event.data?.$scramjet$nativeServiceWorker;
			if (nativeRequest && typeof nativeRequest === "object") {
				const port = event.ports[0];
				if (!port) return;
				this.transport
					.nativeServiceWorkerRequest(
						nativeRequest as NativeServiceWorkerGatewayMetadata,
					)
					.then((response) => {
						postMessage(
							port,
							response,
							response.body instanceof ArrayBuffer || response.body instanceof ReadableStream ? [response.body] : [],
						);
					})
					.catch((error) => {
						postMessage(port, { error: String(error?.message ?? error) });
					});
				return;
			}

			if (
				!event.data?.$controller$setCookie ||
				typeof event.data.$controller$setCookie !== "object"
			) {
				return;
			}

			const payload = event.data.$controller$setCookie as {
				cookies?: SerializedCookieSyncEntry[];
				options?: CookieSyncOptions;
				id?: string;
			};

			if (payload.options?.clear) {
				this.cookieJar.clear();
			}

			if (Array.isArray(payload.cookies)) {
				for (const cookie of payload.cookies) {
					if (
						typeof cookie?.url !== "string" ||
						typeof cookie.cookie !== "string"
					) {
						continue;
					}

					try {
						this.cookieJar.setCookies(cookie.cookie, new URL(cookie.url));
					} catch {
						console.error("Failed to set cookie", cookie);
					}
				}
			}

			if (typeof payload.id === "string") {
				rootServiceWorker
					.then((worker) => {
						if (worker === null) {
							throw new Error(
								"Scramjet cookie acknowledgement requires the root service worker",
							);
						}
						worker.postMessage({
							$sw$setCookieDone: {
								id: payload.id,
							},
						});
					})
					.catch((error) => {
						console.error("Scramjet cookie acknowledgement failed:", error);
					});
			}
		};

		navigator.serviceWorker?.addEventListener(
			"message",
			this.handleServiceWorkerCookieMessage,
		);

		this.injectScramjet();
	}

	injectScramjet() {
		const frame = this.global.frameElement as HTMLIFrameElement | null;
		if (frame && !frame.name) {
			window.name = frame.name = createFrameId();
		}
		let controllerFrame = frame?.[CONTROLLERFRAME];
		let isTopLevel = true;
		if (!controllerFrame) {
			isTopLevel = false;
			let currentwin = this.global.window;
			while (currentwin.parent !== currentwin) {
				const currentclient = Reflect.get(currentwin, SCRAMJETCLIENT) as
					| ScramjetClient
					| undefined;
				if (!currentclient) {
					currentwin = currentwin.parent.window;
					continue;
				}
				const currentFrame = currentclient.descriptors.get(
					"window.frameElement",
					currentwin,
				);
				if (currentFrame && currentFrame[CONTROLLERFRAME]) {
					controllerFrame = currentFrame[CONTROLLERFRAME];
					break;
				}
				currentwin = currentwin.parent.window;
			}
		}
		const context: ScramjetContext = {
			config: this.init.sjconfig,
			prefix: this.init.prefix,
			cookieJar: this.cookieJar,
			storage: this.storage,
			storagePartitionKey: this.init.storagePartitionKey,
			interface: {
				nativeServiceWorkerPath: this.init.config.nativeServiceWorkerPath,
				getInjectScripts: this.init.yieldGetInjectScripts(
					this.init.config,
					this.init.sjconfig,
					this.init.prefix,
					this.cookieJar,
					this.storage,
					this.init.codecEncode,
					this.init.codecDecode,
					this.init.storagePartitionKey,
					this.init.serviceWorkerClient,
				),
				codecEncode: this.init.codecEncode,
				codecDecode: this.init.codecDecode,
			},
		};
		this.client = new ScramjetClient(this.global, {
			context,
			transport: this.transport,
			sendSetCookie: async (cookies, options) => {
				await this.transport.sendSetCookie(cookies, options);
			},
			shouldBlockMessageEvent: (event) => {
				// the proxy's own worker shares navigator.serviceWorker with the
				// emulated one, so its internal traffic must not reach the site
				const data = event.data;
				if (!data || typeof data !== "object") return false;

				return (
					"$controller$setCookie" in data ||
					"$controller$swrevive" in data ||
					"$scramjet$nativeServiceWorker" in data ||
					"$sw$setCookieDone" in data ||
					"$sw$initRemoteTransport" in data
				);
			},
			hookSubcontext: (frameself) => {
				const context = new ExecutionContextWrapper(frameself, {
					...this.init,
					cookies: this.cookieJar.dump(),
					storage: this.storage?.dump() ?? null,
				});
				return context.client;
			},
			initHeaders: this.init.initHeaders,
			history: this.init.history,
			serviceWorkerHost: this.transport.serviceWorkerHost,
			serviceWorkerClientName: this.init.serviceWorkerClient?.name,
		});
		const frameInitContext = {
			window: this.global.window,
			client: this.client,
			isTopLevel,
		};
		if (controllerFrame)
			Tap.dispatch(controllerFrame.hooks.init.pre, frameInitContext, {});
		this.client.hook();
		if (controllerFrame)
			Tap.dispatch(controllerFrame.hooks.init.post, frameInitContext, {});
	}
}
