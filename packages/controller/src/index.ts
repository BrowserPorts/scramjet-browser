import { deepmerge } from "@fastify/deepmerge";
import {
	BareResponse,
	type ProxyTransport,
} from "@mercuryworkshop/proxy-transports";
import { type MethodsDefinition, RpcHelper } from "@mercuryworkshop/rpc";
import {
	type CookieStore,
	type CookieSyncOptions,
	type FetchHooks,
	Plugin,
	providers,
	QP,
	REWRITTEN_HEADER,
	rewriteUrl,
	type ScramjetConfig,
	type ScramjetContext,
	ScramjetFetchHandler,
	ScramjetHeaders,
	type ScramjetInterface,
	type ScramjetStorageManager,
	type ServiceWorkerFetchRequestInit,
	defaultConfig as scramjetDefaultConfig,
	setWasm,
	Tap,
	unrewriteUrl,
} from "@mercuryworkshop/scramjet";
import { ServiceWorkerRegistry } from "./serviceworker";
import { CONTROLLERFRAME } from "./symbols";
import type {
	Controllerbound,
	ControllerDetachRequest,
	ControllerDetachResponse,
	ControllerToTransport,
	CookieSyncUpdate,
	FrameErrorHooks,
	FrameInitHooks,
	SerializedCookieSyncEntry,
	SWbound,
	TransferRequest,
	TransferResponse,
	TransportToController,
	WebSocketMessage,
} from "./types";
import { assertRuntimeScramjetVersion } from "./version";

export { assertRuntimeScramjetVersion, VERSION } from "./version";

export type Config = {
	prefix: string;
	scramjetPath: string;
	injectPath: string;
	wasmPath: string;
	virtualWasmPath: string;
	nativeServiceWorkerPath: string;
	codec: Record<"encode" | "decode", (input: string) => string>;
};

export const config: Config = {
	prefix: "/~/sj/",
	scramjetPath: "/scramjet/scramjet.js",
	injectPath: "/controller/controller.inject.js",
	wasmPath: "/scramjet/scramjet.wasm",
	virtualWasmPath: "scramjet.wasm.js",
	nativeServiceWorkerPath: "/controller/controller.native-sw.js",
	codec: {
		encode: (url: string) => {
			if (!url) return url;

			return encodeURIComponent(url);
		},
		decode: (url: string) => {
			if (!url) return url;

			return decodeURIComponent(url);
		},
	},
};

const scramjetConfig: Partial<ScramjetConfig> = {
	flags: {
		...scramjetDefaultConfig.flags,
		allowFailedIntercepts: false,
	},
	maskedfiles: ["inject.js", "scramjet.wasm.js"],
};

type TransportRequestOptions = {
	proxy?: string | null;
};

interface ProxyAwareTransport extends ProxyTransport {
	request(
		...args: [
			...Parameters<ProxyTransport["request"]>,
			options?: TransportRequestOptions,
		]
	): ReturnType<ProxyTransport["request"]>;
	connect(
		...args: [
			...Parameters<ProxyTransport["connect"]>,
			options?: TransportRequestOptions,
		]
	): ReturnType<ProxyTransport["connect"]>;
}

type PersistedCookieState = {
	updatedAt: number;
	cookies: string;
};

export class ManagedPlugin extends Plugin {
	frame: Frame = null!;
	dependencies: string[] = [];
	constructor(name: string, dependencies: string[]) {
		super(name);
		this.dependencies = dependencies;
	}

	install(frame: Frame): undefined {
		this.frame = frame;
		return undefined;
	}
}

const COOKIE_DB_NAME = "__scramjet_controller";
const COOKIE_STORE_NAME = "state";
const BROADCASTCHANNEL_NAME = "__scramjet_controller_channel";
const CONTROLLER_DETACH_TIMEOUT_MS = 5000;
// how long a Set-Cookie response waits for each page to apply the cookie
const COOKIE_SYNC_ACK_TIMEOUT_MS = 1000;

type TransportChannel = {
	port: MessagePort;
	rpc: RpcHelper<TransportToController, ControllerToTransport>;
	/** Cleared while the page is hidden or gone */
	receivesCookies: boolean;
	/** Set when the page misses a deadline; it gets no updates until it answers, then a snapshot */
	behind: boolean;
	unsubscribe?: () => unknown;
};

let cookieDbPromise: Promise<IDBDatabase> | null = null;

function parsePersistedCookieState(
	value: unknown,
): PersistedCookieState | null {
	if (value === undefined) {
		return null;
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!Number.isSafeInteger((value as PersistedCookieState).updatedAt) ||
		(value as PersistedCookieState).updatedAt < 0 ||
		typeof (value as PersistedCookieState).cookies !== "string"
	) {
		throw new Error("Persisted Scramjet cookie state was malformed");
	}

	return value as PersistedCookieState;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

function transactionToPromise(transaction: IDBTransaction): Promise<undefined> {
	return new Promise<undefined>((resolve, reject) => {
		transaction.oncomplete = () => resolve(undefined);
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
	});
}

function openCookieDatabase(): Promise<IDBDatabase> {
	if (cookieDbPromise) {
		return cookieDbPromise;
	}

	cookieDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(COOKIE_DB_NAME, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(COOKIE_STORE_NAME)) {
				db.createObjectStore(COOKIE_STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("Failed to open cookie database"));
	});

	return cookieDbPromise;
}

async function readCookieState(
	storagePartitionKey: string,
): Promise<PersistedCookieState | null> {
	const db = await openCookieDatabase();
	const transaction = db.transaction(COOKIE_STORE_NAME, "readonly");
	const store = transaction.objectStore(COOKIE_STORE_NAME);
	const completion = transactionToPromise(transaction);
	const value = await requestToPromise(store.get(storagePartitionKey));
	await completion;
	return parsePersistedCookieState(value);
}

