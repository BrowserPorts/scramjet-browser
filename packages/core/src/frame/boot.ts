import { RpcLink } from "@mercuryworkshop/rpc";
import { Tap } from "@/Tap";
import { takeOver } from "@/minimal/boot";
import type { ScramjetMinimalClient, ScramjetMinimalOptions } from "@/minimal/client";
import { install, prepare } from "@/minimal/install";
import { NativeURL } from "@/minimal/natives";
import { Object_getOwnPropertyDescriptor } from "@/shared/snapshot";
import { FRAME_PLUGIN, type FrameConfig } from "./state";
import type { FrameHandoff } from "./types";

/** What the stub left for this runtime, taken once: the global and the script element go with it */
function takeHandoff(): (FrameHandoff & { key: string }) | null {
	if (typeof document === "undefined") return null;
	const script = document.currentScript as HTMLScriptElement | null;
	const key = script?.id;
	if (!script || !key) return null;
	const handoff = Object_getOwnPropertyDescriptor(globalThis, key)?.value as
		| FrameHandoff
		| undefined;
	if (!handoff?.port || !handoff.frame) return null;
	delete (globalThis as Record<string, unknown>)[key];
	script.remove();
	return { ...handoff, key };
}

const attribute = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The href of the page's own <base>, when it has one */
const OWN_BASE = /<base\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/**
 * Puts a <base> first in the document's head, at the document's URL in the codec's space, so its
 * relative URLs resolve there as they would at that URL. A page's own <base> is resolved against
 * the document's URL and stands in its place; the page's element stays, and the browser follows
 * the first one.
 */
export function withBase(client: ScramjetMinimalClient, html: string, url: string): string {
	const own = OWN_BASE.exec(html);
	const raw = own ? (own[1] ?? own[2] ?? own[3] ?? "") : "";
	let href = url;
	if (raw) href = client.resolve(raw.trim(), url)?.href ?? url;
	const base = `<base href="${attribute(href)}">`;
	if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (head) => head + base);
	if (/<html\b[^>]*>/i.test(html))
		return html.replace(/<html\b[^>]*>/i, (root) => `${root}<head>${base}</head>`);
	const doctype = /^\s*<!doctype[^>]*>/i.exec(html)?.[0] ?? "";
	return doctype + base + html.slice(doctype.length);
}

export type StartFrameOptions = Pick<ScramjetMinimalOptions, "onError">;

/**
 * Starts the runtime in a frame a boot stub started: installs the registered plugins with the
 * host's link, every request routed over it, prepares them, then writes the document the host sent
 * through the document hooks, with its <base> at the document's URL. Returns null when this
 * runtime was not started by a stub.
 */
export function startFrame(options: StartFrameOptions = {}): ScramjetMinimalClient | null {
	const handoff = takeHandoff();
	if (!handoff) return null;
	const { frame, key } = handoff;
	const link = new RpcLink(handoff.port);
	const page = frame.document;
	const settings: FrameConfig = {
		runtime: frame.runtime,
		referrer: page.referrer ?? "",
		allow: frame.allow ?? "",
		key,
		history: frame.history ?? { before: 0, after: 0 },
	};
	const client = install(
		{
			...frame.config,
			nativeRoutes: false,
			base: new NativeURL(page.url).href,
			plugins: { ...frame.config.plugins, [FRAME_PLUGIN]: settings },
		},
		{ link, onError: options.onError }
	);
	takeOver(
		async () => {
			try {
				await prepare(client, link, handoff.payload);
			} catch (error) {
				client.report(error, client.base);
				throw error;
			}
			return page.html;
		},
		async (html) => {
			const props = { html };
			await Tap.dispatchSeries(client.hooks.document, { url: client.base }, props);
			return withBase(client, props.html, client.base);
		},
		() => {
			Tap.dispatchSync(client.hooks.written, { window: globalThis as unknown as Window }, {});
		},
		client.nativeFetch
	);
	return client;
}
