import type { RawHeaders } from "@mercuryworkshop/proxy-transports";

// the remote transport the controller serves; its socket events wait for
// the connect reply, and it is ready once the controller says so
import { RemoteTransport } from "@mercuryworkshop/rpc";
import type { Config } from ".";
import { CONTROLLERFRAME } from "./symbols";
import type { SerializedCookieSyncEntry } from "./types";
import {
	CookieJar,
	SCRAMJETCLIENT,
	ScramjetClient,
	setWasm,
	Tap,
	type CookieSyncOptions,
	type ScramjetConfig,
	type ScramjetContext,
} from "@mercuryworkshop/scramjet";

const sw = navigator.serviceWorker?.controller;

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
		((globalThis as any)[SCRAMJETCLIENT] as ScramjetClient).syncDocumentInit({
			initHeaders: init.initHeaders,
			referrer: init.referrer,
			cookies: init.cookies,
		});
		return;
	}
	if (!("WASM" in self)) {
		throw new Error("WASM not found in global scope!");
	}
	const wasm = Uint8Array.from(atob(self.WASM as string), (c) => c.charCodeAt(0));
	delete (self as any).WASM;
	setWasm(wasm);

	new ExecutionContextWrapper(globalThis, init);
}

class ExecutionContextWrapper {
	client!: ScramjetClient;
	cookieJar: CookieJar;
	transport: RemoteTransport;
	private handleServiceWorkerCookieMessage: (event: MessageEvent) => void;

	constructor(
		public global: typeof globalThis,
		public init: Init
	) {
		const channel = new MessageChannel();
		this.transport = new RemoteTransport(channel.port1);
		sw?.postMessage(
			{
				$sw$initRemoteTransport: {
					port: channel.port2,
					prefix: this.init.prefix.href,
				},
			},
			[channel.port2]
		);

		this.cookieJar = new CookieJar();
		this.cookieJar.load(this.init.cookies);

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
				const targetSw = navigator.serviceWorker?.controller ?? sw;
				targetSw?.postMessage({
					$sw$setCookieDone: {
						id: payload.id,
					},
				});
			}
		};

		navigator.serviceWorker?.addEventListener(
			"message",
			this.handleServiceWorkerCookieMessage
		);

		this.injectScramjet();
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
				const context = new ExecutionContextWrapper(frameself, {
					...this.init,
					cookies: this.cookieJar.dump(),
					// a frame hooked before the proxy serves it anything keeps the
					// browser's referrer, not this document's
					referrer: undefined,
				});
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