async function writeCookieState(
	storagePartitionKey: string,
	cookies: string,
	currentUpdatedAt: number,
): Promise<number> {
	const db = await openCookieDatabase();
	const transaction = db.transaction(COOKIE_STORE_NAME, "readwrite");
	const store = transaction.objectStore(COOKIE_STORE_NAME);
	const completion = transactionToPromise(transaction);
	const existing = parsePersistedCookieState(
		await requestToPromise(store.get(storagePartitionKey)),
	);
	const updatedAt = Math.max(currentUpdatedAt, existing?.updatedAt ?? 0) + 1;
	if (!Number.isSafeInteger(updatedAt)) {
		throw new Error("Persisted Scramjet cookie sequence was exhausted");
	}
	const state: PersistedCookieState = {
		updatedAt,
		cookies,
	};
	await requestToPromise(store.put(state, storagePartitionKey));
	await completion;
	return updatedAt;
}

function makeId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

function syncFrameName(element: HTMLIFrameElement) {
	const frameWindow = element.contentWindow;
	if (
		!element.name ||
		frameWindow === null ||
		frameWindow.name === element.name
	) {
		return;
	}
	try {
		frameWindow.name = element.name;
	} catch {
		// A detached or replaced browsing context may reject the write.
	}
}

const deepMerge = deepmerge();

export type ControllerInit = {
	serviceworker: ServiceWorker;
	transport: ProxyTransport;
	storagePartitionKey: string;
	cookieJar?: CookieStore;
	storage?: ScramjetStorageManager;
	resolveProxy?: (url: URL) => Promise<string | null> | string | null;
	config?: Partial<Config>;
	scramjetConfig?: Partial<ScramjetConfig>;
};

type FrameOptions = {
	plugins?: ManagedPlugin[];
};

// the emulated service worker realm is a worker whose script url carries the
// scope it was spawned for, which is what tells its traffic apart from a page's
function isServiceWorkerRealmRequest(data: TransferRequest): boolean {
	if (!data.rawClientUrl) return false;
	try {
		return new URL(data.rawClientUrl).searchParams.has(QP.swScope);
	} catch {
		return false;
	}
}

export class Controller {
	id: string;
	config: Config;
	scramjetConfig: ScramjetConfig;
	prefix: string;
	frames: Frame[] = [];
	serviceWorkerController: ServiceWorker;
	guardServiceWorkerRevive = true;

	private ready: Promise<undefined>;
	private readyResolve: ((value: undefined) => unknown) | null = null;
	private serviceWorkerReadyResolve: (() => unknown) | null = null;
	public isReady: boolean = false;
	rpc: RpcHelper<Controllerbound, SWbound>;
	private port: MessagePort | null = null;

	transport: ProxyTransport;
	storage: ScramjetStorageManager | undefined;
	private resolvedCookieStore: CookieStore | undefined;
	private cookieUpdatedAt = 0;
	private cookieSyncPromise: Promise<undefined> | null = null;
	private cookieSyncDirty = true;
	private cookieSyncChannel: BroadcastChannel;
	private closed = false;
	private detached = false;
	private closing: Promise<undefined> | null = null;
	private serviceWorkerReviveGuardTimer: ReturnType<typeof setTimeout> | null =
		null;
	private serviceWorkerReconnectPromise: Promise<undefined> | null = null;
	private transportChannels = new Set<TransportChannel>();

	private wasmAlreadyFetched = false;
	private wasmPayload: string | null = null;
	private onTabChannelMessage = (e: MessageEvent) => {
		this.rpc.recieve(e.data);
	};
	private onCookieSyncMessage = (event: MessageEvent) => {
		const updatedAt =
			typeof event.data === "object" && event.data !== null
				? (event.data as { updatedAt?: unknown }).updatedAt
				: undefined;
		if (
			typeof updatedAt !== "number" ||
			!Number.isSafeInteger(updatedAt) ||
			updatedAt < 0 ||
			updatedAt <= this.cookieUpdatedAt
		) {
			return;
		}

		this.cookieSyncDirty = true;
		this.loadSavedCookies().catch((error) => {
			this.cookieSyncDirty = true;
			console.error("Scramjet cookie synchronization failed:", error);
		});
	};
	private onServiceWorkerMessage = async (event: MessageEvent) => {
		if (this.closed || this.closing) return;

		if (event.data?.$controller$swrevive) {
			// if we just spawned the service worker, it will send this even though it's not actually dead
			// TODO: pretty jank, fix at some point
			if (this.guardServiceWorkerRevive) {
				return;
			}
			this.reconnectServiceWorker().catch((error) => {
				console.error("Scramjet Controller reconnection failed:", error);
			});
		}
	};

	private async loadScramjetWasm() {
		if (this.wasmAlreadyFetched) {
			return;
		}

		const resp = await fetch(this.config.wasmPath);
		setWasm(await resp.arrayBuffer());
		this.wasmAlreadyFetched = true;
	}

