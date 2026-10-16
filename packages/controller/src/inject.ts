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
	CookieSyncUpdate,
	SerializedCookieSyncEntry,
	TransportToController,
	WebSocketMessage,
} from "./types";

const MessagePort_postMessage = MessagePort.prototype.postMessage;
const EventTarget_addEventListener = EventTarget.prototype.addEventListener;
const postMessage = (
	port: MessagePort,
	data: any,
	transfer?: Transferable[],
) => {
	MessagePort_postMessage.call(port, data, transfer as any);
};

/**
 * A page's copy of the controller's cookie jar. A script's cookie stays pending until the
 * controller has applied it, so a snapshot read before then can't drop it from document.cookie
 */
class CookieMirror {
	private pending = new Set<SerializedCookieSyncEntry>();

	constructor(public jar: CookieJar) {}

	async track(
		entries: SerializedCookieSyncEntry[],
		applied: Promise<unknown>,
	): Promise<undefined> {
		for (const entry of entries) this.pending.add(entry);
		try {
			await applied;
		} finally {
			for (const entry of entries) this.pending.delete(entry);
		}
		return undefined;
	}

	apply(update: CookieSyncUpdate): undefined {
		if (typeof update.snapshot === "string") {
			this.jar.load(update.snapshot);
			for (const { url, cookie } of this.pending) {
				this.jar.setDocumentCookie({ url: new URL(url), cookie });
			}
		} else if (update.options?.clear) {
			this.jar.clear();
		}

		for (const entry of update.cookies ?? []) {
			if (typeof entry?.url !== "string" || typeof entry.cookie !== "string") {
				continue;
			}

			try {
				this.jar.setCookies(entry.cookie, new URL(entry.url));
			} catch {
				console.error("Failed to set cookie", entry);
			}
		}
		return undefined;
	}
}

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
	constructor(
		public port: MessagePort,
		private cookies: CookieMirror,
	) {
		this.rpc = new RpcHelper<ControllerToTransport, TransportToController>(
			{
				ready: async () => {
					this.readyResolve(undefined);
				},
				cookieSync: async (update) => {
					this.cookies.apply(update);
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
		const entries = cookies.map(({ url, cookie }) => ({
			url: url.href,
			cookie,
		}));
		await this.cookies.track(
			entries,
			this.rpc.call("sendSetCookie", { cookies: entries, options }),
		);
		return undefined;
	}

	setCookieReceiver(active: boolean): undefined {
		this.rpc.call("setCookieReceiver", { active }).catch((error) => {
			console.error("Scramjet cookie receiver update failed:", error);
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

type Init = {
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
	) => any;
	codecEncode: (input: string) => string;
	codecDecode: (input: string) => string;
	initHeaders: RawHeaders;
	history: TrackedHistoryState[];
};

export function load(init: Init) {
	if (SCRAMJETCLIENT in globalThis) {
		// the reused window's jar is kept in sync over its transport, so the cookies baked into
		// this document are older than the ones it already has
		((globalThis as any)[SCRAMJETCLIENT] as ScramjetClient).syncDocumentInit({
			initHeaders: init.initHeaders,
			history: init.history,
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
	cookies: CookieMirror;
	cookieJar: CookieJar;
	storage: ScramjetStorageJar | undefined;
	transport: RemoteTransport;
	private rootServiceWorker: Promise<ServiceWorker | null>;
	private handleServiceWorkerMessage: (event: MessageEvent) => unknown;
	private hidden = false;
	// inherited contexts run in this realm, so their own page events stop firing once this page goes
	private dependents = new Set<ExecutionContextWrapper>();

	constructor(
		public global: typeof globalThis,
		public init: Init,
		inherited?: ExecutionContextWrapper,
	) {
		const serviceWorker = this.global.navigator.serviceWorker;
		const nativePostMessage = this.global.ServiceWorker?.prototype.postMessage;
		const initialController = serviceWorker?.controller ?? null;
		const nativeGetRegistration = serviceWorker?.getRegistration;
		this.rootServiceWorker =
			inherited?.rootServiceWorker ??
			Promise.resolve()
				.then(() =>
					nativeGetRegistration?.call(
						serviceWorker,
						new URL("/", this.init.prefix).href,
					),
				)
				.then((registration) => registration?.active ?? initialController)
				.catch((error) => {
					// replaced documents can reject lookup while their captured controller still works
					if (initialController) return initialController;
					throw error;
				});

		// initial blank, document-written and opened windows read the same jar as their parent
		this.cookies = inherited?.cookies ?? new CookieMirror(new CookieJar());
		this.cookieJar = this.cookies.jar;
		if (!inherited) this.cookieJar.load(this.init.cookies);

		const channel = new MessageChannel();
		this.transport = new RemoteTransport(channel.port1, this.cookies);
		this.rootServiceWorker
			.then((worker) => {
				if (worker === null) {
					throw new Error(
						"Scramjet transport requires the root service worker",
					);
				}
				if (!nativePostMessage) {
					throw new Error(
						"Scramjet transport requires service workers in this context",
					);
				}
				nativePostMessage.call(
					worker,
					{
						$sw$initRemoteTransport: {
							port: channel.port2,
							prefix: this.init.prefix.href,
						},
					},
					{ transfer: [channel.port2] },
				);
			})
			.catch((cause) => {
				this.transport.fail(
					cause instanceof Error ? cause : new Error(String(cause)),
				);
			});

		this.storage = this.init.storage
			? new ScramjetStorageJar(this.init.storage, async (mutation) => {
					return await this.transport.sendStorageMutation([mutation]);
				})
			: undefined;

		this.handleServiceWorkerMessage = (event: MessageEvent) => {
			const nativeRequest = event.data?.$scramjet$nativeServiceWorker;
			if (!nativeRequest || typeof nativeRequest !== "object") return;
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
						response.body instanceof ArrayBuffer ? [response.body] : [],
					);
				})
				.catch((error) => {
					postMessage(port, { error: String(error?.message ?? error) });
				});
		};

		if (serviceWorker) {
			// internal messages bypass the site's message-event filtering in every frame
			EventTarget_addEventListener.call(
				serviceWorker,
				"message",
				this.handleServiceWorkerMessage as EventListener,
			);
		}

		// a page that is hidden or gone can't answer, so it stops holding up Set-Cookie
		// responses, and catches up with a snapshot if it is shown again
		inherited?.dependents.add(this);
		const onPageHide = (event: PageTransitionEvent) => {
			if (!event.isTrusted) return;
			// an inherited context that hides without its parent is gone for good
			if (!event.persisted) inherited?.dependents.delete(this);
			this.setHidden(true);
		};
		const onPageShow = (event: PageTransitionEvent) => {
			if (event.isTrusted) this.setHidden(false);
		};
		EventTarget_addEventListener.call(
			this.global,
			"pagehide",
			onPageHide as EventListener,
		);
		EventTarget_addEventListener.call(
			this.global,
			"pageshow",
			onPageShow as EventListener,
		);

		this.injectScramjet();
	}

	private setHidden(hidden: boolean): undefined {
		if (this.hidden === hidden) return undefined;
		this.hidden = hidden;
		this.transport.setCookieReceiver(!hidden);
		for (const dependent of this.dependents) dependent.setHidden(hidden);
		return undefined;
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
				getInjectScripts: this.init.yieldGetInjectScripts(
					this.init.config,
					this.init.sjconfig,
					this.init.prefix,
					this.cookieJar,
					this.storage,
					this.init.codecEncode,
					this.init.codecDecode,
					this.init.storagePartitionKey,
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
					"$controller$swrevive" in data ||
					"$scramjet$nativeServiceWorker" in data ||
					"$sw$initRemoteTransport" in data
				);
			},
			hookSubcontext: (frameself) => {
				const context = new ExecutionContextWrapper(
					frameself,
					{
						...this.init,
						cookies: this.cookieJar.dump(),
						storage: this.storage?.dump() ?? null,
					},
					this,
				);
				return context.client;
			},
			initHeaders: this.init.initHeaders,
			history: this.init.history,
			serviceWorkerHost: this.transport.serviceWorkerHost,
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
