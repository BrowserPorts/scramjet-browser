import type { RawHeaders } from "@mercuryworkshop/proxy-transports";

// the remote transport the controller serves; its socket events wait for
// the connect reply, and it is ready once the controller says so
import {
	type CookieSyncSink,
	type CookieSyncUpdate,
	RemoteTransport,
} from "@mercuryworkshop/rpc";
import type { Config } from ".";
import { CONTROLLERFRAME } from "./symbols";
import type { SerializedCookieSyncEntry } from "./types";
import {
	CookieJar,
	SCRAMJETCLIENT,
	ScramjetClient,
	setWasm,
	Tap,
	type ScramjetConfig,
	type ScramjetContext,
	wasmNamespace,
} from "@mercuryworkshop/scramjet";

const sw = navigator.serviceWorker?.controller;

const EventTarget_addEventListener = EventTarget.prototype.addEventListener;

/**
 * A page's copy of the controller's cookie jar, kept in step over the page's
 * own transport port, in order. A cookie the page set stays pending until the
 * controller has applied it, so a snapshot read before then cannot drop it
 * from document.cookie.
 */
class CookieMirror implements CookieSyncSink {
	private pending = new Set<SerializedCookieSyncEntry>();

	constructor(public jar: CookieJar) {}

	async track(
		entries: SerializedCookieSyncEntry[],
		applied: Promise<unknown>
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
			// the page's own writes the controller has not applied yet go back
			// on top of the snapshot
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
	yieldGetInjectScripts: (
		config: Config,
		sjconfig: ScramjetConfig,
		prefix: URL,
		cookieJar: CookieJar,
		codecEncode: (input: string) => string,
		codecDecode: (input: string) => string
	) => any;
	codecEncode: (input: string) => string;
	codecDecode: (input: string) => string;
	initHeaders: RawHeaders;
	/** document.referrer, for a document the proxy served. */
	referrer?: string;
};

export function load(init: Init) {
	if (SCRAMJETCLIENT in globalThis) {
		// the reused window's jar is kept in step over its transport, so the
		// cookies baked into this document are older than the ones it has
		((globalThis as any)[SCRAMJETCLIENT] as ScramjetClient).syncDocumentInit({
			initHeaders: init.initHeaders,
			referrer: init.referrer,
		});
		return;
	}
	const slot = self as unknown as Record<string, unknown>;
	if (!(wasmNamespace in slot)) {
		// the script that carries the wasm is served by the service worker, and
		// Chromium gives a frame's first, empty document no worker, nor any
		// document made inside one: a srcdoc frame in an about:blank frame asks
		// the origin server for it and gets nothing. A page with a client made
		// that document, and hooks it the way it hooks a frame it reaches into
		if (borrowClient(init)) return;
		throw new Error("WASM not found in global scope!");
	}
	const wasm = Uint8Array.from(atob(String(slot[wasmNamespace])), (c) =>
		c.charCodeAt(0)
	);
	delete slot[wasmNamespace];
	setWasm(wasm);

	new ExecutionContextWrapper(globalThis, init);
}

/**
 * Has the nearest ancestor that has a client install one here, and reports
 * whether one did. An ancestor of another origin cannot be read, and ends the
 * search.
 */
function borrowClient(init: Init): boolean {
	try {
		let ancestor: Window = window;
		while (ancestor.parent !== ancestor) {
			ancestor = ancestor.parent;
			const lender = (ancestor as any)[SCRAMJETCLIENT] as
				| ScramjetClient
				| undefined;
			if (!lender) continue;
			lender.init.hookSubcontext(
				globalThis as any,
				(window.frameElement as HTMLIFrameElement | null) ?? undefined
			);
			const client = (globalThis as any)[SCRAMJETCLIENT] as
				| ScramjetClient
				| undefined;
			if (!client) return false;
			client.syncDocumentInit({
				initHeaders: init.initHeaders,
				referrer: init.referrer,
			});
			return true;
		}
	} catch {
		// no ancestor this document may read has a client to lend
	}
	return false;
}

class ExecutionContextWrapper {
	client!: ScramjetClient;
	cookies: CookieMirror;
	cookieJar: CookieJar;
	transport: RemoteTransport;
	private hidden = false;
	// contexts inherited from this one run in this realm, so their own page
	// events stop firing once this page goes
	private dependents = new Set<ExecutionContextWrapper>();

	constructor(
		public global: typeof globalThis,
		public init: Init,
		inherited?: ExecutionContextWrapper
	) {
		// an initial blank, document-written or opened window reads the same jar
		// as the window it came from
		this.cookies = inherited?.cookies ?? new CookieMirror(new CookieJar());
		this.cookieJar = this.cookies.jar;
		if (!inherited) this.cookieJar.load(this.init.cookies);

		const channel = new MessageChannel();
		this.transport = new RemoteTransport(channel.port1, {
			cookies: this.cookies,
		});
		sw?.postMessage(
			{
				$sw$initRemoteTransport: {
					port: channel.port2,
					prefix: this.init.prefix.href,
				},
			},
			[channel.port2]
		);

		// a page that is hidden or gone cannot answer, so it stops holding up
		// the responses that set cookies, and catches up with a snapshot when
		// it is shown again
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
			onPageHide as EventListener
		);
		EventTarget_addEventListener.call(
			this.global,
			"pageshow",
			onPageShow as EventListener
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
		let controllerFrame = frame?.[CONTROLLERFRAME];
		let isTopLevel = true;
		if (!controllerFrame) {
			isTopLevel = false;
			let currentwin = this.global.window;
			while (currentwin.parent !== currentwin) {
				const currentclient = currentwin[SCRAMJETCLIENT];
				if (!currentclient) {
					currentwin = currentwin.parent.window;
					continue;
				}
				const currentFrame = new currentclient.native.window(currentwin)
					.frameElement;
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
			interface: {
				getInjectScripts: this.init.yieldGetInjectScripts(
					this.init.config,
					this.init.sjconfig,
					this.init.prefix,
					this.cookieJar,
					this.init.codecEncode,
					this.init.codecDecode
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
			shouldBlockMessageEvent: () => {
				return false;
			},
			hookSubcontext: (frameself) => {
				const context = new ExecutionContextWrapper(
					frameself,
					{
						...this.init,
						cookies: this.cookieJar.dump(),
						// a frame hooked before the proxy serves it anything keeps the
						// browser's referrer, not this document's
						referrer: undefined,
					},
					this
				);
				return context.client;
			},
			initHeaders: this.init.initHeaders,
			referrer: this.init.referrer,
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
