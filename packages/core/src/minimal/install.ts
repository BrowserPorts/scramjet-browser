import { identityName } from "@/runtime-identity";
import {
	RemoteTransport,
	RpcLink,
	remoteTransportMethods,
} from "@mercuryworkshop/rpc";
import { Plugin, Tap } from "@/Tap";
import type { ScramjetMinimalPlugin } from "@/plugins/types";
import {
	ScramjetMinimalClient,
	type ScramjetMinimalConfig,
	type ScramjetMinimalOptions,
} from "./client";
import { NativeMap } from "./natives";
import type { ProxyTransport } from "./types";

/**
 * The client of each global scope this bundle installed into. Kept here rather than on the global,
 * where a page could find it; a second copy of the bundle in the same window is never evaluated,
 * since start() strips the boot tag from the document it writes back.
 */
const clients = new WeakMap<object, ScramjetMinimalClient>();
/** The first message a wrapped worker receives, carrying its link to the page */
export const WORKER_INIT = identityName("scramjet-minimal-init");
/** Hands a shared worker stand-in one more connection */
export const SHARED_CONNECT = identityName("scramjet-minimal-connect");

/** Neutral runtime bundles receive the publication identity through their config */
export function workerMessageTypes(
	config: Pick<ScramjetMinimalConfig, "identityKey"> = {}
) {
	return {
		init: identityName("scramjet-minimal-init", config.identityKey),
		connect: identityName("scramjet-minimal-connect", config.identityKey),
	};
}

const registry = new NativeMap<string, ScramjetMinimalPlugin>();

/**
 * Registers plugins for every client this bundle installs: the page's, its workers' (which load
 * the same bundle) and its nested windows'. A later registration under the same name replaces
 * the earlier one.
 */
export function register(...plugins: ScramjetMinimalPlugin[]) {
	for (const plugin of plugins) registry.set(plugin.name, plugin);
}

/** The plugins registered so far, by name */
export function registered(): string[] {
	return Array.from(registry.keys());
}

/** The client installed in a global scope, if any */
export function installed(
	scope: typeof globalThis = globalThis
): ScramjetMinimalClient | null {
	return clients.get(scope) ?? null;
}

