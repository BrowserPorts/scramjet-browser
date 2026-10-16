/**
 * Scramjet's request interceptors without the rest of the proxy. The client intercepts a page's
 * requests and sends the ones that leave its own origin over a Wisp transport itself, so no
 * service worker, URL rewriting or rewriter wasm is involved. Builds pick their interceptors
 * with the INTERCEPT_* flags, and a flag that is off leaves its module out of the bundle.
 */
import {
	InterceptorClient,
	type InterceptorConfig,
	type InterceptorModule,
	type InterceptorOptions,
} from "./client";
import { PortTransport } from "./transport";
import * as beacon from "./modules/beacon";
import * as elements from "./modules/elements";
import * as eventsource from "./modules/eventsource";
import * as fetchInterceptor from "./modules/fetch";
import * as importscripts from "./modules/importscripts";
import * as websocket from "./modules/websocket";
import * as workers from "./modules/worker";
import * as xmlhttprequest from "./modules/xmlhttprequest";

export { InterceptorClient, PortTransport };
export type { InterceptorConfig, InterceptorModule, InterceptorOptions };
export type { InterceptorRoute } from "./client";

declare const INTERCEPT_FETCH: boolean;
declare const INTERCEPT_XHR: boolean;
declare const INTERCEPT_WEBSOCKET: boolean;
declare const INTERCEPT_EVENTSOURCE: boolean;
declare const INTERCEPT_BEACON: boolean;
declare const INTERCEPT_WORKER: boolean;
declare const INTERCEPT_ELEMENTS: boolean;

/** The interceptors this build includes, by name */
export const INTERCEPTORS: [string, InterceptorModule][] = [];
if (INTERCEPT_FETCH) INTERCEPTORS.push(["fetch", fetchInterceptor]);
if (INTERCEPT_XHR) INTERCEPTORS.push(["xhr", xmlhttprequest]);
if (INTERCEPT_WEBSOCKET) INTERCEPTORS.push(["websocket", websocket]);
if (INTERCEPT_EVENTSOURCE) INTERCEPTORS.push(["eventsource", eventsource]);
if (INTERCEPT_BEACON) INTERCEPTORS.push(["beacon", beacon]);
if (INTERCEPT_WORKER)
	INTERCEPTORS.push(["worker", workers], ["importscripts", importscripts]);
if (INTERCEPT_ELEMENTS) INTERCEPTORS.push(["elements", elements]);

const INSTALLED = Symbol.for("scramjet.interceptors");

function hook(client: InterceptorClient) {
	const modules = INTERCEPTORS.map(([, module]) => module).sort(
		(a, b) => (a.order ?? 0) - (b.order ?? 0)
	);
	for (const module of modules)
		if (!module.enabled || module.enabled(client))
			module.default(client, client.global);
}

/**
 * Installs this build's interceptors on the page. A second call returns the client already
 * installed, since a page rewritten with document.write runs its scripts again.
 */
export function install(
	config: InterceptorConfig,
	hooks: Pick<InterceptorOptions, "onError"> = {}
): InterceptorClient {
	const global = globalThis as typeof globalThis & {
		[INSTALLED]?: InterceptorClient;
	};
	const installed = global[INSTALLED];
	if (installed) return installed;
	const client = new InterceptorClient(global, config, {
		transport: async () => {
			if (!config.transport || !config.wisp)
				throw new TypeError(
					"No transport is configured for requests to other sites"
				);
			const module = await import(
				/* @vite-ignore */ /* webpackIgnore: true */ config.transport
			);
			const Transport =
				module.default ?? module.LibcurlClient ?? module.EpoxyTransport;
			return new Transport({ wisp: config.wisp });
		},
		onError: hooks.onError,
	});
	hook(client);
	global[INSTALLED] = client;
	return client;
}

/** Messages a wrapped worker receives before its own script has run */
const WORKER_INIT = "scramjet-interceptors-init";

/**
 * Runs in a worker the Worker interceptor started. It waits for the page's transport port,
 * installs the interceptors, then runs the worker's own script and hands it the messages that
 * arrived meanwhile.
 */
export function worker(module = false): Promise<void> {
	const scope = globalThis as typeof globalThis & {
		importScripts: (...urls: string[]) => void;
		[INSTALLED]?: InterceptorClient;
	};
	const buffered: MessageEvent[] = [];
	let ready = false;
	return new Promise((resolve, reject) => {
		const capture = (event: MessageEvent) => {
			if (ready) return;
			event.stopImmediatePropagation();
			if (
				event.data?.type !== WORKER_INIT ||
				!event.ports[0] ||
				scope[INSTALLED]
			) {
				buffered.push(event);
				return;
			}
			const { entry, base, config } = event.data as {
				entry: string;
				base: string;
				config: InterceptorConfig;
			};
			const port = event.ports[0];
			const client = new InterceptorClient(
				scope,
				{ ...config, base },
				{
					transport: async () => new PortTransport(port),
				}
			);
			hook(client);
			scope[INSTALLED] = client;
			const started = () => {
				ready = true;
				scope.removeEventListener("message", capture, true);
				for (const queued of buffered)
					scope.dispatchEvent(
						new MessageEvent("message", {
							data: queued.data,
							ports: Array.from(queued.ports),
							origin: queued.origin,
						})
					);
				buffered.length = 0;
				resolve();
			};
			if (module) {
				import(/* @vite-ignore */ /* webpackIgnore: true */ entry).then(
					started,
					reject
				);
				return;
			}
			scope.importScripts(entry);
			started();
		};
		scope.addEventListener("message", capture, true);
	});
}
