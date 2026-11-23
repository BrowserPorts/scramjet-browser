import type { ScramjetMinimalClient } from "@/minimal/client";
import { acceptLinks } from "@/minimal/link";
import { NativeMap, NativeWeakMap } from "@/minimal/natives";
import type { MinimalPluginContext, ScramjetMinimalPlugin } from "@/plugins/types";
import { Reflect_apply } from "@/shared/snapshot";
import { frameOf } from "../state";
import { frameStub } from "../stub";
import type { FrameNavigation } from "../types";

const INSERTERS = [
	"Node.prototype.appendChild",
	"Node.prototype.insertBefore",
	"Node.prototype.replaceChild",
	"Element.prototype.append",
	"Element.prototype.prepend",
	"Element.prototype.before",
	"Element.prototype.after",
	"Element.prototype.replaceWith",
	"Element.prototype.insertAdjacentElement",
	"Document.prototype.append",
	"Document.prototype.prepend",
] as const;

type Child = { id: number; navigation: FrameNavigation; html?: string };

/**
 * Frames the page makes become boot stubs, like the frame they are in: a frame's src, srcdoc or
 * parser-written attributes never load natively. Each stub carries the feature policy, since a
 * level without it loses fullscreen, gamepads and cross-origin isolation (measured), and asks this
 * frame for a link, which the host makes with the page the frame was meant to show. Reads of src
 * and srcdoc return what the page set.
 *
 * A child is opaque to this frame, so a script navigation inside it is blocked by the policy it
 * inherits and cannot be replayed (an opaque document's report names only the target's origin).
 * Links and forms in it are caught by its own runtime and come back here through the host.
 */
