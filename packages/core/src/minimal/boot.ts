import { Tap } from "@/Tap";
import type { ScramjetMinimalClient, ScramjetMinimalConfig } from "./client";
import {
	attach,
	install,
	prepare,
	requiresPreparation,
	type InstallOptions,
} from "./install";
import { requestLink } from "./link";

/** Global scopes whose document start() took over, kept out of the page's reach */
const taken = new WeakSet<object>();

/**
 * Holds the document's own scripts back until async work finishes, such as waiting for the host's
 * link and storage. Call it from a parser-blocking classic script at the top of <head>: the rest of
 * the document is parsed as inert text once the script returns, the work runs, and the document is
 * fetched again (from the HTTP cache), or taken from what the work returned, and written back.
 * Hooks installed before stay, since document.open keeps the window, and the written document runs
 * this script again, which then returns false.
 *
 * Returns whether it took the document over.
 */
export function takeOver(
	work: () => Promise<unknown>,
	transform: (html: string) => string | Promise<string> = (html) => html,
	written: () => unknown = () => undefined,
	fetchDocument: typeof fetch = fetch.bind(globalThis)
): boolean {
	if (taken.has(globalThis) || typeof document === "undefined") return false;
	taken.add(globalThis);
	const url = location.href;
	// Required plugins may wrap author-facing sinks while preparation runs
	// The document hook already transformed the replacement before these sinks receive it
	const openDocument = document.open.bind(document);
	const writeDocument = document.write.bind(document);
	const closeDocument = document.close.bind(document);
	// document.open does nothing while the parser runs this script, and nothing ever again once the
	// parser was aborted, so the load is not stopped. The rest of the document becomes the text of
	// a hidden plaintext element instead: none of its scripts run, and the parser finishes normally,
	// which leaves document.open working once the work is done. A document already parsed has no
	// scripts left to hold back, and writing to it would replace it now
	if (document.readyState === "loading") writeDocument("<plaintext hidden>");
	// A srcdoc document has no URL to fetch again; its host hands the markup back instead
	const refetch = location.protocol !== "about:";
	const page = refetch
		? fetchDocument(url, {
				cache: "force-cache",
				credentials: "same-origin",
			}).then((response) => response.text())
		: null;
	page?.catch(() => undefined);
	work()
		.then((markup) => {
			if (typeof markup === "string") return markup;
			if (page) return page;
			throw new Error("The document cannot be loaded again");
		})
		.then(transform)
		.then(
			(html) => {
				openDocument();
				// document.open drops the window's listeners, which plugins add back here
				written();
				writeDocument(html);
				closeDocument();
			},
			(error) => console.error("Page preparation failed", error)
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
	const framed =
		globalThis.parent &&
		globalThis.parent !== (globalThis as unknown as Window);
	const handshake = framed && options.handshake !== false && !options.link;
	if (!handshake && !requiresPreparation(client)) {
		prepare(client, options.link ?? null, undefined).catch((error) =>
			client.report(error, client.base)
		);
		return client;
	}
	takeOver(
		async () => {
			const linked = handshake
				? await requestLink({ timeout: options.timeout, key: config.linkKey })
				: null;
			if (linked) attach(client, linked.link);
			try {
				await prepare(
					client,
					linked?.link ?? options.link ?? null,
					linked?.payload
				);
			} catch (error) {
				client.report(error, client.base);
				throw error;
			}
			return linked?.document;
		},
		async (html) => {
			const props = { html };
			await Tap.dispatchSeries(
				client.hooks.document,
				{ url: location.href },
				props
			);
			return props.html;
		},
		() => {
			Tap.dispatchSync(
				client.hooks.written,
				{ window: globalThis as unknown as Window },
				{}
			);
		},
		// Preparation can still be installing request hooks while the original document loads
		client.nativeFetch
	);
	return client;
}