function active(client: ScramjetMinimalClient): ScramjetMinimalPlugin[] {
	const worker =
		typeof (client.global as { document?: unknown }).document === "undefined";
	return Array.from(registry.values())
		.filter((plugin) =>
			(plugin.scope ?? ["window", "worker"]).includes(
				worker ? "worker" : "window"
			)
		)
		.filter((plugin) => !plugin.enabled || plugin.enabled(client))
		.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Required plugins gate author execution even outside a host frame */
export function requiresPreparation(client: ScramjetMinimalClient): boolean {
	return active(client).some((plugin) => plugin.required === true);
}

/** Runs every active plugin's prepare step, with the host's welcome payload by plugin name */
export async function prepare(
	client: ScramjetMinimalClient,
	link: RpcLink | null,
	payload: unknown
): Promise<undefined> {
	const byName = (payload ?? {}) as Record<string, unknown>;
	for (const plugin of active(client)) {
		try {
			await plugin.prepare?.(client, { link, payload: byName[plugin.name] });
		} catch (error) {
			client.report(error, client.base);
			if (plugin.required) throw error;
			console.error(`Scramjet plugin ${plugin.name} could not prepare`, error);
		}
	}
	return undefined;
}

function hook(client: ScramjetMinimalClient) {
	client.maskToString();
	for (const plugin of active(client)) {
		plugin.install(client, client.global, {
			tap: new Plugin(plugin.name),
			subcontext: (child) => installSubcontext(child, client),
		});
	}
}

/**
 * Installs the plugins in a same-origin child window the page made. It shares the page's transport
 * and link; plugins that keep state, such as storage, point the child at the page's.
 */
function installSubcontext(
	child: Window & typeof globalThis,
	parent: ScramjetMinimalClient
): ScramjetMinimalClient | null {
	const global = child as typeof globalThis;
	const existing = clients.get(global);
	if (existing) return existing;
	try {
		void global.document;
	} catch {
		// A cross-origin child cannot be reached; it installs its own client when it boots
		return null;
	}
	const client = new ScramjetMinimalClient(
		global,
		{ ...parent.config, base: undefined },
		{
			transport: async () => parent.transport,
			onError: parent.options.onError,
		}
	);
	client.link = parent.link;
	client.remote = parent.remote;
	client.storage = parent.storage;
	clients.set(global, client);
	hook(client);
	return client;
}

export type InstallOptions = Pick<ScramjetMinimalOptions, "onError"> & {
	/** The host's link; the transport then runs over its "transport" channel */
	link?: RpcLink | null;
	/** Overrides how the transport starts, when the page holds its own */
	transport?: () => Promise<ProxyTransport>;
};

/** Starts the transport from config.transport and config.wisp */
async function importTransport(
	config: ScramjetMinimalConfig
): Promise<ProxyTransport> {
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
}

/**
 * Installs a minimal client with the registered plugins on this page. A second call returns the
 * client already installed, since a page written again with document.write runs its scripts again.
 */
export function install(
	config: ScramjetMinimalConfig,
	options: InstallOptions = {}
): ScramjetMinimalClient {
	const global = globalThis;
	const existing = clients.get(global);
	if (existing) {
		if (options.link && !existing.link) attach(existing, options.link);
		Tap.dispatchSync(
			existing.hooks.written,
			{ window: global as unknown as Window },
			{}
		);
		return existing;
	}
	let remote: RemoteTransport | null = null;
	const client = new ScramjetMinimalClient(global, config, {
		transport: async () => {
			if (options.transport) return options.transport();
			if (remote) return remote;
			return importTransport(config);
		},
		onError: options.onError,
	});
	if (options.link) {
		client.link = options.link;
		remote = new RemoteTransport(options.link, { ready: true });
		client.remote = remote;
	}
	clients.set(global, client);
	hook(client);
	return client;
}

/**
 * Gives an installed client its host's link once the host answers. Requests made before then wait
 * for it, since the transport starts on first use.
 */
export function attach(client: ScramjetMinimalClient, link: RpcLink) {
	client.link = link;
	const remote = new RemoteTransport(link, { ready: true });
	client.remote = remote;
	if (!client.transport.ready) client.transport.load = async () => remote;
}

/** What a worker's plugin hands the worker it started, with the worker's link as the first port */
export type WorkerInit = {
	type: typeof WORKER_INIT;
	entry: string;
	base: string;
	config: ScramjetMinimalConfig;
	/** Whether the worker's own script is a module */
	module?: boolean;
	/** Whether the worker stands in for a SharedWorker, whose connections arrive as connect events */
	shared?: boolean;
	payload?: unknown;
};

/**
 * Runs in a worker the page's Worker plugin started, as soon as the bundle loads there: the bundle
 * calls it itself, so the worker's bootstrap only loads the bundle and the worker's scope gets no
 * global of Scramjet's. It waits for the page's link, installs the registered plugins, then runs
 * the worker's own script and hands it the messages that arrived meanwhile.
 */
export function worker(): Promise<undefined> {
	const scope = globalThis as typeof globalThis & {
		importScripts: (...urls: string[]) => unknown;
		onconnect?: ((event: MessageEvent) => unknown) | null;
	};
	const buffered: MessageEvent[] = [];
	let ready = false;
	let shared = false;
	let messageTypes = workerMessageTypes();
	const connect = (port: MessagePort) =>
		scope.dispatchEvent(
			new MessageEvent("connect", { ports: [port], data: "" })
		);
	// Registered before the worker's own script exists, so it always runs first and can keep the
	// messages Scramjet sends to itself out of the script's sight
	scope.addEventListener(
		"message",
		(event) => {
			if (!ready) return;
			if (!shared || event.data?.type !== messageTypes.connect || !event.ports[0])
				return;
			event.stopImmediatePropagation();
			connect(event.ports[0]);
		},
		true
	);
	return new Promise((resolve, reject) => {
		const capture = (event: MessageEvent) => {
			if (ready) return;
			event.stopImmediatePropagation();
			const init = event.data as WorkerInit | undefined;
			let expected: ReturnType<typeof workerMessageTypes> | undefined;
			try {
				if (init?.config && typeof init.config === "object")
					expected = workerMessageTypes(init.config);
			} catch {
				// Author messages can arrive before the host's initialization message
			}
			if (
				!expected || init?.type !== expected.init ||
				!event.ports[0] || clients.has(scope)
			) {
				buffered.push(event);
				return;
			}
			messageTypes = expected;
			shared = init.shared === true;
			if (shared) {
				// A SharedWorker stand-in turns each connection into a connect event, as a shared
				// worker's global scope would
				let onconnect: ((event: MessageEvent) => unknown) | null = null;
				Object.defineProperty(scope, "onconnect", {
					configurable: true,
					enumerable: true,
					get: () => onconnect,
					set: (value) => {
						if (onconnect)
							scope.removeEventListener("connect", onconnect as EventListener);
						onconnect = typeof value === "function" ? value : null;
						if (onconnect)
							scope.addEventListener("connect", onconnect as EventListener);
					},
				});
			}
			const link = new RpcLink(event.ports[0]);
			const remote = new RemoteTransport(link, { ready: true });
			const client = new ScramjetMinimalClient(
				scope,
				{ ...init.config, base: init.base },
				{ transport: async () => remote }
			);
			client.link = link;
			client.remote = remote;
			clients.set(scope, client);
			hook(client);
			const started = () => {
				ready = true;
				scope.removeEventListener("message", capture, true);
				for (const queued of buffered.splice(0)) {
					if (
						shared &&
						queued.data?.type === messageTypes.connect &&
						queued.ports[0]
					) {
						connect(queued.ports[0]);
						continue;
					}
					scope.dispatchEvent(
						new MessageEvent("message", {
							data: queued.data,
							ports: Array.from(queued.ports),
							origin: queued.origin,
						})
					);
				}
				resolve(undefined);
			};
			// Plugins prepare before the worker's own script, as they do before a page's
			prepare(client, link, init.payload).then(() => {
				if (init.module) {
					import(/* @vite-ignore */ /* webpackIgnore: true */ init.entry).then(
						started,
						reject
					);
					return;
				}
				try {
					scope.importScripts(init.entry);
				} catch (error) {
					reject(error);
					throw error;
				}
				started();
			}, reject);
		};
		scope.addEventListener("message", capture, true);
	});
}

/**
 * The page's side of a worker's link: a port whose "transport" channel the page answers with its
 * own transport. Plugins open their own channels on the returned link before handing the port over.
 */
export function workerLink(client: ScramjetMinimalClient): {
	port: MessagePort;
	link: RpcLink;
} {
	const channel = new MessageChannel();
	const link = new RpcLink(channel.port1);
	link.channel(
		"transport",
		remoteTransportMethods({ transport: client.transport })
	);
	return { port: channel.port2, link };
}