function install(
	client: ScramjetMinimalClient,
	self: typeof globalThis,
	{ tap }: MinimalPluginContext<ScramjetMinimalClient>
) {
	const state = frameOf(client)!;
	const page = self as Window & typeof globalThis;
	const nativeSet = page.Element.prototype.setAttribute;
	const nativeGet = page.Element.prototype.getAttribute;
	const querySelectorAll = page.Element.prototype.querySelectorAll;
	const set = (element: Element, name: string, value: string) =>
		Reflect_apply(nativeSet, element, [name, value]);
	const get = (element: Element, name: string) =>
		Reflect_apply(nativeGet, element, [name]) as string | null;
	const stub = frameStub({ key: state.key });
	/** What each frame element was asked to show */
	const children = new NativeWeakMap<Element, Child & { src?: string; srcdoc?: string }>();
	const byId = new NativeMap<number, Element>();
	let next = 1;
	const isFrame = (element: Element) => element.localName === "iframe" || element.localName === "frame";

	const show = (element: Element, child: Omit<Child, "id">, read: { src?: string; srcdoc?: string }) => {
		const previous = children.get(element);
		const id = previous?.id ?? next++;
		children.set(element, { id, ...child, ...read });
		byId.set(id, element);
		if (state.allow) set(element, "allow", state.allow);
		// Setting srcdoc again starts the stub again, even with the same markup
		set(element, "srcdoc", stub);
	};
	const fromSrc = (element: Element, value: string) => {
		const url = client.resolve(value, client.base);
		// about:blank, javascript: and the like stay native, in a child as opaque as this frame
		if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return false;
		show(element, { navigation: { url: url.href } }, { src: value, srcdoc: children.get(element)?.srcdoc });
		return true;
	};
	const fromSrcdoc = (element: Element, value: string) => {
		show(element, { navigation: { url: client.base }, html: value }, { src: children.get(element)?.src, srcdoc: value });
	};
	/** A frame the parser or markup made, with attributes that were set natively */
	const check = (element: Element) => {
		if (!isFrame(element)) return;
		const srcdoc = get(element, "srcdoc");
		if (srcdoc !== null && srcdoc !== stub && children.get(element)?.srcdoc === undefined) {
			fromSrcdoc(element, srcdoc);
			return;
		}
		const src = get(element, "src");
		if (src !== null && srcdoc === null && children.get(element)?.src !== src) fromSrc(element, src);
	};
	const scan = (node: unknown) => {
		if (!node || typeof node !== "object" || (node as Node).nodeType !== 1) return;
		const element = node as Element;
		check(element);
		for (const child of Array.from(Reflect_apply(querySelectorAll, element, ["iframe,frame"]) as NodeListOf<Element>))
			check(child);
	};

	for (const name of ["HTMLIFrameElement", "HTMLFrameElement"]) {
		client.Trap(`${name}.prototype.src`, {
			get(ctx) {
				const child = children.get(ctx.this);
				if (child?.src === undefined) return ctx.get();
				return client.resolve(child.src, client.base)?.href ?? child.src;
			},
			set(ctx, value) {
				if (!fromSrc(ctx.this, String(value))) ctx.set(value);
			},
		});
	}
	client.Trap("HTMLIFrameElement.prototype.srcdoc", {
		get(ctx) {
			return children.get(ctx.this)?.srcdoc ?? ctx.get();
		},
		set(ctx, value) {
			fromSrcdoc(ctx.this, String(value));
		},
	});
	for (const [method, offset] of [
		["setAttribute", 0],
		["setAttributeNS", 1],
	] as const)
		client.Proxy(`Element.prototype.${method}`, {
			apply(ctx) {
				const element = ctx.this as Element;
				if (!isFrame(element) || (offset && ctx.args[0] !== null && ctx.args[0] !== "")) return;
				const name = String(ctx.args[offset]).toLowerCase();
				const value = String(ctx.args[offset + 1]);
				if (name === "src" && fromSrc(element, value)) ctx.return(undefined);
				else if (name === "srcdoc" && element.localName === "iframe") {
					fromSrcdoc(element, value);
					ctx.return(undefined);
				}
			},
		});
	for (const name of ["getAttribute", "getAttributeNS"] as const)
		client.Proxy(`Element.prototype.${name}`, {
			apply(ctx) {
				const child = children.get(ctx.this as Element);
				if (!child) return;
				const attribute = String(ctx.args[name === "getAttribute" ? 0 : 1]).toLowerCase();
				if (attribute === "srcdoc") ctx.return(child.srcdoc ?? null);
				else if (attribute === "src" && child.src !== undefined) ctx.return(child.src);
			},
		});

	client.Proxy(INSERTERS, {
		apply(ctx) {
			const result = ctx.call();
			if (ctx.args.length === 0) scan(ctx.this);
			for (const arg of ctx.args) scan(arg);
			return result;
		},
	});
	// The parser's frames, from the document written back, document.write or innerHTML, never pass
	// the above
	const observer = () =>
		new MutationObserver((records) => {
			for (const record of records) for (const node of Array.from(record.addedNodes)) scan(node);
		}).observe(page.document, { subtree: true, childList: true });
	observer();
	tap.tap(client.hooks.written, observer);

	// A child's stub asks this frame for a link; the host makes it, with the page the child shows
	const relay = () =>
		acceptLinks(
			page,
			async ({ source }) => {
				let found: (Child & { src?: string }) | undefined;
				for (const element of Array.from(
					Reflect_apply(querySelectorAll, page.document, ["iframe,frame"]) as NodeListOf<HTMLIFrameElement>
				))
					if (element.contentWindow === source) found = children.get(element);
				if (!found || !state.host) return null;
				const { id, navigation, html } = found;
				const answer = await state.host.call("connect", { id, navigation, html });
				return { port: answer.port, payload: answer.payload, frame: answer.frame };
			},
			{ key: state.key }
		);
	let stop = relay();
	tap.tap(client.hooks.written, () => {
		stop();
		stop = relay();
	});

	// A child that caught its own link or form comes back here, and starts again at its new page
	state.methods.child = async ({ id, navigation }) => {
		const element = byId.get(id);
		const child = element && children.get(element);
		if (!element || !child) return;
		show(element, { navigation }, { src: navigation.url });
	};
}

export default {
	name: "frame-frames",
	order: 2,
	scope: ["window"],
	enabled: (client: ScramjetMinimalClient) => frameOf(client) !== null,
	install,
} satisfies ScramjetMinimalPlugin<ScramjetMinimalClient>;
