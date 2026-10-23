import type { RawHeaders } from "@mercuryworkshop/proxy-transports";

import {
	type CookieSyncSink,
	type CookieSyncUpdate,
	RemoteTransport,
	type SerializedCookieSyncEntry,
} from "@mercuryworkshop/rpc";
import {
	CookieJar,
	getClient,
	realmDocumentEventType,
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
import type { Config, Frame, InjectionSources } from ".";
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

const EventTarget_addEventListener = EventTarget.prototype.addEventListener;
const EventTarget_dispatchEvent = EventTarget.prototype.dispatchEvent;

/**
 * The controller frame whose iframe holds the document at `win`, found by the iframes
 * themselves. A frame that booted its own copy of the runtime cannot see the clients of
 * its ancestors, which belong to other copies, but the controller frame is a property
 * of the iframe element the application created, and that element can be read from any
 * window in the same origin. Realm mode needs it for every frame, since a frame with
 * no controller frame has no realm to send its scripts to.
 *
 * A window that another opened has no iframe above it, and takes the controller frame
 * of the window that opened it, so the page an OAuth popup loads runs its scripts in a
 * realm as the page that opened it does.
 */
function controllerFrameAbove(win: Window): Frame | undefined {
	// This window has not been hooked yet, so its own accessor is the browser's
	const read = Object.getOwnPropertyDescriptor(win, "frameElement")?.get;
	if (typeof read !== "function") return undefined;
	let current: Window = win;
	for (let depth = 0; depth < 64; depth++) {
		let parent: Window;
		let element: unknown;
		try {
			parent = current.parent;
			element = Reflect.apply(read, current, []);
		} catch {
			// A parent in another origin has nothing to read
			return undefined;
		}
		const handle = (element as Record<symbol, Frame | undefined> | null)?.[CONTROLLERFRAME];
		if (handle) return handle;
		if (parent === current) {
			// The top of a tree that no controller frame holds: a window another opened goes on from its opener
			let opener: Window | null;
			try {
				opener = current.opener as Window | null;
			} catch {
				return undefined;
			}
			if (!opener || opener === current) return undefined;
			current = opener;
			continue;
		}
		current = parent;
	}
	return undefined;
}

/**
 * A page's copy of the controller's cookie jar, kept in step over the page's transport port. A
 * cookie the page set stays pending until the controller has applied it, so a snapshot read
 * before then can't drop it from document.cookie
 */
class CookieMirror implements CookieSyncSink {
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
	/** The nonce of the document's content security policy, in realm mode */
	nonce?: string;
};

export function load(init: Init) {
	if (SCRAMJETCLIENT in globalThis) {
		// Already hooked. The client lives off-global now, so reach it through the
		// registry rather than the marker. If a parent in another bundle hooked
		// this frame, its own client already holds the navigation metadata and
		// there is nothing reachable here to sync.
		// The reused window's jar is kept in step over its transport, so the cookies baked into
		// this document are older than the ones it already has
		const sync = {
			initHeaders: init.initHeaders,
			history: init.history,
			...(init.nonce === undefined ? {} : { nonce: init.nonce }),
		};
		const hooked = getClient(globalThis);
		if (hooked !== undefined) {
			hooked.syncDocumentInit(sync);
		} else {
			// The client that hooked this window is a copy this one cannot reach, and in realm
			// mode it holds the window's realm. It listens on the window for the new document
			const eventType = init.sjconfig.realm?.eventType;
			if (typeof eventType === "string" && eventType !== "") {
				EventTarget_dispatchEvent.call(
					globalThis,
					new CustomEvent(realmDocumentEventType(eventType), { detail: sync }),
				);
			}
		}
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
	cookies: CookieMirror;
	cookieJar: CookieJar;
	storage: ScramjetStorageJar | undefined;
	transport: RemoteTransport;
	private hidden = false;
	// Inherited contexts run in this realm, so their own page events stop firing once this page goes
	private dependents = new Set<ExecutionContextWrapper>();

	constructor(
		public global: typeof globalThis,
		public init: Init,
		inherited?: ExecutionContextWrapper,
	) {
		// Initial blank, document-written and opened windows read the same jar as their parent
		this.cookies = inherited?.cookies ?? new CookieMirror(new CookieJar());
		this.cookieJar = this.cookies.jar;
		if (!inherited) this.cookieJar.load(this.init.cookies);

		const channel = new MessageChannel();
		this.transport = new RemoteTransport(channel.port1, {
			cookies: this.cookies,
		});
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

		this.storage = this.init.storage
			? new ScramjetStorageJar(this.init.storage, async (mutation) => {
					return await this.transport.sendStorageMutation([mutation]);
				})
			: undefined;

		// A page that is hidden or gone can't answer, so it stops holding up Set-Cookie responses,
		// and catches up with a snapshot if it is shown again
		inherited?.dependents.add(this);
		const onPageHide = (event: PageTransitionEvent) => {
			if (!event.isTrusted) return;
			// An inherited context that hides without its parent is gone for good
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
			if (!controllerFrame && this.init.sjconfig.flags.realmExecution) {
				controllerFrame = controllerFrameAbove(this.global.window);
			}
		}
		const context: ScramjetContext = {
			config: this.init.sjconfig,
			prefix: this.init.prefix,
			...(this.init.nonce === undefined ? {} : { nonce: this.init.nonce }),
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
			linkWorkerTransport: (port) => this.transport.linkWorkerTransport(port),
			sendSetCookie: async (cookies, options) => {
				await this.transport.sendSetCookie(cookies, options);
			},
			shouldBlockMessageEvent: (event) => {
				// The proxy's internal traffic must not reach the site.
				const data = event.data;
				if (!data || typeof data !== "object") return false;

				return (
					"$controller$swrevive" in data ||
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
		});
		const frameInitContext = {
			window: this.global.window,
			client: this.client,
			isTopLevel,
			nonce: this.init.nonce,
		};
		if (controllerFrame)
			Tap.dispatchSync(controllerFrame.hooks.init.pre, frameInitContext, {});
		this.client.hook();
		if (controllerFrame)
			Tap.dispatchSync(controllerFrame.hooks.init.post, frameInitContext, {});
	}
}
