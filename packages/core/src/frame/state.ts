import { RpcLink, type RpcHelper } from "@mercuryworkshop/rpc";
import type { ScramjetMinimalClient } from "@/minimal/client";
import { NativeMap, NativeURL, NativeWeakMap } from "@/minimal/natives";
import { FRAME_CHANNEL } from "./stub";
import type { FrameChannel, FrameHistory, FrameLocal } from "./types";
import type { MethodsDefinition } from "@mercuryworkshop/rpc";

/** The plugin settings key a frame client's config carries its frame settings under */
export const FRAME_PLUGIN = "frame";

/**
 * Frame settings, plain data inside the client's config so a page hands them to its workers with
 * the rest of the config: the runtime's source and the files read ahead travel to every worker.
 */
export type FrameConfig = {
	/** The runtime's source, which workers and nested frames start from */
	runtime: string;
	/** What document.referrer reads */
	referrer?: string;
	/** The feature policy frames inside this one carry */
	allow?: string;
	/** The link key nested stubs ask on */
	key?: string;
	history?: FrameHistory;
	/**
	 * Files read ahead of time, by URL in the codec's space, which synchronous reads (XHR and
	 * importScripts) take from instead of the network
	 */
	files?: Map<string, Blob>;
};

/** What a client running in frame mode knows beyond its URL, in pages and workers alike */
export type FrameState = Required<Omit<FrameConfig, "files">> & {
	files: Map<string, Blob>;
	/** The frame's channel to its host, or null in a worker */
	host: RpcHelper<FrameLocal, FrameChannel> | null;
	/** What the host may call on this frame; plugins fill it in as they install */
	methods: Partial<MethodsDefinition<FrameLocal>>;
};

const states = new NativeWeakMap<ScramjetMinimalClient, FrameState>();
const channels = new NativeWeakMap<
	RpcLink,
	[RpcHelper<FrameLocal, FrameChannel>, Partial<MethodsDefinition<FrameLocal>>]
>();

/** The frame state of a client, or null when it does not run in frame mode */
export function frameOf(client: ScramjetMinimalClient): FrameState | null {
	const existing = states.get(client);
	if (existing) return existing;
	const config = client.config.plugins?.[FRAME_PLUGIN] as FrameConfig | undefined;
	if (!config || typeof config.runtime !== "string") return null;
	config.files ??= new NativeMap();
	const document = typeof (client.global as { document?: unknown }).document !== "undefined";
	const link = client.link;
	let host: RpcHelper<FrameLocal, FrameChannel> | null = null;
	// The channel reads its methods when a call arrives, so plugins add theirs to this object
	let methods: Partial<MethodsDefinition<FrameLocal>> = {};
	if (document && link) {
		const open = channels.get(link);
		if (open) [host, methods] = open;
		else {
			host = link.channel<FrameLocal, FrameChannel>(
				FRAME_CHANNEL,
				methods as MethodsDefinition<FrameLocal>
			);
			channels.set(link, [host, methods]);
		}
	}
	const state: FrameState = {
		runtime: config.runtime,
		referrer: config.referrer ?? "",
		allow: config.allow ?? "",
		key: config.key ?? "",
		history: config.history ?? { before: 0, after: 0 },
		files: config.files,
		host,
		methods,
	};
	states.set(client, state);
	return state;
}

/** The URL a frame client's document or worker stands for, decoded from the codec's space */
export function identityUrl(client: ScramjetMinimalClient, url = client.base): URL {
	const decoded = client.codec.decode(url);
	return new NativeURL(decoded ?? url);
}