	private methods: MethodsDefinition<Controllerbound> = {
		ready: async () => {
			const readyResolve = this.readyResolve;
			const serviceWorkerReadyResolve = this.serviceWorkerReadyResolve;
			if (serviceWorkerReadyResolve === null) {
				throw new Error(
					"Scramjet Controller received an unexpected ready acknowledgement",
				);
			}
			this.serviceWorkerReadyResolve = null;
			if (readyResolve !== null) {
				this.readyResolve = null;
				readyResolve(undefined);
			}
			serviceWorkerReadyResolve();
			if (this.serviceWorkerReviveGuardTimer !== null) {
				clearTimeout(this.serviceWorkerReviveGuardTimer);
			}
			this.serviceWorkerReviveGuardTimer = setTimeout(() => {
				this.guardServiceWorkerRevive = false;
				this.serviceWorkerReviveGuardTimer = null;
			}, 5000);
		},
		request: async (data) => {
			const path = new URL(data.rawUrl).pathname;
			const frame = this.frames.find((f) => path.startsWith(f.prefix));
			if (!frame) throw new Error("No frame found for request");
			try {
				// doesn't actually *load* every request, but hold up requests until the promise finishes
				await this.loadSavedCookies();

				if (path === frame.prefix + this.config.virtualWasmPath) {
					if (!this.wasmPayload) {
						const resp = await fetch(this.config.wasmPath);
						const buf = await resp.arrayBuffer();
						const b64 = btoa(
							new Uint8Array(buf)
								.reduce(
									(data, byte) => (data.push(String.fromCharCode(byte)), data),
									[] as any,
								)
								.join(""),
						);

						this.wasmPayload = `self.WASM = '${b64}';`;
					}

					return [
						{
							body: this.wasmPayload,
							status: 200,
							statusText: "OK",
							headers: [["Content-Type", "application/javascript"]],
						},
						[],
					];
				}

				// the virtual wasm payload isn't a site url, so an emulated worker only
				// gets a say once that's been ruled out
				const intercepted = await this.routeThroughServiceWorker(frame, data);
				if (intercepted) return intercepted;

				const sjheaders = ScramjetHeaders.fromRawHeaders(data.initialHeaders);

				const fetchresponse = await frame.fetchHandler.handleFetch({
					initialHeaders: sjheaders,
					rawClientUrl: data.rawClientUrl
						? new URL(data.rawClientUrl)
						: undefined,
					rawUrl: new URL(data.rawUrl),
					rawReferrer: data.rawReferrer,
					rawDestination: data.destination,
					method: data.method,
					mode: data.mode,
					referrer: data.referrer,
					body: data.body,
					cache: data.cache,
					clientId: data.clientId ?? "",
					...(data.sourceClientId === undefined
						? {}
						: { sourceClientId: data.sourceClientId }),
					...(data.resultingClientId === undefined
						? {}
						: { resultingClientId: data.resultingClientId }),
				});

				// only an emulated service worker realm has any use for the marker,
				// and it reads native headers, so nothing else should ever see it
				if (!isServiceWorkerRealmRequest(data)) {
					fetchresponse.headers.delete(REWRITTEN_HEADER);
				}

				return [
					{
						body: fetchresponse.body,
						status: fetchresponse.status,
						statusText: fetchresponse.statusText,
						headers: fetchresponse.headers.toRawHeaders(),
					},
					fetchresponse.body instanceof ReadableStream ||
					fetchresponse.body instanceof ArrayBuffer
						? [fetchresponse.body]
						: [],
				];
			} catch (e) {
				const reqcontext: typeof frame.hooks.error.request.context = {
					rawrequest: data,
					error: e,
				};
				const reqprops: typeof frame.hooks.error.request.props = {
					setResponse: undefined,
					suppressError: false,
				};
				await Tap.dispatch(frame.hooks.error.request, reqcontext, reqprops);
				if (!reqprops.suppressError) {
					console.error("Error in controller request handler:", e);
				}
				if (reqprops.setResponse) {
					return [reqprops.setResponse, []];
				}
				throw e;
			}
		},
		initRemoteTransport: async ({ port, prefix }) => {
			// cookies saved by another tab belong in this page's first snapshot
			await this.loadSavedCookies().catch((error) => {
				console.error("Scramjet cookie synchronization failed:", error);
			});
			if (this.closed || this.closing) {
				port.close();
				return;
			}
			const pathname = new URL(prefix, location.href).pathname;
			const frameForChannel = () => {
				const frame = this.frames.find((f) => pathname.startsWith(f.prefix));
				if (!frame) throw new Error("no frame owns this transport channel");
				return frame;
			};
			const registry = () => frameForChannel().serviceWorkers;

			// the page owns at most one container at a time; a reload replaces it
			let detachPage: (() => unknown) | undefined;

			const rpc = new RpcHelper<TransportToController, ControllerToTransport>(
				{
					nativeServiceWorkerRequest: async (metadata) => {
						const frame = frameForChannel();
						const request = metadata.request;
						const fetchRequest = {
							initialHeaders: ScramjetHeaders.fromRawHeaders(
								request.initialHeaders,
							),
							rawClientUrl: request.rawClientUrl
								? new URL(request.rawClientUrl)
								: undefined,
							rawUrl: new URL(request.rawUrl),
							rawReferrer: request.rawReferrer,
							rawDestination: request.destination,
							method: request.method,
							mode: request.mode,
							referrer: request.referrer,
							body: request.body,
							cache: request.cache,
							clientId: request.clientId ?? "",
							...(request.sourceClientId === undefined
								? {}
								: { sourceClientId: request.sourceClientId }),
							...(request.resultingClientId === undefined
								? {}
								: { resultingClientId: request.resultingClientId }),
						};
						const result =
							metadata.kind === "request"
								? await frame.fetchHandler.handleFetch(fetchRequest)
								: await frame.fetchHandler.handleServiceWorkerResponse(
										fetchRequest,
										BareResponse.fromNativeResponse(
											new Response(metadata.response.body, {
												status: metadata.response.status,
												statusText: metadata.response.statusText,
												headers: metadata.response.headers,
											}),
										),
									);
						result.headers.delete(REWRITTEN_HEADER);
						return [
							{
								body: result.body,
								status: result.status,
								statusText: result.statusText,
								headers: result.headers.toRawHeaders(),
							},
							result.body instanceof ArrayBuffer ||
							result.body instanceof ReadableStream
								? [result.body]
								: [],
						];
					},
					swRegister: async (options) => [
						await registry().register(options),
						[],
					],
					swGetRegistrations: async ({ clientUrl }) => [
						await registry().getRegistrations(clientUrl),
						[],
					],
					swGetController: async ({ clientUrl }) => [
						await registry().getController(clientUrl),
						[],
					],
					swUnregister: async ({ id }) => [await registry().unregister(id), []],
					swUpdate: async ({ id }) => [await registry().update(id), []],
					swPostMessage: async ({ id, data, ports, clientUrl }) => {
						await registry().postMessage(id, data, ports, clientUrl);
					},
					swAttachClient: async ({ clientUrl }) => {
						detachPage?.();
						detachPage = registry().attachPage({
							clientUrl,
							openWindow: (url) => rpc.call("swOpenWindow", { url }, []),
							focus: async () => {
								await rpc.call("swFocus", {}, []);
								return undefined;
							},
							navigate: (url) => rpc.call("swNavigate", { url }, []),
							showNotification: async (title, options) => {
								await rpc.call("swShowNotification", { title, options }, []);
								return undefined;
							},
						});
					},
					request: async ({ remote, method, body, headers, proxy }) => {
						const transport = this.transport as ProxyAwareTransport;
						const url = new URL(remote);
						const response = await transport.request(
							url,
							method,
							body,
							headers,
							undefined,
							{
								proxy: proxy ?? (await this.init.resolveProxy?.(url)) ?? null,
							},
						);
						return [response, [response.body]];
					},
					sendSetCookie: async ({ cookies, options }) => {
						await this.loadSavedCookies(true);
						if (options?.clear) {
							await this.cookieJar.clear();
						}
						await this.applyCookieSyncEntries(cookies, options);
						await this.persistCookies();
						await this.propagateCookieSync(cookies, options);
					},
					sendStorageMutation: async ({ mutations }) => {
						const applyMutation = this.storage?.applyMutation;
						if (!applyMutation) {
							throw new Error(
								"Scramjet storage mutation requires a configured storage partition",
							);
						}
						await applyMutation.call(this.storage, mutations);
					},
					setCookieReceiver: async ({ active }) => {
						channel.receivesCookies = active;
						channel.behind = false;
						// a page shown again missed every update while it was hidden
						if (active) this.sendCookieSnapshot(channel);
					},
					connect: async ({ url, protocols, requestHeaders, port, proxy }) => {
						let resolve: (arg: TransportToController["connect"][1]) => unknown;
						const promise = new Promise<TransportToController["connect"][1]>(
							(res) => (resolve = res),
						);
						const transport = this.transport as ProxyAwareTransport;
						const remote = new URL(url);
						const [send, close] = transport.connect(
							remote,
							protocols,
							requestHeaders,
							(protocol, extensions) => {
								resolve({
									result: "success",
									protocol: protocol,
									extensions: extensions,
								});
							},
							(data) => {
								port.postMessage(
									{
										type: "data",
										data: data,
									} as WebSocketMessage,
									data instanceof ArrayBuffer ? [data] : [],
								);
							},
							(close, reason) => {
								port.postMessage({
									type: "close",
									code: close,
									reason: reason,
								} as WebSocketMessage);
							},
							(error) => {
								resolve({
									result: "failure",
									error: error,
								});
							},
							{
								proxy:
									proxy ?? (await this.init.resolveProxy?.(remote)) ?? null,
							},
						);
						port.onmessageerror = (ev) => {
							console.error(
								"Transport port messageerror (this should never happen!)",
								ev,
							);
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
				},
				"transport",
				(data, transfer) => port.postMessage(data, transfer),
			);
			const channel: TransportChannel = {
				port,
				rpc,
				receivesCookies: true,
				behind: false,
			};
			this.transportChannels.add(channel);
			port.onmessageerror = (ev) => {
				console.error(
					"Transport port messageerror (this should never happen!)",
					ev,
				);
			};
			port.onmessage = (e) => {
				rpc.recieve(e.data);
			};

			try {
				channel.unsubscribe = registry().subscribe((event) => {
					rpc
						.call("swEvent", event, event.type === "message" ? event.ports : [])
						.catch(() => {
							// the page is gone, nothing to deliver to
						});
				});
			} catch {
				// no frame owns this channel, so there's no service worker state to
				// report to it
			}

			rpc.call("ready", undefined, []);
			// the jar is read in the task that starts the port, so every cookie the page wrote
			// before connecting is applied after this snapshot, and the page keeps it
			this.sendCookieSnapshot(channel);
		},
	};

	constructor(public init: ControllerInit) {
		if (
			typeof init.storagePartitionKey !== "string" ||
			init.storagePartitionKey.length === 0
		) {
			throw new Error(
				"Scramjet Controller requires a non-empty storage partition key",
			);
		}
		assertRuntimeScramjetVersion();
		this.id = makeId();
		this.config = deepMerge(config, init.config || {}) as Config;
		this.scramjetConfig = deepMerge(scramjetConfig, scramjetDefaultConfig);
		this.scramjetConfig = deepMerge(
			this.scramjetConfig,
			init.scramjetConfig || {},
		) as ScramjetConfig;
		this.prefix = this.config.prefix + this.id + "/";
		this.serviceWorkerController = init.serviceworker;
		this.resolvedCookieStore = init.cookieJar;
		this.storage = init.storage;
		this.cookieSyncChannel = new BroadcastChannel(
			`${BROADCASTCHANNEL_NAME}:${encodeURIComponent(init.storagePartitionKey)}`,
		);

		this.ready = Promise.all([
			new Promise<undefined>((resolve) => {
				this.readyResolve = resolve;
			}),
			this.loadScramjetWasm(),
			this.loadSavedCookies(true),
		]).then(() => {
			if (this.closed || this.closing) {
				throw new Error("Scramjet Controller closed before becoming ready");
			}
			this.isReady = true;
			return undefined;
		});

		this.rpc = new RpcHelper<Controllerbound, SWbound>(
			this.methods,
			"tabchannel-" + this.id,
			(data, transfer) => {
				if (!this.port) {
					throw new Error("Port not found");
				}
				this.port.postMessage(data, transfer);
			},
		);
		this.transport = init.transport;

		this.cookieSyncChannel.addEventListener(
			"message",
			this.onCookieSyncMessage,
		);
		this.setupMessagePort();

		navigator.serviceWorker.addEventListener(
			"message",
			this.onServiceWorkerMessage,
		);
	}

	// hand the request to the frame's emulated service worker, if one controls
	// the client that made it. returns undefined when nothing intercepted it and
	// the normal pipeline should run
	private async routeThroughServiceWorker(
		frame: Frame,
		data: TransferRequest,
	): Promise<[TransferResponse, Transferable[]] | undefined> {
		// a worker never sees the request for its own script, and requests the
		// realm itself makes go straight to the network
		if (data.destination === "serviceworker") return undefined;

		const rawUrl = new URL(data.rawUrl);
		if (rawUrl.searchParams.has(QP.swScope)) return undefined;

		const clientUrl = data.rawClientUrl
			? unrewriteUrl(data.rawClientUrl, frame.context)
			: undefined;
		if (
			data.rawClientUrl &&
			new URL(data.rawClientUrl).searchParams.has(QP.swScope)
		) {
			return undefined;
		}

		const url = unrewriteUrl(rawUrl, frame.context);
		// an embedder registration (`launchEmbedder`) may own the extension
		// scheme; rewriteUrl never encodes those urls, so the logical url routes
		// as-is and the registry's controllee owner decides
		if (
			!url.startsWith("http:") &&
			!url.startsWith("https:") &&
			!url.startsWith("chrome-extension:")
		) {
			return undefined;
		}

		const isNavigation =
			data.destination === "document" || data.destination === "iframe";
		const sourceClientId = data.sourceClientId ?? data.clientId ?? "";
		const resultingClientId = data.resultingClientId ?? data.clientId ?? "";
		if (clientUrl) {
			frame.serviceWorkers.noteClient(sourceClientId, clientUrl);
		} else if (isNavigation) {
			// a navigation reports the id the document will have once it loads, and
			// it's the only chance to learn about a client before it asks for
			// anything - which is what clients.claim() needs
			frame.serviceWorkers.noteClient(resultingClientId, url);
		}

		// reading the body is destructive, so don't touch it until a registration
		// that would actually see this request has been found
		if (!(await frame.serviceWorkers.wouldRoute(url, clientUrl))) {
			return undefined;
		}

		if (data.body instanceof ReadableStream) {
			// hand the same bytes to whichever side ends up sending them
			data.body = await new Response(data.body).arrayBuffer();
		}

		const init: ServiceWorkerFetchRequestInit = {
			url,
			method: data.method,
			headers: data.initialHeaders,
			body: data.body instanceof ArrayBuffer ? data.body : null,
			destination: data.destination as RequestDestination,
			mode: data.mode,
			credentials: "same-origin",
			cache: data.cache,
			redirect: "follow",
			referrer: data.referrer,
			referrerPolicy: "",
			integrity: "",
			keepalive: false,
			isReloadNavigation: false,
			isHistoryNavigation: false,
			clientId: sourceClientId,
			resultingClientId,
		};

		const result = await frame.serviceWorkers.routeFetch(init, clientUrl);
		if (!result.handled) return undefined;

		if (result.error || !result.response) {
			// a handler that threw or resolved to nothing is a network error
			return [
				{
					body: "",
					status: 0,
					statusText: "",
					headers: [],
				},
				[],
			];
		}

		const response = result.response;

		if (response.rewritten) {
			return [
				{
					body: response.body ?? "",
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				},
				response.body instanceof ReadableStream ||
				response.body instanceof ArrayBuffer
					? [response.body]
					: [],
			];
		}

		const rewritten = await frame.fetchHandler.handleServiceWorkerResponse(
			{
				initialHeaders: ScramjetHeaders.fromRawHeaders(data.initialHeaders),
				rawClientUrl: data.rawClientUrl
					? new URL(data.rawClientUrl)
					: undefined,
				rawUrl,
				rawReferrer: data.rawReferrer,
				rawDestination: data.destination,
				method: data.method,
				mode: data.mode,
				referrer: data.referrer,
				body: null,
				cache: data.cache,
				clientId: data.clientId ?? "",
			},
			BareResponse.fromNativeResponse(
				new Response(response.body, {
					status: response.status === 0 ? 200 : response.status,
					statusText: response.statusText,
					headers: response.headers,
				}),
			),
		);

		// this response is on its way to a page, never to a realm
		rewritten.headers.delete(REWRITTEN_HEADER);

		return [
			{
				body: rewritten.body,
				status: rewritten.status,
				statusText: rewritten.statusText,
				headers: rewritten.headers.toRawHeaders(),
			},
			rewritten.body instanceof ReadableStream ||
			rewritten.body instanceof ArrayBuffer
				? [rewritten.body]
				: [],
		];
	}

	private setupMessagePort(): Promise<undefined> {
		if (this.closed || this.closing) {
			throw new Error("Scramjet Controller is closed");
		}
		if (this.port) {
			this.port.removeEventListener("message", this.onTabChannelMessage);
			try {
				this.port.close();
			} catch {
				// ignore
			}
			this.port = null;
		}

		const channel = new MessageChannel();
		this.port = channel.port1;
		this.port.addEventListener("message", this.onTabChannelMessage);
		this.port.start();

		this.serviceWorkerController.postMessage(
			{
				$controller$init: {
					prefix: this.prefix,
					id: this.id,
				},
			},
			[channel.port2],
		);

		return new Promise<undefined>((resolve) => {
			this.serviceWorkerReadyResolve = () => {
				resolve(undefined);
				return undefined;
			};
		});
	}

	private async reconnectServiceWorker(): Promise<undefined> {
		if (this.serviceWorkerReconnectPromise !== null) {
			return this.serviceWorkerReconnectPromise;
		}
		this.isReady = false;
		const reconnectPromise = (async () => {
			await this.setupMessagePort();
			if (this.closed || this.closing) {
				throw new Error("Scramjet Controller closed during reconnection");
			}
			this.isReady = true;
			return undefined;
		})();
		this.serviceWorkerReconnectPromise = reconnectPromise;
		try {
			return await reconnectPromise;
		} finally {
			if (this.serviceWorkerReconnectPromise === reconnectPromise) {
				this.serviceWorkerReconnectPromise = null;
			}
		}
	}

	refreshServiceWorkerConnection(): Promise<undefined> {
		return this.reconnectServiceWorker();
	}

	private detachFromServiceWorker(): Promise<undefined> {
		return new Promise<undefined>((resolve, reject) => {
			const channel = new MessageChannel();
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				channel.port1.onmessage = null;
				channel.port1.onmessageerror = null;
				channel.port1.close();
				if (error) {
					reject(error);
					return;
				}
				resolve(undefined);
			};
			const timeout = setTimeout(() => {
				finish(new Error("Scramjet Controller detach was not acknowledged"));
			}, CONTROLLER_DETACH_TIMEOUT_MS);

			channel.port1.onmessage = (event: MessageEvent) => {
				const response = event.data?.$controller$detached as
					| Partial<ControllerDetachResponse>
					| undefined;
				if (response?.id !== this.id || response.detached !== true) {
					finish(new Error("Scramjet Controller detach was not acknowledged"));
					return;
				}
				finish();
			};
			channel.port1.onmessageerror = () => {
				finish(new Error("Scramjet Controller detach acknowledgement failed"));
			};

			const request: ControllerDetachRequest = { id: this.id };
			try {
				this.serviceWorkerController.postMessage(
					{ $controller$detach: request },
					[channel.port2],
				);
			} catch (error) {
				finish(
					error instanceof Error
						? error
						: new Error("Scramjet Controller detach request failed"),
				);
			}
		});
	}

	private async closeLocalResources(): Promise<undefined> {
		const failures: unknown[] = [];
		const remainingFrames: Frame[] = [];
		for (const frame of this.frames) {
			let frameFailed = false;
			try {
				await frame.serviceWorkers.close();
			} catch (error) {
				failures.push(error);
				frameFailed = true;
			}
			try {
				if (frame.element[CONTROLLERFRAME] === frame) {
					frame.element.removeAttribute("srcdoc");
					frame.element.src = "about:blank";
					delete frame.element[CONTROLLERFRAME];
				}
			} catch (error) {
				failures.push(error);
				frameFailed = true;
			}
			if (frameFailed) remainingFrames.push(frame);
		}
		this.frames = remainingFrames;

		const channelError = new Error("Scramjet Controller closed");
		for (const channel of this.transportChannels) {
			this.closeTransportChannel(channel, channelError);
		}

		for (const callback of this.rpc.promiseCallbacks.values()) {
			callback.reject(channelError);
		}
		this.rpc.promiseCallbacks.clear();
		if (this.port) {
			this.port.removeEventListener("message", this.onTabChannelMessage);
			try {
				this.port.close();
			} catch {
				// the channel was already closed
			}
			this.port = null;
		}

		this.cookieSyncChannel.removeEventListener(
			"message",
			this.onCookieSyncMessage,
		);
		this.cookieSyncChannel.close();
		navigator.serviceWorker.removeEventListener(
			"message",
			this.onServiceWorkerMessage,
		);
		if (this.serviceWorkerReviveGuardTimer !== null) {
			clearTimeout(this.serviceWorkerReviveGuardTimer);
			this.serviceWorkerReviveGuardTimer = null;
		}

		if (failures.length > 0) {
			throw new AggregateError(
				failures,
				"Scramjet Controller frame teardown failed",
			);
		}
		return undefined;
	}

	private async closeController(): Promise<undefined> {
		if (!this.detached) {
			await this.detachFromServiceWorker();
			this.detached = true;
		}
		await this.closeLocalResources();
		return undefined;
	}

	close(): Promise<undefined> {
		if (this.closed) return Promise.resolve(undefined);
		if (this.closing) return this.closing;

		this.isReady = false;
		this.closing = this.closeController()
			.then(() => {
				this.closed = true;
				return undefined;
			})
			.finally(() => {
				this.closing = null;
			});
		return this.closing;
	}

	// TODO: should this be a method on the cookie jar?
	private async applyCookieSyncEntries(
		cookies: SerializedCookieSyncEntry[] | undefined,
		options: CookieSyncOptions = {},
	): Promise<undefined> {
		if (!Array.isArray(cookies)) {
			return undefined;
		}

		for (const entry of cookies) {
			if (typeof entry?.url !== "string" || typeof entry.cookie !== "string") {
				continue;
			}

			await this.cookieJar.setCookies(
				entry.cookie,
				new URL(entry.url),
				options.destination === undefined,
			);
		}
		return undefined;
	}

	async propagateCookieSync(
		cookies: SerializedCookieSyncEntry[],
		options: CookieSyncOptions = {},
	): Promise<undefined> {
		const update: CookieSyncUpdate = { cookies, options };
		await Promise.all(
			Array.from(this.transportChannels, (channel) =>
				this.deliverCookieSync(channel, update),
			),
		);
		return undefined;
	}

	private sendCookieSnapshot(channel: TransportChannel): undefined {
		this.deliverCookieSync(channel, { snapshot: this.cookieJar.dump() });
		return undefined;
	}

	/**
	 * Resolves once the page has applied the update, or once it misses the deadline. Never
	 * rejects, so a busy or departed page can't fail or stall the response that set the cookie
	 */
	private async deliverCookieSync(
		channel: TransportChannel,
		update: CookieSyncUpdate,
	): Promise<undefined> {
		if (!channel.receivesCookies || channel.behind) return undefined;
		const delivered = channel.rpc.call("cookieSync", update).then(
			() => true,
			() => true,
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), COOKIE_SYNC_ACK_TIMEOUT_MS);
		});
		const acknowledged = await Promise.race([delivered, deadline]);
		clearTimeout(timer);
		if (acknowledged) return undefined;

		// stop queueing updates for a page that isn't answering, and resync it once it does
		channel.behind = true;
		delivered.then(() => {
			if (!channel.behind || !this.transportChannels.has(channel)) return;
			channel.behind = false;
			this.sendCookieSnapshot(channel);
		});
		return undefined;
	}

	private closeTransportChannel(
		channel: TransportChannel,
		error: Error,
	): undefined {
		this.transportChannels.delete(channel);
		channel.unsubscribe?.();
		for (const callback of channel.rpc.promiseCallbacks.values()) {
			callback.reject(error);
		}
		channel.rpc.promiseCallbacks.clear();
		channel.port.onmessage = null;
		channel.port.onmessageerror = null;
		try {
			channel.port.close();
		} catch {
			// the channel was already closed
		}
		return undefined;
	}

	private async loadSavedCookies(force = false): Promise<undefined> {
		if (!force && !this.cookieSyncDirty) {
			return undefined;
		}

		if (this.cookieSyncPromise) {
			return this.cookieSyncPromise;
		}

		this.cookieSyncPromise = (async (): Promise<undefined> => {
			if (!this.cookieJar.ownsPersistence) {
				this.cookieSyncDirty = false;
				return undefined;
			}
			const persisted = await readCookieState(this.init.storagePartitionKey);
			if (persisted && persisted.updatedAt > this.cookieUpdatedAt) {
				this.cookieJar.load(persisted.cookies);
				this.cookieUpdatedAt = persisted.updatedAt;
			}
			this.cookieSyncDirty = false;
			return undefined;
		})().finally(() => {
			this.cookieSyncPromise = null;
		});

		return this.cookieSyncPromise;
	}

	async persistCookies(): Promise<undefined> {
		if (!this.cookieJar.ownsPersistence) {
			return undefined;
		}
		const updatedAt = await writeCookieState(
			this.init.storagePartitionKey,
			this.cookieJar.dump(),
			this.cookieUpdatedAt,
		);
		if (updatedAt <= this.cookieUpdatedAt) {
			return undefined;
		}

		this.cookieUpdatedAt = updatedAt;
		this.cookieSyncDirty = false;
		this.cookieSyncChannel.postMessage({
			updatedAt,
		});
		return undefined;
	}

	get cookieJar(): CookieStore {
		const existing = this.resolvedCookieStore;
		if (existing !== undefined) {
			return existing;
		}
		const created = providers().createCookieStore();
		this.resolvedCookieStore = created;
		return created;
	}

	setTransport(transport: ProxyTransport) {
		this.transport = transport;
		for (const frame of this.frames) {
			frame.controller.transport = transport;
			frame.fetchHandler.client.transport = transport;
		}
	}

	createFrame(element?: HTMLIFrameElement, options: FrameOptions = {}): Frame {
		if (this.closed || this.closing) {
			throw new Error("Scramjet Controller is closed");
		}
		if (!this.isReady) {
			throw new Error(
				"Controller is not ready! Try awaiting controller.wait()",
			);
		}
		element ??= document.createElement("iframe");
		const frame = new Frame(this, element, options);
		this.frames.push(frame);
		return frame;
	}

	async wait(): Promise<undefined> {
		if (this.closed || this.closing) {
			throw new Error("Scramjet Controller is closed");
		}
		await this.ready;
		if (this.closed || this.closing) {
			throw new Error("Scramjet Controller is closed");
		}
		return undefined;
	}
}

