import { deepmerge } from "@fastify/deepmerge";
import {
	BareResponse,
	type ProxyTransport,
} from "@mercuryworkshop/proxy-transports";
import {
	type MethodsDefinition,
	RpcHelper,
	serveRemoteTransport,
} from "@mercuryworkshop/rpc";
import {
	type CookieStore,
	type CookieSyncOptions,
	type FetchHooks,
	Plugin,
	providers,
	rewriteUrl,
	type ScramjetConfig,
	type ScramjetContext,
	ScramjetFetchHandler,
	ScramjetHeaders,
	type ScramjetInterface,
	type ScramjetStorageManager,
	defaultConfig as scramjetDefaultConfig,
	setWasm,
	Tap,
} from "@mercuryworkshop/scramjet";
import { CONTROLLERFRAME } from "./symbols";
import type {
	Controllerbound,
	ControllerDetachRequest,
	ControllerDetachResponse,
	ControllerToTransport,
	FrameErrorHooks,
	FrameInitHooks,
	SerializedCookieSyncEntry,
	SWbound,
	TransportToController,
} from "./types";
import { assertRuntimeScramjetVersion } from "./version";

export { assertRuntimeScramjetVersion, VERSION } from "./version";

export type Config = {
	prefix: string;
	scramjetPath: string;
	injectPath: string;
	wasmPath: string;
	virtualWasmPath: string;
	codec: Record<"encode" | "decode", (input: string) => string>;
};

