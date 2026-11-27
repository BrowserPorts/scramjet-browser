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
	identityName,
	wasmNamespace,
} from "@mercuryworkshop/scramjet";
import { CONTROLLERFRAME } from "./symbols";
import type {
	FrameInitHooks,
	FrameLifecycleHooks,
	SerializedCookieSyncEntry,
	Controllerbound,
	ControllerToTransport,
	CookieSyncUpdate,
	SWbound,
	TransportToController,
	FrameErrorHooks,
} from "./types";
import { assertRuntimeScramjetVersion } from "./version";

declare const SCRAMJET_SCRIPT_XOR_KEY: readonly number[] | undefined;

function virtualWasmScript(bytes: Uint8Array): string {
	const key =
		typeof SCRAMJET_SCRIPT_XOR_KEY === "undefined"
			? undefined
			: SCRAMJET_SCRIPT_XOR_KEY;
	const parts: string[] = [];
	for (let start = 0; start < bytes.length; start += 0x8000) {
		const block = bytes.subarray(start, start + 0x8000);
		const encoded = key
			? block.map((byte, index) => byte ^ key[(start + index) % key.length])
			: block;
		parts.push(String.fromCharCode(...encoded));
	}
	const payload = JSON.stringify(btoa(parts.join("")));
	const target = `self[${JSON.stringify(wasmNamespace)}]`;
	if (!key) return `${target} = ${payload};`;
	return `${target} = ((data, key) => {
		const bytes = atob(data);
		let original = "";
		for (let index = 0; index < bytes.length; index++)
			original += String.fromCharCode(bytes.charCodeAt(index) ^ key[index % key.length]);
		return btoa(original);
	})(${payload},${JSON.stringify(key)});`;
}

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

			const decoded = decodeURIComponent(url);
			// The fork's v2 builds encoded twice. A page still running one across
			// a deploy can hand over a URL it made, so one that does not yet
			// start with a scheme is decoded again. There for one release
			return /^[a-z][a-z0-9+.-]*:/i.test(decoded)
				? decoded
				: decodeURIComponent(decoded);
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

const COOKIE_DB_NAME = identityName("__scramjet_controller");
const COOKIE_STORE_NAME = "state";
const BROADCASTCHANNEL_NAME = identityName("__scramjet_controller_channel");
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
	// unguessable, since a controller's id is what the worker routes its
	// requests and its port by
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		""
	);
}

// how long a response that sets cookies waits for each page to apply them
const COOKIE_SYNC_ACK_TIMEOUT_MS = 1000;

/** A page's or worker's transport port, which its cookie updates travel on */
type TransportChannel = {
	port: MessagePort;
	rpc: RpcHelper<TransportToController, ControllerToTransport>;
	/** cleared while the page is hidden or gone */
	receivesCookies: boolean;
	/** set when the page misses a deadline: it gets no updates until it answers, then a snapshot */
	behind: boolean;
};

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
	private transportChannels = new Set<TransportChannel>();

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
		// another controller of this partition persisted newer cookies; this
		// one's pages get them as a snapshot
		const before = this.cookieUpdatedAt;
		this.loadSavedCookies()
			.then(() => {
				if (this.cookieUpdatedAt === before) return;
				for (const channel of this.transportChannels)
					this.sendCookieSnapshot(channel);
			})
			.catch((error) => {
				console.error("Scramjet cookie synchronization failed:", error);
			});
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
						this.wasmPayload = virtualWasmScript(new Uint8Array(buf));
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
			// cookies another tab saved belong in this page's first snapshot
			await this.loadSavedCookies().catch((error) => {
				console.error("Scramjet cookie synchronization failed:", error);
			});
			if (this.closed || this.closing) {
				port.close();
				return;
			}
			const channel = {
				port,
				receivesCookies: true,
				behind: false,
			} as TransportChannel;
			// the transport is read on every request and socket, so a transport
			// swapped with `setTransport` reaches the pages already connected
			channel.rpc = serveRemoteTransport(port, {
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
				setCookieReceiver: async ({ active }) => {
					channel.receivesCookies = active;
					channel.behind = false;
					// a page shown again missed every update while it was hidden
					if (active) this.sendCookieSnapshot(channel);
				},
			});
			this.transportChannels.add(channel);
			// serving the port has already said ready, so every cookie the page
			// writes is applied after this snapshot, and the page keeps it
			this.sendCookieSnapshot(channel);
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
			for (const channel of this.transportChannels) {
				for (const callback of channel.rpc.promiseCallbacks.values()) {
					callback.reject(new Error("Scramjet Controller is closed"));
				}
				channel.rpc.promiseCallbacks.clear();
				try {
					channel.port.close();
				} catch {
					// a port the page already closed
				}
			}
			this.transportChannels.clear();
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

	/**
	 * Hands every connected page the cookies a response or another page set,
	 * each over its own port and in order, and waits until each has applied
	 * them or missed its deadline
	 */
	async propagateCookieSync(
		cookies: SerializedCookieSyncEntry[],
		options: CookieSyncOptions = {}
	): Promise<void> {
		const update: CookieSyncUpdate = {
			cookies,
			options: options.clear ? { clear: true } : {},
		};
		await Promise.all(
			Array.from(this.transportChannels, (channel) =>
				this.deliverCookieSync(channel, update)
			)
		);
	}

	private sendCookieSnapshot(channel: TransportChannel): void {
		void this.deliverCookieSync(channel, { snapshot: this.cookieJar.dump() });
	}

	/**
	 * Resolves once the page has applied the update, or once it misses the
	 * deadline. Never rejects, so a busy or departed page cannot fail or stall
	 * the response that set the cookie
	 */
	private async deliverCookieSync(
		channel: TransportChannel,
		update: CookieSyncUpdate
	): Promise<void> {
		if (!channel.receivesCookies || channel.behind) return;
		const delivered = channel.rpc.call("cookieSync", update).then(
			() => true,
			() => true
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), COOKIE_SYNC_ACK_TIMEOUT_MS);
		});
		const acknowledged = await Promise.race([delivered, deadline]);
		clearTimeout(timer);
		if (acknowledged) return;

		// no more updates for a page that is not answering; it is resynced once
		// it does
		channel.behind = true;
		void delivered.then(() => {
			if (!channel.behind || !this.transportChannels.has(channel)) return;
			channel.behind = false;
			this.sendCookieSnapshot(channel);
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
					document.querySelectorAll(${JSON.stringify("script[" + sjconfig.identity.injectedAttribute + "]")}).forEach(script => script.remove());
					self[${JSON.stringify(sjconfig.identity.controllerNamespace)}].load({
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
						const { ScramjetClient, CookieJar, setWasm } = self[${JSON.stringify(this.scramjetConfig.identity.runtimeNamespace)}];

						setWasm(Uint8Array.from(atob(self[${JSON.stringify(this.scramjetConfig.identity.wasmNamespace)}]), (c) => c.charCodeAt(0)));
						delete self[${JSON.stringify(this.scramjetConfig.identity.wasmNamespace)}];

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
