/**
 * The host's side of Scramjet's frame mode, for the page that frames a game: a same-origin fence
 * frame whose policy forbids every frame load, the sandboxed frame inside it started from a boot
 * stub, link answers that carry the runtime and the document, and navigations replayed from the
 * fence's violation reports. It holds no client, so a host page loads none of the runtime.
 */
import { RpcHelper, RpcLink } from "@mercuryworkshop/rpc";
import { acceptLinks, LINK_KEY } from "@/minimal/link";
import { FRAME_CHANNEL, frameStub } from "../stub";
import type {
	FrameChannel,
	FrameHistory,
	FrameLocal,
	FrameNavigation,
	FrameWelcome,
} from "../types";

export { FRAME_CHANNEL, FRAME_POLICY, frameStub, type FrameStubOptions } from "../stub";
export { acceptLinks, LINK_ABI, LINK_KEY, type LinkAnswer, type LinkRequest } from "@/minimal/link";
export { RpcHelper, RpcLink };
export type * from "../types";

/**
 * The fence's own policy: no frame may load anything. A navigation of the frame inside it, to any
 * URL, is blocked before a request leaves, and reported to the fence with its full path and query
 * when the target is on the fence's origin (measured in Chromium and Safari).
 */
export const FENCE_POLICY = "frame-src 'none'";

/** A blocked navigation as the fence reported it */
export type BlockedNavigation =
	| { kind: "same-origin"; url: string }
	/** Another origin's target is reported by its origin only */
	| { kind: "cross-origin"; origin: string };

/** Reads a fence's violation report as the navigation it blocked, or null for anything else */
export function blockedNavigation(event: SecurityPolicyViolationEvent, origin: string): BlockedNavigation | null {
	if (event.effectiveDirective !== "frame-src" && event.effectiveDirective !== "child-src") return null;
	const blocked = event.blockedURI;
	if (!blocked) return null;
	let url: URL;
	try {
		url = new URL(blocked);
	} catch {
		return null;
	}
	if (url.origin === origin) return { kind: "same-origin", url: url.href };
	return { kind: "cross-origin", origin: url.origin };
}

/** What the embedder builds for a stub that asked for a link: the port, payload and frame welcome */
export type FrameAnswer = {
	port: MessagePort;
	payload?: unknown;
	transfer?: Transferable[];
	frame: Omit<FrameWelcome, "allow" | "history">;
};

export type FrameHostOptions = {
	/** The feature policy the fence, the frame and every frame inside it carry */
	allow: string;
	/** The frame's sandbox; it must not allow the fence's origin */
	sandbox: string;
	/** The document the frame starts at */
	navigation: FrameNavigation;
	/** The link key stubs ask on; defaults to Scramjet's */
	key?: string;
	/** Builds the answer for the frame's stub, which shows `navigation` */
	answer: (navigation: FrameNavigation) => Promise<FrameAnswer>;
	/** A navigation left the fence's origin, which no document is built for */
	onLeave?: (url: string) => void;
	/** Messages the game's document posts to its parent, which is the fence */
	onMessage?: (event: MessageEvent) => void;
	/** The frame's document was written and finished loading */
	onLoad?: () => void;
	onError?: (error: unknown) => void;
};

/**
 * One game in a fence. The fence is a same-origin srcdoc frame carrying {@link FENCE_POLICY}; the
 * game's frame inside it is sandboxed without allow-same-origin and starts from a boot stub, which
 * asks the fence's window for a link. The host keeps the session's history by documents: each
 * navigation, whether the frame asked for it or the fence blocked it, builds a new document from
 * the same stub at the new URL.
 */
export class FrameHost {
	/** The fence, which the embedder puts in its page */
	readonly element: HTMLIFrameElement;
	/** The game's frame inside the fence, once the fence loaded */
	frame: HTMLIFrameElement | null = null;
	#entries: FrameNavigation[];
	#index = 0;
	#stub: string;
	#stops: (() => void)[] = [];
	#closed = false;
	#loads = 0;