export const config: Config = {
	prefix: "/~/sj/",
	scramjetPath: "/scramjet/scramjet.js",
	injectPath: "/controller/controller.inject.js",
	wasmPath: "/scramjet/scramjet.wasm",
	virtualWasmPath: "scramjet.wasm.js",
	codec: {
		encode: (url: string) => {
			if (!url) return url;

			// Preserve the existing wire format for encoded proxy URLs.
			return encodeURIComponent(encodeURIComponent(url));
		},
		decode: (url: string) => {
			if (!url) return url;

			const decoded = decodeURIComponent(url);
			// Retain links produced by the previous single-encoding codec.
			return /^[a-z][a-z0-9+.-]*:/i.test(decoded)
				? decoded
				: decodeURIComponent(decoded);
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
const CONTROLLER_READY_TIMEOUT_MS = 5000;

function serviceWorkerScriptsMatch(
	left: ServiceWorker,
	right: ServiceWorker,
): boolean {
	const leftUrl = new URL(left.scriptURL);
	const rightUrl = new URL(right.scriptURL);
	return (
		leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname
	);
}

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

export class Controller {
	id: string;
	config: Config;
	scramjetConfig: ScramjetConfig;
	prefix: string;
	frames: Frame[] = [];
	serviceWorkerController: ServiceWorker;

	private ready: Promise<undefined>;
	private readyResolve: ((value: undefined) => unknown) | null = null;
	private readyReject: ((reason?: unknown) => unknown) | null = null;
	private serviceWorkerReady: {
		worker: ServiceWorker;
		expectedWorkerId: string | undefined;
		connectionId: string;
		resolve: () => undefined;
		reject: (reason?: unknown) => undefined;
		timeout: ReturnType<typeof setTimeout>;
	} | null = null;
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
	private initializationComplete = false;
	private closed = false;
	private detached = false;
	private closing: Promise<undefined> | null = null;
	private serviceWorkerReconnect: {
		worker: ServiceWorker;
		expectedWorkerId: string | undefined;
		promise: Promise<undefined>;
	} | null = null;
	private transportChannels = new Set<{
		port: MessagePort;
		rpc: RpcHelper<TransportToController, ControllerToTransport>;
	}>();

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

		if (
			event.data?.$controller$setCookie &&
			typeof event.data.$controller$setCookie === "object"
		) {
			const payload = event.data.$controller$setCookie as {
				cookies?: SerializedCookieSyncEntry[];
				options?: CookieSyncOptions;
				id?: string;
			};

			if (payload.options?.clear) {
				await this.cookieJar.clear();
			}
			await this.applyCookieSyncEntries(payload.cookies, payload.options);

			if (typeof payload.id === "string") {
				this.serviceWorkerController.postMessage({
					$sw$setCookieDone: {
						id: payload.id,
					},
				});
			}

			return;
		}

		if (event.data?.$controller$swrevive) {
			const revive = event.data.$controller$swrevive as {
				workerId?: unknown;
				revivalId?: unknown;
			};
			const worker = event.source;
			if (
				!(worker instanceof ServiceWorker) ||
				worker.state === "redundant" ||
				typeof revive.workerId !== "string" ||
				typeof revive.revivalId !== "string" ||
				!serviceWorkerScriptsMatch(this.serviceWorkerController, worker)
			) {
				return;
			}
			this.reconnectServiceWorker(
				worker,
				revive.workerId,
				revive.revivalId,
			).catch((error) => {
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
		ready: async (payload) => {
			const readyResolve = this.readyResolve;
			const serviceWorkerReady = this.serviceWorkerReady;
			const legacyReady =
				payload === undefined &&
				serviceWorkerReady?.expectedWorkerId === undefined;
			if (
				serviceWorkerReady === null ||
				(!legacyReady &&
					(typeof payload?.workerId !== "string" ||
						payload.connectionId !== serviceWorkerReady.connectionId ||
						(serviceWorkerReady.expectedWorkerId !== undefined &&
							serviceWorkerReady.expectedWorkerId !== payload.workerId)))
			) {
				throw new Error(
					"Scramjet Controller received an unexpected ready acknowledgement",
				);
			}
			clearTimeout(serviceWorkerReady.timeout);
			this.serviceWorkerReady = null;
			this.serviceWorkerController = serviceWorkerReady.worker;
			if (readyResolve !== null) {
				this.readyResolve = null;
				this.readyReject = null;
				readyResolve(undefined);
			}
			serviceWorkerReady.resolve();
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

				const sjheaders = ScramjetHeaders.fromRawHeaders(data.initialHeaders);

				const fetchresponse = await frame.fetchHandler.handleFetch({
					initialHeaders: sjheaders,
					rawClientUrl: data.rawClientUrl
						? new URL(data.rawClientUrl)
						: undefined,
					rawUrl: new URL(data.rawUrl),
					rawReferrer: data.rawReferrer,
					rawDestination: data.destination,
					rawCredentials: data.credentials,
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
		initRemoteTransport: async ({ port }) => {
			const rpc = serveRemoteTransport(port, {
				transport: () => this.transport,
				resolveProxy: (url) => this.init.resolveProxy?.(url),
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
			});
			this.transportChannels.add({ port, rpc });
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
			new Promise<undefined>((resolve, reject) => {
				this.readyResolve = resolve;
				this.readyReject = reject;
			}),
			this.loadScramjetWasm(),
			this.loadSavedCookies(true),
		]).then(() => {
			if (this.closed || this.closing) {
				throw new Error("Scramjet Controller closed before becoming ready");
			}
			this.initializationComplete = true;
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
		this.reconnectServiceWorker(this.serviceWorkerController).catch((error) => {
			if (this.readyResolve === null || this.serviceWorkerReady !== null) {
				return;
			}
			const readyReject = this.readyReject;
			this.readyResolve = null;
			this.readyReject = null;
			readyReject?.(error);
		});

		navigator.serviceWorker.addEventListener(
			"message",
			this.onServiceWorkerMessage,
		);
	}

	private setupMessagePort(
		worker: ServiceWorker,
		expectedWorkerId?: string,
		revivalId?: string,
	): Promise<undefined> {
		if (this.closed || this.closing) {
			throw new Error("Scramjet Controller is closed");
		}
		if (this.serviceWorkerReady !== null) {
			const pending = this.serviceWorkerReady;
			this.serviceWorkerReady = null;
			clearTimeout(pending.timeout);
			pending.reject(new Error("Scramjet Controller connection was replaced"));
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
		const connectionId = makeId();
		this.port = channel.port1;
		this.port.addEventListener("message", this.onTabChannelMessage);
		this.port.start();

		return new Promise<undefined>((resolve, reject) => {
			const finishReject = (reason?: unknown): undefined => {
				reject(reason);
				return undefined;
			};
			const timeout = setTimeout(() => {
				if (this.serviceWorkerReady?.connectionId !== connectionId) return;
				this.serviceWorkerReady = null;
				finishReject(
					new Error("Scramjet Controller ready acknowledgement expired"),
				);
			}, CONTROLLER_READY_TIMEOUT_MS);
			this.serviceWorkerReady = {
				worker,
				expectedWorkerId,
				connectionId,
				resolve: () => {
					resolve(undefined);
					return undefined;
				},
				reject: finishReject,
				timeout,
			};
			try {
				worker.postMessage(
					{
						$controller$init: {
							prefix: this.prefix,
							id: this.id,
							connectionId,
							...(expectedWorkerId === undefined
								? {}
								: { workerId: expectedWorkerId }),
							...(revivalId === undefined ? {} : { revivalId }),
						},
					},
					[channel.port2],
				);
			} catch (error) {
				if (this.serviceWorkerReady?.connectionId === connectionId) {
					this.serviceWorkerReady = null;
				}
				clearTimeout(timeout);
				finishReject(error);
			}
		});
	}

	private async reconnectServiceWorker(
		worker: ServiceWorker,
		expectedWorkerId?: string,
		revivalId?: string,
	): Promise<undefined> {
		const pendingReconnect = this.serviceWorkerReconnect;
		if (
			pendingReconnect !== null &&
			pendingReconnect.worker === worker &&
			(expectedWorkerId === undefined ||
				pendingReconnect.expectedWorkerId === expectedWorkerId)
		) {
			return pendingReconnect.promise;
		}
		this.isReady = false;
		const reconnectPromise = (async () => {
			await this.setupMessagePort(worker, expectedWorkerId, revivalId);
			if (this.closed || this.closing) {
				throw new Error("Scramjet Controller closed during reconnection");
			}
			if (this.initializationComplete) this.isReady = true;
			return undefined;
		})();
		this.serviceWorkerReconnect = {
			worker,
			expectedWorkerId,
			promise: reconnectPromise,
		};
		try {
			return await reconnectPromise;
		} finally {
			if (this.serviceWorkerReconnect?.promise === reconnectPromise) {
				this.serviceWorkerReconnect = null;
			}
		}
	}

	async refreshServiceWorkerConnection(): Promise<undefined> {
		let worker = this.serviceWorkerController;
		const registration = await navigator.serviceWorker.getRegistration(
			new URL(this.prefix, location.href),
		);
		const active = registration?.active;
		if (
			active &&
			active.state !== "redundant" &&
			serviceWorkerScriptsMatch(worker, active)
		) {
			worker = active;
		}
		if (worker.state === "redundant") {
			throw new Error("No active Scramjet service worker is available");
		}
		return await this.reconnectServiceWorker(worker);
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
			for (const callback of channel.rpc.promiseCallbacks.values()) {
				callback.reject(channelError);
			}
			channel.rpc.promiseCallbacks.clear();
			channel.port.onmessage = null;
			channel.port.onmessageerror = null;
			try {
				channel.port.close();
			} catch {
				// the channel was already closed
			}
		}
		this.transportChannels.clear();

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
		if (this.serviceWorkerReady !== null) {
			const pending = this.serviceWorkerReady;
			this.serviceWorkerReady = null;
			clearTimeout(pending.timeout);
			pending.reject(channelError);
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
		if (!this.port) {
			return undefined;
		}

		await this.rpc.call("sendSetCookie", {
			cookies,
			options,
		});
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
				getWorkerInjectScripts: (
					meta,
					type,
					script,
				) => {
					let str = "";

					str += script(this.controller.config.scramjetPath);
					str += script(this.prefix + this.controller.config.virtualWasmPath);
					str += script(
						"data:text/javascript;charset=utf-8;base64," +
							base64Encode(`
					(()=>{
						const { ScramjetClient, CookieJar, ScramjetStorageJar, setWasm } = $scramjet;

						if (self.WASM) setWasm(Uint8Array.from(atob(self.WASM), (c) => c.charCodeAt(0)));
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
		this.plugins = options.plugins ?? [];

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
			async fetchBlobUrl(url, init) {
				return BareResponse.fromNativeResponse(await fetch(url, init));
			},
			async fetchDataUrl(url, init) {
				return BareResponse.fromNativeResponse(await fetch(url, init));
			},
		});

		this.hooks = {
			fetch: this.fetchHandler.hooks.fetch,
			init: Tap.create<FrameInitHooks>(),
			error: Tap.create<FrameErrorHooks>(),
		};

		element[CONTROLLERFRAME] = this;

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