function base64Encode(text: string) {
	return btoa(
		new TextEncoder()
			.encode(text)
			.reduce(
				(data, byte) => (data.push(String.fromCharCode(byte)), data),
				[] as any,
			)
			.join(""),
	);
}

function yieldGetInjectScripts(
	config: Config,
	sjconfig: ScramjetConfig,
	prefix: URL,
	cookieJar: CookieStore,
	storage: ScramjetStorageManager | undefined,
	codecEncode: (input: string) => string,
	codecDecode: (input: string) => string,
	storagePartitionKey: string,
) {
	const getInjectScripts: ScramjetInterface["getInjectScripts"] = (
		meta,
		handler,
		htmlcontext,
		script,
	) => {
		function base64Encode(text: string) {
			return btoa(
				new TextEncoder()
					.encode(text)
					.reduce(
						(data, byte) => (data.push(String.fromCharCode(byte)), data),
						[] as any,
					)
					.join(""),
			);
		}
		return [
			script(config.scramjetPath),
			script(prefix.href + config.virtualWasmPath),
			script(config.injectPath),
			script(
				"data:text/javascript;charset=utf-8;base64," +
					base64Encode(`
					document.querySelectorAll("script[scramjet-injected]").forEach(script => script.remove());
					$scramjetController.load({
						config: ${JSON.stringify(config)},
						sjconfig: ${JSON.stringify(sjconfig)},
						prefix: new URL("${prefix.href}"),
						cookies: ${JSON.stringify(cookieJar.dump())},
						storage: ${JSON.stringify(storage?.dump?.() ?? null)},
						storagePartitionKey: ${JSON.stringify(storagePartitionKey)},
						yieldGetInjectScripts: ${yieldGetInjectScripts.toString()},
						codecEncode: ${codecEncode.toString()},
						codecDecode: ${codecDecode.toString()},
						initHeaders: ${JSON.stringify(htmlcontext.headers ?? [])},
						history: ${JSON.stringify(htmlcontext.history ?? [])},
					})
				`),
			),
		];
	};
	return getInjectScripts;
}

