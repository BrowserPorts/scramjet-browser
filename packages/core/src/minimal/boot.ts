import { Tap } from "@/Tap";
import type { ScramjetMinimalClient, ScramjetMinimalConfig } from "./client";
import { attach, install, prepare, type InstallOptions } from "./install";
import { requestLink } from "./link";

/** Global scopes whose document start() took over, kept out of the page's reach */
const taken = new WeakSet<object>();

/**
 * Holds the document's own scripts back until async work finishes, such as waiting for the host's
 * link and storage. Call it from a classic script at the top of <head>: the browser stops parsing
 * once the script returns, the work runs, and the document is fetched again (from the HTTP cache),
 * or taken from what the work returned, and written back. Hooks installed before stay, since document.open keeps the window, and the
 * written document runs this script again, which then returns false.
 *
 * Returns whether it took the document over.
 */
export function takeOver(
	work: () => Promise<string | void>,
	transform: (html: string) => string | Promise<string> = (html) => html,
	written: () => void = () => {}
): boolean {
	if (taken.has(globalThis) || typeof document === "undefined") return false;
	taken.add(globalThis);
	const url = location.href;
	const fetchNative = fetch.bind(globalThis);
	// document.open does nothing while the parser runs this script, so the load is stopped instead,
	// which aborts the parser once this script returns
	stop();
	// A srcdoc document has no URL to fetch again; its host hands the markup back instead
	const refetch = location.protocol !== "about:";
	const page = refetch
		? fetchNative(url, { cache: "force-cache", credentials: "same-origin" }).then((response) => response.text())
		: null;
	page?.catch(() => undefined);
	work()
		.catch((error) => {
			console.error("Scramjet could not finish starting", error);
		})
		.then((markup) => {
			if (typeof markup === "string") return markup;
			if (page) return page;
			throw new Error("The document cannot be loaded again");
		})
		.then(transform)
		.then(
			(html) => {
				document.open();
				// document.open drops the window's listeners, which plugins add back here
				written();
				document.write(html);
				document.close();
			},
			(error) => console.error("Scramjet could not load the page again", error)
		);
	return true;
}

/** Whether this document is the one takeOver wrote back */
export function tookOver(): boolean {
	return taken.has(globalThis);
}

export type StartOptions = InstallOptions & {
	/** Wait for the host before the document runs; defaults to true inside a frame */
	handshake?: boolean;
	/** How long to wait for the host, in milliseconds */
	timeout?: number;
};

/**
 * Installs the registered plugins and, inside a frame, holds the document until its host answers
 * and every plugin prepared. Outside a frame, or with the handshake off, plugins prepare with no
 * link while the document runs.
 */
export function start(
	config: ScramjetMinimalConfig,
	options: StartOptions = {}
): ScramjetMinimalClient {
	const client = install(config, options);
	if (tookOver()) return client;
	const framed = globalThis.parent && globalThis.parent !== (globalThis as unknown as Window);
	if (!framed || options.handshake === false || options.link) {
		void prepare(client, options.link ?? null, undefined);
		return client;
	}
	takeOver(
		async () => {
			const linked = await requestLink({ timeout: options.timeout });
			if (linked) attach(client, linked.link);
			await prepare(client, linked?.link ?? null, linked?.payload);
			return linked?.document;
		},
		async (html) => {
			const props = { html };
			await Tap.dispatch(client.hooks.document, { url: location.href }, props);
			return props.html;
		},
		() => void Tap.dispatch(client.hooks.written, { window: globalThis as unknown as Window }, {})
	);
	return client;
}