	constructor(readonly options: FrameHostOptions) {
		this.#entries = [options.navigation];
		this.#stub = frameStub({ key: options.key ?? LINK_KEY });
		const fence = document.createElement("iframe");
		fence.allow = options.allow;
		fence.setAttribute("allowfullscreen", "");
		fence.srcdoc = `<!doctype html><html><head><meta http-equiv="content-security-policy" content="${FENCE_POLICY}"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block;overflow:hidden;background:transparent}</style></head><body></body></html>`;
		fence.addEventListener("load", () => this.#fenced(), { once: true });
		this.element = fence;
	}

	/** The document the frame shows now */
	get current(): FrameNavigation {
		return this.#entries[this.#index]!;
	}

	get history(): FrameHistory {
		return { before: this.#index, after: this.#entries.length - this.#index - 1 };
	}

	#fenced() {
		if (this.#closed) return;
		const fence = this.element.contentWindow;
		const document = this.element.contentDocument;
		if (!fence || !document) return;
		const origin = fence.location.origin;
		// The frame trusts only its parent, and sees the realm that posted a message as its source, so
		// answers are posted from the fence's realm rather than this page's
		const post = new (fence as unknown as typeof globalThis).Function(
			"target",
			"message",
			"transfer",
			"target.postMessage(message, '*', transfer)"
		) as (target: Window, message: unknown, transfer: Transferable[]) => void;
		const frame = document.createElement("iframe");
		frame.setAttribute("sandbox", this.options.sandbox);
		frame.allow = this.options.allow;
		frame.setAttribute("allowfullscreen", "");
		frame.referrerPolicy = "no-referrer";
		this.frame = frame;
		// The stub's document fires the first load; each written document fires another
		frame.addEventListener("load", () => {
			if (this.#loads++ > 0) this.options.onLoad?.();
		});
		this.#stops.push(
			acceptLinks(
				fence,
				async ({ source }) => {
					if (source !== frame.contentWindow) return null;
					const navigation = this.current;
					const answer = await this.options.answer(navigation);
					return {
						port: answer.port,
						payload: answer.payload,
						transfer: answer.transfer,
						frame: { ...answer.frame, allow: this.options.allow, history: this.history } satisfies FrameWelcome,
					};
				},
				{ key: this.options.key, post }
			)
		);
		const violation = (event: Event) => {
			const blocked = blockedNavigation(event as SecurityPolicyViolationEvent, origin);
			if (!blocked) return;
			if (blocked.kind === "cross-origin") this.options.onLeave?.(blocked.origin);
			else this.navigate({ url: blocked.url });
		};
		fence.addEventListener("securitypolicyviolation", violation, true);
		this.#stops.push(() => fence.removeEventListener("securitypolicyviolation", violation, true));
		const message = (event: MessageEvent) => {
			if (event.source === frame.contentWindow) this.options.onMessage?.(event);
		};
		fence.addEventListener("message", message);
		this.#stops.push(() => fence.removeEventListener("message", message));
		frame.srcdoc = this.#stub;
		document.body.append(frame);
	}

	/** Builds a new document in the frame, as a navigation of it would */
	navigate(navigation: FrameNavigation) {
		if (this.#closed) return;
		if (navigation.replace) this.#entries[this.#index] = navigation;
		else {
			this.#entries.splice(this.#index + 1, Infinity, navigation);
			this.#index = this.#entries.length - 1;
		}
		this.reload();
	}

	/** Moves through the session's documents, as history.go does past the current one */
	traverse(delta: number) {
		const target = this.#index + delta;
		if (this.#closed || !delta || target < 0 || target >= this.#entries.length) return;
		this.#index = target;
		this.reload();
	}

	/** Builds the current document again, from the stub */
	reload() {
		if (!this.frame || this.#closed) return;
		this.#loads = 0;
		this.frame.srcdoc = this.#stub;
	}

	close() {
		this.#closed = true;
		for (const stop of this.#stops.splice(0)) stop();
		this.frame?.remove();
		this.element.srcdoc = "";
	}
}

/**
 * Serves the frame's channel on a link the embedder made: navigations and traversals of the frame,
 * and links for frames inside it. Returns the helper whose `child` calls reach the frame.
 */
export function serveFrame(
	link: RpcLink,
	methods: {
		navigate(navigation: FrameNavigation): void | Promise<void>;
		traverse(delta: number): void | Promise<void>;
		connect(child: FrameChannel["connect"][0]): Promise<FrameAnswer & { frame: FrameWelcome }>;
	}
): RpcHelper<FrameChannel, FrameLocal> {
	return link.channel<FrameChannel, FrameLocal>(FRAME_CHANNEL, {
		navigate: async (navigation) => {
			await methods.navigate(navigation);
		},
		traverse: async ({ delta }) => {
			await methods.traverse(delta);
		},
		connect: async (child) => {
			const answer = await methods.connect(child);
			return [
				{ port: answer.port, payload: answer.payload, frame: answer.frame },
				[answer.port, ...(answer.transfer ?? [])],
			];
		},
	});
}