export class Frame {
	id: string;
	prefix: string;
	fetchHandler: ScramjetFetchHandler;
	serviceWorkers: ServiceWorkerRegistry;
	hooks: {
		fetch: FetchHooks;
		init: FrameInitHooks;
		error: FrameErrorHooks;
	};

	get context(): ScramjetContext {
		return {
			config: this.controller.scramjetConfig,
			prefix: new URL(this.prefix, location.href),
			cookieJar: this.controller.cookieJar,
			storage: this.controller.storage,
			storagePartitionKey: this.controller.init.storagePartitionKey,
			interface: {
				getInjectScripts: yieldGetInjectScripts(
					this.controller.config,
					this.controller.scramjetConfig,
					new URL(this.prefix, location.href),
					this.controller.cookieJar,
					this.controller.storage,
					this.controller.config.codec.encode,
					this.controller.config.codec.decode,
					this.controller.init.storagePartitionKey,
				),
				getWorkerInjectScripts: (meta, type, script) => {
					let str = "";

					str += script(this.controller.config.scramjetPath);
					str += script(this.prefix + this.controller.config.virtualWasmPath);
					str += script(
						"data:text/javascript;charset=utf-8;base64," +
							base64Encode(`
					(()=>{
						const { ScramjetClient, CookieJar, ScramjetStorageJar, setWasm } = $scramjet;

						setWasm(Uint8Array.from(atob(self.WASM), (c) => c.charCodeAt(0)));
						delete self.WASM;

						const sjconfig = ${JSON.stringify(this.controller.scramjetConfig)};
						const prefix = new URL("${this.prefix}", location.href);
						const cookieJar = new CookieJar();
						cookieJar.load(${JSON.stringify(this.controller.cookieJar.dump())});
						const storageState = ${JSON.stringify(this.controller.storage?.dump?.() ?? null)};
						const storage = storageState ? new ScramjetStorageJar(storageState) : undefined;

						const context = {
							config: sjconfig,
							prefix,
							cookieJar,
							storage,
							storagePartitionKey: ${JSON.stringify(this.controller.init.storagePartitionKey)},
							interface: {
								codecEncode: ${this.controller.config.codec.encode.toString()},
								codecDecode: ${this.controller.config.codec.decode.toString()},
							},
						};

						const client = new ScramjetClient(globalThis, {
							context,
							transport: null,
						});

						client.hook();
					})();
					`),
					);

					return str;
				},
				getWorkerFinalizeScript: () =>
					`globalThis.$scramjet$finalizeNativeServiceWorker?.();`,
				nativeServiceWorkerPath: this.controller.config.nativeServiceWorkerPath,
				codecEncode: this.controller.config.codec.encode,
				codecDecode: this.controller.config.codec.decode,
			},
		};
	}

