import { identityName } from "@/runtime-identity";
import { LINK_ABI, LINK_KEY } from "@/minimal/link";

/** The channel id of the frame's channel to its host (see FrameChannel) */
export const FRAME_CHANNEL = identityName("scramjet-frame");

/**
 * The policy a frame's own document runs under. Nothing loads from the network: scripts, styles,
 * media, workers and connections come only from blob and data URLs the frame made and from inline
 * code, so a load the runtime missed fails instead of leaving. The fence around the top frame adds
 * frame-src 'none', which every frame below inherits.
 */
export const FRAME_POLICY = [
	"default-src 'none'",
	"script-src blob: data: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
	"style-src blob: data: 'unsafe-inline'",
	"img-src blob: data:",
	"font-src blob: data:",
	"media-src blob: data: mediastream:",
	"connect-src blob: data:",
	"worker-src blob: data:",
	"child-src blob: data:",
	"frame-src 'none'",
	"object-src blob: data:",
	"manifest-src 'none'",
	"base-uri http: https:",
].join("; ");

const attribute = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The stub's loader, kept as source text rather than a serialized function, since a build that
 * obfuscates the host's bundle would leave a function calling helpers the stub does not have. It
 * asks the frame's parent for a link, and on the welcome runs the runtime the host sent from a
 * blob this frame made (the frame cannot load blobs its parent made). The runtime finds the port
 * and welcome under the link key, named by the id of the script element that runs it, and removes
 * both before any of the page's code exists.
 */
const LOADER = `(key, abi) => {
	const target = parent;
	const listen = (event) => {
		if (event.source !== target) return;
		const answer = event.data && event.data[key];
		if (!answer || answer.abi !== abi || answer.type === "pending") return;
		event.stopImmediatePropagation();
		removeEventListener("message", listen, true);
		const port = event.ports[0];
		const frame = answer.frame;
		if (answer.type !== "welcome" || !port || !frame || typeof frame.runtime !== "string") return;
		Object.defineProperty(globalThis, key, { configurable: true, value: { port, payload: answer.payload, frame } });
		const script = document.createElement("script");
		script.id = key;
		script.src = URL.createObjectURL(new Blob([frame.runtime], { type: "text/javascript" }));
		document.documentElement.appendChild(script);
	};
	addEventListener("message", listen, true);
	target.postMessage({ [key]: { type: "hello", abi, url: location.href } }, "*");
}`;

export type FrameStubOptions = {
	/** The link key the host answers on; defaults to Scramjet's */
	key?: string;
	/** Replaces the frame's own policy */
	policy?: string;
};

/**
 * The srcdoc of a frame that a host fills over its link: the frame's policy and a few hundred
 * bytes of loader, and no page markup, so the parser has nothing to load before the runtime runs.
 */
export function frameStub(options: FrameStubOptions = {}): string {
	const key = options.key ?? LINK_KEY;
	const policy = options.policy ?? FRAME_POLICY;
	return `<!doctype html><html><head><meta http-equiv="content-security-policy" content="${attribute(policy)}"><script>(${LOADER})(${JSON.stringify(key)},${LINK_ABI})</script></head></html>`;
}
