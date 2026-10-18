import { identityName } from "@/runtime-identity";
import { RpcLink } from "@mercuryworkshop/rpc";

/** The message key a framed document and its host use to set up their link */
export const LINK_KEY = identityName("scramjet-link");
/** Bumped when the link's messages change shape */
export const LINK_ABI = 1;

type Hello = { type: "hello"; abi: number; url: string };
type Welcome = {
	type: "welcome";
	abi: number;
	payload?: unknown;
	/** The document's markup, from a host that framed it with srcdoc, which cannot be fetched again */
	document?: string;
};

/**
 * Asks the window that frames this document for a link. The host answers with a MessagePort and
 * whatever it hands a new document (a storage seed, settings). Resolves null outside a frame, when
 * the host speaks another ABI, or when it does not answer in time.
 */
export function requestLink(
	options: { target?: Window; timeout?: number; key?: string } = {}
): Promise<{ link: RpcLink; payload: unknown; document?: string } | null> {
	const key = options.key ?? LINK_KEY;
	const target = options.target ?? globalThis.parent;
	if (!target || target === (globalThis as unknown as Window))
		return Promise.resolve(null);
	return new Promise((resolve) => {
		const done = (
			value: { link: RpcLink; payload: unknown; document?: string } | null
		) => {
			clearTimeout(timer);
			globalThis.removeEventListener("message", listen, true);
			resolve(value);
		};
		const listen = (event: MessageEvent) => {
			if (event.source !== target) return;
			const welcome = event.data?.[key] as Welcome | undefined;
			if (welcome?.type !== "welcome") return;
			event.stopImmediatePropagation();
			if (welcome.abi !== LINK_ABI || !event.ports[0]) return done(null);
			done({
				link: new RpcLink(event.ports[0]),
				payload: welcome.payload,
				document:
					typeof welcome.document === "string" ? welcome.document : undefined,
			});
		};
		const timer = setTimeout(() => done(null), options.timeout ?? 10000);
		globalThis.addEventListener("message", listen, true);
		const hello: Hello = { type: "hello", abi: LINK_ABI, url: location.href };
		target.postMessage({ [key]: hello }, "*");
	});
}

export type LinkAnswer = {
	port: MessagePort;
	payload?: unknown;
	transfer?: Transferable[];
	/** The markup of a document the host framed with srcdoc */
	document?: string;
};

export type LinkRequest = {
	/** The window that asked; compare it with a frame's contentWindow */
	source: Window;
	/** The document's own URL, as it reported it; untrusted */
	url: string;
};

/**
 * The host's side: answers documents in its frames that ask for a link. `accept` decides from the
 * asking window, and returns the port it keeps the other end of, with the payload, or null to stay
 * silent. Returns a function that stops listening.
 */
export function acceptLinks(
	host: Window,
	accept: (
		request: LinkRequest
	) => LinkAnswer | null | Promise<LinkAnswer | null>,
	options: { key?: string } = {}
): () => void {
	const key = options.key ?? LINK_KEY;
	const listen = async (event: MessageEvent) => {
		const hello = event.data?.[key] as Hello | undefined;
		if (hello?.type !== "hello" || !event.source) return;
		// Registered before the page's own listeners, so the page never sees a link being made
		event.stopImmediatePropagation();
		const source = event.source as Window;
		const answer = await accept({ source, url: String(hello.url) });
		if (!answer) return;
		const welcome: Welcome = {
			type: "welcome",
			abi: LINK_ABI,
			payload: answer.payload,
			document: answer.document,
		};
		source.postMessage({ [key]: welcome }, "*", [
			answer.port,
			...(answer.transfer ?? []),
		]);
	};
	host.addEventListener("message", listen, true);
	return () => host.removeEventListener("message", listen, true);
}