	public plugins: ManagedPlugin[] = [];
	constructor(
		public controller: Controller,
		public element: HTMLIFrameElement,
		public options: FrameOptions = {},
	) {
		this.id = makeId();
		this.prefix = this.controller.prefix + this.id + "/";
		syncFrameName(element);

		this.fetchHandler = new ScramjetFetchHandler({
			crossOriginIsolated: self.crossOriginIsolated,
			context: this.context,
			transport: controller.transport,
			async sendSetCookie(cookies, options) {
				await controller.persistCookies();
				await controller.propagateCookieSync(
					cookies.map(({ url, cookie }) => ({
						url: url.href,
						cookie,
					})),
					options,
				);
			},
			async fetchBlobUrl(url) {
				return BareResponse.fromNativeResponse(await fetch(url));
			},
			async fetchDataUrl(url) {
				return BareResponse.fromNativeResponse(await fetch(url));
			},
		});

		this.serviceWorkers = new ServiceWorkerRegistry(this);

		this.hooks = {
			fetch: this.fetchHandler.hooks.fetch,
			init: Tap.create<FrameInitHooks>(),
			error: Tap.create<FrameErrorHooks>(),
		};

		element[CONTROLLERFRAME] = this;

		this.plugins = options.plugins ?? [];
		for (const plugin of this.plugins) {
			for (const dependency of plugin.dependencies) {
				const dependencyPlugin = this.plugins.find(
					(p) => p.name === dependency,
				);
				if (!dependencyPlugin) {
					throw new Error(
						`Dependency ${dependency} not found for plugin ${plugin.name}`,
					);
				}
			}
			plugin.install(this);
		}
	}

	getPlugin<T extends ManagedPlugin>(name: string): T {
		const plugin = this.plugins.find((p) => p.name === name) as T;
		if (!plugin) {
			throw new Error(`Plugin ${name} not found`);
		}
		return plugin;
	}

	back() {
		this.element.contentWindow?.history.back();
	}

	forward() {
		this.element.contentWindow?.history.forward();
	}

	reload() {
		this.element.contentWindow?.location.reload();
	}

	go(url: string) {
		syncFrameName(this.element);
		const encoded = rewriteUrl(
			url,
			this.context,
			{
				//@ts-expect-error
				origin: new URL(location.href),
				//@ts-expect-error
				base: new URL(location.href),
			},
			{
				destination: "document",
			},
		);
		this.element.src = encoded;
	}
}
