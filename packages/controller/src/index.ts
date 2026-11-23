import {
	type MethodsDefinition,
	RpcHelper,
	serveRemoteTransport,
} from "@mercuryworkshop/rpc";
import {
	BareResponse,
	type ProxyTransport,
} from "@mercuryworkshop/proxy-transports";
import { deepmerge } from "@fastify/deepmerge";
import {
	CookieJar,
	type CookieStore,
	defaultConfig as scramjetDefaultConfig,
	providers,
	rewriteInjectedJs,
	type URLMeta,
	rewriteUrl,
	ScramjetFetchHandler,
	ScramjetHeaders,
	setWasm,
	splitFragment,
	Tap,
	type CookieSyncOptions,
	type FetchHooks,
	type ScramjetConfig,
	type ScramjetContext,
	type ScramjetFlags,
	type ScramjetInterface,
	Plugin,
	unrewriteUrl,
} from "@mercuryworkshop/scramjet";
import { CONTROLLERFRAME } from "./symbols";
import type {
	FrameInitHooks,
	FrameLifecycleHooks,
	SerializedCookieSyncEntry,
	Controllerbound,
	SWbound,
	FrameErrorHooks,
} from "./types";
import { assertRuntimeScramjetVersion } from "./version";

export { versionInfo } from "./version";
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

	install(frame: Frame): void {
		this.frame = frame;
	}
}

const COOKIE_DB_NAME = "__scramjet_controller";
const COOKIE_STORE_NAME = "state";
const BROADCASTCHANNEL_NAME = "__scramjet_controller_channel";
/**
 * The partition a controller keeps its cookies under when it is not given
 * one. Every controller without a partition shares it, as every controller
 * did before there were partitions.
 */
const DEFAULT_STORAGE_PARTITION = "cookies";

let cookieDbPromise: Promise<IDBDatabase> | null = null;

