import type { ScramjetMinimalClient } from "@/minimal/client";
import type { ScramjetMinimalPlugin } from "@/plugins/types";
import { Object_getOwnPropertyDescriptor, Reflect_apply } from "@/shared/snapshot";
import { frameOf } from "../state";

/** Inline style properties that can name a URL */
const PROPERTIES = [
	"background",
	"backgroundImage",
	"border",
	"borderImage",
	"borderImageSource",
	"content",
	"cursor",
	"listStyle",
	"listStyleImage",
	"mask",
	"maskImage",
	"shapeOutside",
	"webkitMaskImage",
];

const URLS = /url\(\s*(["']?)(.*?)\1\s*\)/gi;

/**
 * A declaration's text with each URL that loads over the link replaced by a frame-made blob, or
 * null when it names none. A URL that fails to load is left as written.
 */
export function inlineStyleBlobs(client: ScramjetMinimalClient, text: string): Promise<string> | null {
	if (!/url\(/i.test(text)) return null;
	const swaps: Promise<[string, string]>[] = [];
	for (const match of text.matchAll(URLS)) {
		const url = client.resolve(match[2]!.trim(), client.base);
		if (!url || client.route(url) !== "wisp") continue;
		swaps.push(
			client.blob(url, "other").then(
				(blob): [string, string] => [match[0], `url("${blob}")`],
				(): [string, string] => [match[0], match[0]]
			)
		);
	}
	if (!swaps.length) return null;
	return Promise.all(swaps).then((pairs) =>
		pairs.reduce((out, [from, to]) => out.split(from).join(to), text)
	);
}

/**
 * Inline styles that name a URL (element.style.backgroundImage, setProperty, cssText and style
 * attributes) would load it natively, which the frame's policy refuses. Each is set as written, so
 * the cascade and reads behave at once, and set again with frame-made blobs in place of its URLs
 * once they load, unless the page changed it meanwhile. Stylesheets carry their own blobs already.
 */
function install(client: ScramjetMinimalClient, self: typeof globalThis) {
	const page = self as Window & typeof globalThis;
	/** Sets a value now, and its blob form later if the value still stands */
	const later = (value: unknown, read: () => unknown, write: (value: string) => void) => {
		const text = String(value);
		const pending = inlineStyleBlobs(client, text);
		if (!pending) return;
		const set = read();
		pending.then((next) => {
			if (next !== text && read() === set) write(next);
		});
	};

	const prototype = page.CSSStyleDeclaration.prototype;
	// Firefox keeps the property accessors on a subclass of its own
	const owner =
		(page as unknown as { CSS2Properties?: { prototype: object } }).CSS2Properties?.prototype ?? prototype;
	for (const name of [...PROPERTIES, "cssText"]) {
		const target = Object_getOwnPropertyDescriptor(owner, name) ? owner : prototype;
		if (!Object_getOwnPropertyDescriptor(target, name)?.set) continue;
		client.RawTrap(target, name, {
			set(ctx, value) {
				ctx.set(value);
				later(value, () => ctx.get(), (next) => ctx.set(next));
			},
		});
	}
	const getPropertyValue = prototype.getPropertyValue;
	client.Proxy("CSSStyleDeclaration.prototype.setProperty", {
		apply(ctx) {
			const declaration = ctx.this as CSSStyleDeclaration;
			const [name, value, priority] = ctx.args as [string, unknown, string | undefined];
			const result = ctx.call();
			later(
				value,
				() => Reflect_apply(getPropertyValue, declaration, [name]),
				(next) => Reflect_apply(ctx.fn, declaration, [name, next, priority ?? ""])
			);
			return result;
		},
	});
	const getAttribute = page.Element.prototype.getAttribute;
	client.Proxy("Element.prototype.setAttribute", {
		apply(ctx) {
			const element = ctx.this as Element;
			if (String(ctx.args[0]).toLowerCase() !== "style") return;
			const result = ctx.call();
			later(
				ctx.args[1],
				() => Reflect_apply(getAttribute, element, ["style"]),
				(next) => Reflect_apply(ctx.fn, element, ["style", next])
			);
			return result;
		},
	});
}

export default {
	name: "frame-styles",
	scope: ["window"],
	enabled: (client: ScramjetMinimalClient) => frameOf(client) !== null,
	install,
} satisfies ScramjetMinimalPlugin<ScramjetMinimalClient>;
