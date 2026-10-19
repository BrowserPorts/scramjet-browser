import type { RawHeaders } from "@mercuryworkshop/proxy-transports";

import {
	RemoteTransport,
	type SerializedCookieSyncEntry,
} from "@mercuryworkshop/rpc";
import {
	CookieJar,
	type CookieSyncOptions,
	getClient,
	SCRAMJETCLIENT,
	ScramjetClient,
	type ScramjetConfig,
	type ScramjetContext,
	type ScramjetSerializedStorageState,
	ScramjetStorageJar,
	type ScramjetStorageManager,
	setWasm,
	Tap,
	type TrackedHistoryState,
} from "@mercuryworkshop/scramjet";
import { wasmNamespace } from "@mercuryworkshop/scramjet";
import type { Config, InjectionSources } from ".";
import { CONTROLLERFRAME } from "./symbols";

// Keep host plumbing private: guest hooks remove the public native accessor.
const hostServiceWorker = navigator.serviceWorker;
// A parent may have hooked this frame before its document scripts arrive
// Its existing client only needs the navigation metadata refreshed by load
const rootServiceWorker = SCRAMJETCLIENT in globalThis
	? Promise.resolve(null)
	: hostServiceWorker
			.getRegistration(new URL("/", document.baseURI).href)
			.then(
				(registration) =>
					registration?.active ?? hostServiceWorker.controller,
			);

type Init = {
	config: Config;
	sjconfig: ScramjetConfig;
	prefix: URL;
	cookies: string;
	storage?: ScramjetSerializedStorageState | null;
	storagePartitionKey: string;
	injectionSources: InjectionSources;
	yieldGetInjectScripts: (
		config: Config,
		sjconfig: ScramjetConfig,
		prefix: URL,
		cookieJar: CookieJar,
		storage: ScramjetStorageManager | undefined,
		codecEncode: (input: string) => string,
		codecDecode: (input: string) => string,
		storagePartitionKey: string,
		injectionSources?: InjectionSources,
	) => any;
	codecEncode: (input: string) => string;
	codecDecode: (input: string) => string;
	initHeaders: RawHeaders;
	history: TrackedHistoryState[];
};

export function load(init: Init) {
	if (SCRAMJETCLIENT in globalThis) {
		// Already hooked. The client lives off-global now, so reach it through the
		// registry rather than the marker. If a parent in another bundle hooked
		// this frame, its own client already holds the navigation metadata and
		// there is nothing reachable here to sync.
		getClient(globalThis)?.syncDocumentInit({
			initHeaders: init.initHeaders,
			history: init.history,
			cookies: init.cookies,
		});
		return;
	}
	if (!(wasmNamespace in self)) {
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
	const wasm = Uint8Array.from(atob(String((self as unknown as Record<string, unknown>)[wasmNamespace])), (c) => c.charCodeAt(0));
	delete (self as unknown as Record<string, unknown>)[wasmNamespace];
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

		hostServiceWorker?.addEventListener(
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
				// Reachable only for ancestors this bundle hooked; an ancestor that
				// booted its own bundle is skipped (its controller frame handle, if
				// any, is resolved when that bundle runs this same walk).
				const currentclient = getClient(currentwin);
				if (!currentclient) {
					currentwin = currentwin.parent.window;
					continue;
				}
				const currentFrame = currentclient.descriptors.get(
					"window.frameElement",
					currentwin,
				) as HTMLIFrameElement | null;
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
					this.init.injectionSources,
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
				// The proxy's internal traffic must not reach the site.
				const data = event.data;
				if (!data || typeof data !== "object") return false;

				return (
					"$controller$setCookie" in data ||
					"$controller$swrevive" in data ||
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
		});
		const frameInitContext = {
			window: this.global.window,
			client: this.client,
			isTopLevel,
		};
		if (controllerFrame)
			Tap.dispatchSync(controllerFrame.hooks.init.pre, frameInitContext, {});
		this.client.hook();
		if (controllerFrame)
			Tap.dispatchSync(controllerFrame.hooks.init.post, frameInitContext, {});
	}
}