function parsePersistedCookieState(
	value: unknown
): PersistedCookieState | null {
	if (
		typeof value !== "object" ||
		value === null ||
		typeof (value as PersistedCookieState).updatedAt !== "number" ||
		!Number.isFinite((value as PersistedCookieState).updatedAt) ||
		typeof (value as PersistedCookieState).cookies !== "string"
	) {
		return null;
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

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
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
	storagePartitionKey: string
): Promise<PersistedCookieState | null> {
	try {
		const db = await openCookieDatabase();
		const transaction = db.transaction(COOKIE_STORE_NAME, "readonly");
		const store = transaction.objectStore(COOKIE_STORE_NAME);
		const value = await requestToPromise(store.get(storagePartitionKey));
		await transactionToPromise(transaction);
		return parsePersistedCookieState(value);
	} catch (error) {
		console.error("Failed to read persisted controller cookies:", error);
		return null;
	}
}

async function writeCookieState(
	storagePartitionKey: string,
	cookies: string,
	currentUpdatedAt: number
): Promise<number> {
	try {
		const db = await openCookieDatabase();
		const transaction = db.transaction(COOKIE_STORE_NAME, "readwrite");
		const store = transaction.objectStore(COOKIE_STORE_NAME);
		const existing = parsePersistedCookieState(
			await requestToPromise(store.get(storagePartitionKey))
		);
		const updatedAt = Math.max(
			Date.now(),
			currentUpdatedAt + 1,
			(existing?.updatedAt ?? 0) + 1
		);
		const state: PersistedCookieState = {
			updatedAt,
			cookies,
		};
		store.put(state, storagePartitionKey);
		await transactionToPromise(transaction);
		return updatedAt;
	} catch (error) {
		console.error("Failed to persist controller cookies:", error);
		return currentUpdatedAt;
	}
}

function makeId(): string {
	return Math.random().toString(36).substring(2, 10);
}

const deepMerge = deepmerge();

export type ControllerInit = {
	serviceworker: ServiceWorker;
	transport: ProxyTransport;
	/**
	 * Which storage partition this controller's cookies belong to: the key
	 * they are persisted under, and the channel controllers of the same
	 * partition keep each other in step over. Controllers of different
	 * partitions on one origin never share a cookie
	 */
	storagePartitionKey?: string;
	/**
	 * The cookie store every frame of this controller reads and writes. A store
	 * whose `ownsPersistence` is false keeps its own backing, and the
	 * controller never persists it. Unset, the providers' `createCookieStore`
	 * makes one, or a `CookieJar` the controller persists
	 */
	cookieJar?: CookieStore;
	/** The upstream proxy a request or socket goes through, if any */
	resolveProxy?: (url: URL) => Promise<string | null> | string | null;
	config?: Partial<Config>;
	scramjetConfig?: Partial<ScramjetConfig>;
};

type FrameOptions = {
	plugins?: ManagedPlugin[];
	/**
	 * Overrides of the controller's flags for this frame, and for everything
	 * loaded in it: its subframes and workers run with the same flags.
	 */
	flags?: Partial<ScramjetFlags>;
};

export class Controller {
	id: string;
	config: Config;
	scramjetConfig: ScramjetConfig;
	prefix: string;
	frames: Frame[] = [];
	serviceWorkerController: ServiceWorker;
	readonly storagePartitionKey: string;
	private resolvedCookieStore: CookieStore | undefined;
	private closed = false;
	private closing: Promise<void> | null = null;
	/** the ports pages and workers reach the transport through */
	private transportPorts = new Set<MessagePort>();

	private ready: Promise<void>;
	private readyResolve!: () => void;
	public isReady: boolean = false;
	rpc: RpcHelper<Controllerbound, SWbound>;
	private port: MessagePort | null = null;

	transport: ProxyTransport;
	private cookieUpdatedAt = 0;
	private cookieSyncPromise: Promise<void> | null = null;
	private cookieSyncDirty = true;
	private cookieSyncChannel: BroadcastChannel;

	private wasmAlreadyFetched = false;
	private wasmPayload: string | null = null;
	private onTabChannelMessage: (e: MessageEvent) => void = (e) => {
		this.rpc.recieve(e.data);
	};
	private onCookieSyncMessage = (event: MessageEvent) => {
		const updatedAt =
			typeof event.data === "object" && event.data !== null
				? (event.data as { updatedAt?: unknown }).updatedAt
				: undefined;
		if (typeof updatedAt !== "number" || updatedAt <= this.cookieUpdatedAt) {
			return;
		}

		this.cookieSyncDirty = true;
		void this.loadSavedCookies();
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
			this.readyResolve();
		},
		request: async (data) => {
			const path = new URL(data.rawUrl).pathname;
			const frame = this.frames.find((f) => path.startsWith(f.prefix));
			if (!frame) throw new Error("No frame found for request");
			try {
				// doesn't actually *load* every request, but hold u requests until the promise finishes
				await this.loadSavedCookies();

				if (path === frame.prefix + this.config.virtualWasmPath) {
					if (!this.wasmPayload) {
						const resp = await fetch(this.config.wasmPath);
						const buf = await resp.arrayBuffer();
						const b64 = btoa(
							new Uint8Array(buf)
								.reduce(
									(data, byte) => (data.push(String.fromCharCode(byte)), data),
									[] as any
								)
								.join("")
						);

						this.wasmPayload = `self.WASM = '${b64}';`;
					}

					const url = new URL(data.rawUrl) as URLMeta["base"];
					const body = rewriteInjectedJs(
						this.wasmPayload,
						"wasm",
						frame.fetchHandler.context,
						{ origin: url, base: url } as URLMeta
					);

					return [
						{
							body,
							status: 200,
							statusText: "OK",
							headers: [["Content-Type", "application/javascript"]],
						},
						[],
					];
				}

				const sjheaders = ScramjetHeaders.fromRawHeaders(data.initialHeaders);

				const fetchresponse = await frame.fetchHandler.handleFetch({
					initialHeaders: sjheaders,
					rawClientUrl: data.rawClientUrl
						? new URL(data.rawClientUrl)
						: undefined,
					rawUrl: new URL(data.rawUrl),
					rawReferrer: data.rawReferrer,
					rawReferrerPolicy: data.rawReferrerPolicy,
					rawDestination: data.destination,
					method: data.method,
					mode: data.mode,
					referrer: data.referrer,
					body: data.body,
					cache: data.cache,
					clientId: data.clientId,
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
		initRemoteTransport: async (port) => {
			if (this.closed || this.closing) {
				port.close();
				return;
			}
			this.transportPorts.add(port);
			// the transport is read on every request and socket, so a transport
			// swapped with `setTransport` reaches the pages already connected
			serveRemoteTransport(port, {
				transport: () => this.transport,
				resolveProxy: (url) => this.init.resolveProxy?.(url),
				sendSetCookie: async ({ cookies, options }) => {
					await this.loadSavedCookies(true);
					if (options?.clear) {
						await this.cookieJar.clear();
					}
					await this.applyCookieSyncEntries(cookies);
					await this.persistCookies();
					await this.propagateCookieSync(cookies, options);
				},
			});
		},
	};

	constructor(public init: ControllerInit) {
		assertRuntimeScramjetVersion();
		this.id = makeId();
		this.config = deepMerge(config, init.config || {}) as Config;
		this.scramjetConfig = deepMerge(scramjetConfig, scramjetDefaultConfig);
		this.scramjetConfig = deepMerge(
			this.scramjetConfig,
			init.scramjetConfig || {}
		) as ScramjetConfig;
		this.prefix = this.config.prefix + this.id + "/";
		this.serviceWorkerController = init.serviceworker;
		if (
			init.storagePartitionKey !== undefined &&
			(typeof init.storagePartitionKey !== "string" ||
				init.storagePartitionKey.length === 0)
		) {
			throw new Error(
				"Scramjet Controller's storage partition key has to be a non-empty string"
			);
		}
		this.storagePartitionKey =
			init.storagePartitionKey ?? DEFAULT_STORAGE_PARTITION;
		this.resolvedCookieStore = init.cookieJar;
		this.cookieSyncChannel = new BroadcastChannel(
			init.storagePartitionKey === undefined
				? BROADCASTCHANNEL_NAME
				: `${BROADCASTCHANNEL_NAME}:${encodeURIComponent(init.storagePartitionKey)}`
		);

		this.ready = Promise.all([
			new Promise<void>((resolve) => {
				this.readyResolve = resolve;
			}),
			this.loadScramjetWasm(),
			this.loadSavedCookies(true),
		]).then(() => undefined);

		this.rpc = new RpcHelper<Controllerbound, SWbound>(
			this.methods,
			"tabchannel-" + this.id,
			(data, transfer) => {
				if (!this.port) {
					throw new Error("Port not found");
				}
				this.port.postMessage(data, transfer);
			}
		);
		this.transport = init.transport;

		this.cookieSyncChannel.addEventListener(
			"message",
			this.onCookieSyncMessage
		);
		this.setupMessagePort();

		navigator.serviceWorker.addEventListener(
			"message",
			this.onServiceWorkerMessage
		);
	}

	private onServiceWorkerMessage = (e: MessageEvent) => {
		if (this.closed || this.closing) return;
		if (
			e.data?.$controller$setCookie &&
			typeof e.data.$controller$setCookie === "object"
		) {
			const payload = e.data.$controller$setCookie as {
				cookies?: SerializedCookieSyncEntry[];
				options?: CookieSyncOptions;
				id?: string;
			};

			// a store may settle a write later, and the worker is told the
			// cookies are in only once they are
			(async () => {
				if (payload.options?.clear) {
					await this.cookieJar.clear();
				}
				await this.applyCookieSyncEntries(payload.cookies);
			})()
				.catch((error) => {
					console.error("Scramjet cookie synchronization failed:", error);
				})
				.finally(() => {
					if (typeof payload.id === "string") {
						this.serviceWorkerController.postMessage({
							$sw$setCookieDone: {
								id: payload.id,
							},
						});
					}
				});

			return;
		}

		const revive = e.data?.$controller$swrevive;
		if (revive && typeof revive === "object") {
			if (revive.id !== undefined && revive.id !== this.id) return;
			if (e.source instanceof ServiceWorker) {
				this.serviceWorkerController = e.source;
			}
			this.setupMessagePort();
		}
	};

	/**
	 * Reconnects to the service worker, for a host that knows it restarted
	 * before the worker asks for a revival itself
	 */
	async refreshServiceWorkerConnection(): Promise<void> {
		if (this.closed || this.closing) {
			throw new Error("Scramjet Controller is closed");
		}
		const registration = await navigator.serviceWorker.getRegistration(
			new URL("/", location.href).href
		);
		const worker = registration?.active ?? navigator.serviceWorker.controller;
		if (worker) this.serviceWorkerController = worker;
		this.setupMessagePort();
	}

	/**
	 * Closes every frame - its plugins release what they hold through
	 * `hooks.lifecycle.close` first - then the ports, channels and listeners
	 * the controller opened. A closed controller makes no frames.
	 */
	close(): Promise<void> {
		this.closing ??= (async () => {
			for (const frame of this.frames) {
				try {
					await Tap.dispatch(frame.hooks.lifecycle.close, { frame }, {});
				} catch (error) {
					console.error("Scramjet frame cleanup failed:", error);
				}
				delete frame.element[CONTROLLERFRAME];
			}
			this.frames = [];
			for (const port of this.transportPorts) {
				try {
					port.close();
				} catch {
					// a port the page already closed
				}
			}
			this.transportPorts.clear();
			navigator.serviceWorker.removeEventListener(
				"message",
				this.onServiceWorkerMessage
			);
			this.cookieSyncChannel.removeEventListener(
				"message",
				this.onCookieSyncMessage
			);
			this.cookieSyncChannel.close();
			if (this.port) {
				this.port.removeEventListener("message", this.onTabChannelMessage);
				this.port.close();
				this.port = null;
			}
			this.closed = true;
		})();

		return this.closing;
	}

	/**
	 * The store every frame reads and writes: the one the controller was
	 * given, or else the providers' or a `CookieJar`, made once
	 */
	get cookieJar(): CookieStore {
		this.resolvedCookieStore ??=
			providers().createCookieStore?.() ?? new CookieJar();

		return this.resolvedCookieStore;
	}

	private setupMessagePort() {
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
					basePrefix: this.config.prefix,
					id: this.id,
				},
			},
			[channel.port2]
		);
	}

	// TODO: should this be a method on the cookie jar?
	private async applyCookieSyncEntries(
		cookies: SerializedCookieSyncEntry[] | undefined
	) {
		if (!Array.isArray(cookies)) {
			return;
		}

		for (const entry of cookies) {
			if (typeof entry?.url !== "string" || typeof entry.cookie !== "string") {
				continue;
			}

			// a page's write is `document.cookie`'s, which cannot set HttpOnly
			await this.cookieJar.setCookies(entry.cookie, new URL(entry.url), true);
		}
	}

	async propagateCookieSync(
		cookies: SerializedCookieSyncEntry[],
		options: CookieSyncOptions = {}
	): Promise<void> {
		if (!this.port) {
			return;
		}

		await this.rpc.call("sendSetCookie", {
			cookies,
			options,
		});
	}

	private async loadSavedCookies(force = false): Promise<void> {
		if (!force && !this.cookieSyncDirty) {
			return;
		}

		if (this.cookieSyncPromise) {
			return this.cookieSyncPromise;
		}

		// a store with its own backing is never snapshotted into ours
		if (!this.cookieJar.ownsPersistence) {
			this.cookieSyncDirty = false;
			return;
		}

		this.cookieSyncPromise = (async () => {
			const persisted = await readCookieState(this.storagePartitionKey);
			if (persisted && persisted.updatedAt > this.cookieUpdatedAt) {
				this.cookieJar.load(persisted.cookies);
				this.cookieUpdatedAt = persisted.updatedAt;
			}
			this.cookieSyncDirty = false;
		})().finally(() => {
			this.cookieSyncPromise = null;
		});

		return this.cookieSyncPromise;
	}

	async persistCookies(): Promise<void> {
		if (!this.cookieJar.ownsPersistence) return;
		const updatedAt = await writeCookieState(
			this.storagePartitionKey,
			this.cookieJar.dump(),
			this.cookieUpdatedAt
		);
		if (updatedAt <= this.cookieUpdatedAt) {
			return;
		}

		this.cookieUpdatedAt = updatedAt;
		this.cookieSyncDirty = false;
		this.cookieSyncChannel.postMessage({
			updatedAt,
		});
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
		if (!this.ready) {
			throw new Error(
				"Controller is not ready! Try awaiting controller.wait()"
			);
		}
		element ??= document.createElement("iframe");
		const frame = new Frame(this, element, options);
		this.frames.push(frame);
		return frame;
	}

	async wait(): Promise<void> {
		await this.ready;
	}
}

function base64Encode(text: string) {
	return btoa(
		new TextEncoder()
			.encode(text)
			.reduce(
				(data, byte) => (data.push(String.fromCharCode(byte)), data),
				[] as any
			)
			.join("")
	);
}

function yieldGetInjectScripts(
	config: Config,
	sjconfig: ScramjetConfig,
	prefix: URL,
	cookieJar: CookieStore,
	codecEncode: (input: string) => string,
	codecDecode: (input: string) => string
) {
	const getInjectScripts: ScramjetInterface["getInjectScripts"] = (
		meta,
		_root,
		htmlcontext,
		script,
		transform = (source: string) => source
	) => {
		function base64Encode(text: string) {
			return btoa(
				new TextEncoder()
					.encode(text)
					.reduce(
						(data, byte) => (data.push(String.fromCharCode(byte)), data),
						[] as any
					)
					.join("")
			);
		}
		return [
			script(config.scramjetPath),
			script(prefix.href + config.virtualWasmPath),
			script(config.injectPath),
			script(
				"data:text/javascript;charset=utf-8;base64," +
					base64Encode(
						transform(`
					document.querySelectorAll("script[scramjet-injected]").forEach(script => script.remove());
					$scramjetController.load({
						config: ${JSON.stringify(config)},
						sjconfig: ${JSON.stringify(sjconfig)},
						prefix: new URL("${prefix.href}"),
						cookies: ${JSON.stringify(cookieJar.dump())},
						yieldGetInjectScripts: ${yieldGetInjectScripts.toString()},
						codecEncode: ${codecEncode.toString()},
						codecDecode: ${codecDecode.toString()},
						initHeaders: ${JSON.stringify(htmlcontext.headers ?? [])},
						referrer: ${JSON.stringify(htmlcontext.referrer)},
					})
				`)
					)
			),
		];
	};
	return getInjectScripts;
}

export class Frame {
	id: string;
	prefix: string;
	/**
	 * The controller's config with this frame's flags applied. A frame with its
	 * own flags takes a copy when it is created.
	 */
	scramjetConfig: ScramjetConfig;
	fetchHandler: ScramjetFetchHandler;
	hooks: {
		fetch: FetchHooks;
		init: FrameInitHooks;
		error: FrameErrorHooks;
		lifecycle: FrameLifecycleHooks;
	};

	get context(): ScramjetContext {
		return {
			config: this.scramjetConfig,
			prefix: new URL(this.prefix, location.href),
			cookieJar: this.controller.cookieJar,
			interface: {
				getInjectScripts: yieldGetInjectScripts(
					this.controller.config,
					this.scramjetConfig,
					new URL(this.prefix, location.href),
					this.controller.cookieJar,
					this.controller.config.codec.encode,
					this.controller.config.codec.decode
				),
				getWorkerInjectScripts: (
					meta,
					type,
					script,
					transform = (source: string) => source
				) => {
					let str = "";

					str += script(this.controller.config.scramjetPath);
					str += script(this.prefix + this.controller.config.virtualWasmPath);
					str += script(
						"data:text/javascript;charset=utf-8;base64," +
							base64Encode(
								transform(`
					(()=>{
						const { ScramjetClient, CookieJar, setWasm } = $scramjet;

						setWasm(Uint8Array.from(atob(self.WASM), (c) => c.charCodeAt(0)));
						delete self.WASM;

						const sjconfig = ${JSON.stringify(this.scramjetConfig)};
						const prefix = new URL("${this.prefix}", location.href);

						const context = {
							config: sjconfig,
							prefix,
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
					`)
							)
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
		public options: FrameOptions = {}
	) {
		this.id = makeId();
		this.prefix = this.controller.prefix + this.id + "/";
		// without overrides the frame shares the controller's config, so changes
		// to it still reach the frame
		this.scramjetConfig = options.flags
			? {
					...controller.scramjetConfig,
					flags: { ...controller.scramjetConfig.flags, ...options.flags },
				}
			: controller.scramjetConfig;

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
					options
				);
			},
			async fetchBlobUrl(url) {
				return BareResponse.fromNativeResponse(await fetch(url));
			},
			async fetchDataUrl(url) {
				return BareResponse.fromNativeResponse(await fetch(url));
			},
		});

		this.hooks = {
			fetch: this.fetchHandler.hooks.fetch,
			init: Tap.create<FrameInitHooks>(),
			error: Tap.create<FrameErrorHooks>(),
			lifecycle: Tap.create<FrameLifecycleHooks>(),
		};

		element[CONTROLLERFRAME] = this;

		this.plugins = options.plugins ?? [];
		for (const plugin of this.plugins) {
			for (const dependency of plugin.dependencies) {
				const dependencyPlugin = this.plugins.find(
					(p) => p.name === dependency
				);
				if (!dependencyPlugin) {
					throw new Error(
						`Dependency ${dependency} not found for plugin ${plugin.name}`
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
		const encoded = rewriteUrl(url, this.context, {
			//@ts-expect-error TODO: fix branded types leaking into core api
			origin: new URL(location.href),
			//@ts-expect-error TODO: fix branded types leaking into core api
			base: new URL(location.href),
		});
		this.element.src = this.sameDocument(url) ?? encoded;
	}

	/**
	 * The real URL of the frame's document with `url`'s fragment, when `url`
	 * is a fragment of that same document - or null.
	 *
	 * Going to `page#b` from `page#a` is a fragment navigation: it scrolls,
	 * and fires `hashchange`, without reloading anything. The browser only
	 * sees one when the frame's new URL equals its document's real URL but for
	 * the fragment, and a rewritten URL does not - it lacks the query the
	 * document was loaded with.
	 */
	private sameDocument(url: string): string | null {
		let raw: string | undefined;
		try {
			raw = this.element.contentWindow?.location.href;
		} catch {
			return null;
		}
		if (!raw) return null;

		let target: URL;
		let current: URL;
		try {
			target = new URL(url);
			current = new URL(unrewriteUrl(raw, this.context));
		} catch {
			return null;
		}

		const [withoutFragment, fragment] = splitFragment(target.href);
		// without a fragment it loads a new document, which it has to request
		// afresh
		if (fragment === null) return null;
		if (splitFragment(current.href)[0] !== withoutFragment) return null;

		return splitFragment(raw)[0] + (fragment ?? "");
	}
}
