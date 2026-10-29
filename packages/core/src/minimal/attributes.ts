import type { ScramjetMinimalClient } from "./client";
import { NativeWeakMap } from "./natives";
import {
	Object_getOwnPropertyDescriptor,
	Reflect_apply,
} from "@/shared/snapshot";

type Getter = (this: unknown) => unknown;

/**
 * Attr nodes reach an element's attributes without setAttribute, which plugins hook to see the
 * URLs a page sets: setAttributeNode, attributes.setNamedItem, and the value setters of an Attr
 * already on an element. Each is routed through the element's setAttributeNS as the page sees it
 * when it runs, so every plugin's hook on it applies.
 *
 * An Attr given to setAttributeNode becomes the element's own when the hooked call left the
 * attribute set, with the value the hooks chose. When a hook holds the value back (a resource
 * still loading), the element keeps no attribute until the hook sets it, and the Attr stays apart.
 */
export function hookAttributes(client: ScramjetMinimalClient) {
	const self = client.global as typeof globalThis;
	if (typeof self.Element !== "function" || typeof self.Attr !== "function")
		return;
	const read = (owner: object, name: string): Getter | undefined =>
		Object_getOwnPropertyDescriptor(owner, name)?.get as Getter | undefined;
	const attr = self.Attr.prototype;
	const node = self.Node.prototype;
	const nameOf = read(attr, "name");
	const namespaceOf = read(attr, "namespaceURI");
	const ownerOf = read(attr, "ownerElement");
	const valueOf = read(attr, "value");
	const setValue = Object_getOwnPropertyDescriptor(attr, "value")?.set;
	const attributesOf = read(self.Element.prototype, "attributes");
	if (!nameOf || !namespaceOf || !ownerOf || !valueOf || !setValue) return;
	const nodeTypeOf = read(node, "nodeType");
	const getAttributeNodeNS = self.Element.prototype.getAttributeNodeNS;
	const isAttr = (value: unknown): value is Attr => {
		if (!nodeTypeOf || !value || typeof value !== "object") return false;
		try {
			return Reflect_apply(nodeTypeOf, value, []) === 2;
		} catch {
			return false;
		}
	};
	/** Elements whose attribute maps the page holds, since a map does not name its element */
	const maps = new NativeWeakMap<object, Element>();

	/** Sets an attribute through the hooked setAttributeNS, and returns the node the element now has */
	const set = (element: Element, namespace: string | null, name: string, value: string) => {
		Reflect_apply(self.Element.prototype.setAttributeNS, element, [namespace, name, value]);
		const local = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
		return Reflect_apply(getAttributeNodeNS, element, [namespace, local]) as Attr | null;
	};

	const adopt = (element: unknown, ctx: { args: any[]; call: () => any; return: (value: any) => void }) => {
		const given = ctx.args[0];
		if (!element || !isAttr(given) || Reflect_apply(ownerOf, given, []) !== null)
			return;
		const namespace = Reflect_apply(namespaceOf, given, []) as string | null;
		const name = Reflect_apply(nameOf, given, []) as string;
		const local = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
		const previous = Reflect_apply(getAttributeNodeNS, element, [namespace, local]) as Attr | null;
		const current = set(element as Element, namespace, name, Reflect_apply(valueOf, given, []) as string);
		if (!current) {
			ctx.return(previous);
			return;
		}
		// The page's Attr takes the place of the one the hooked call made, carrying its value
		Reflect_apply(setValue, given, [Reflect_apply(valueOf, current, [])]);
		ctx.call();
		ctx.return(previous);
	};

	client.Proxy(["Element.prototype.setAttributeNode", "Element.prototype.setAttributeNodeNS"], {
		apply(ctx) {
			adopt(ctx.this, ctx);
		},
	});
	if (attributesOf) {
		client.Trap("Element.prototype.attributes", {
			get(ctx) {
				const map = ctx.get();
				if (map && typeof map === "object") maps.set(map, ctx.this);
				return map;
			},
		});
		client.Proxy(["NamedNodeMap.prototype.setNamedItem", "NamedNodeMap.prototype.setNamedItemNS"], {
			apply(ctx) {
				adopt(maps.get(ctx.this), ctx);
			},
		});
	}

	const assign = (that: unknown, value: unknown) => {
		const element = Reflect_apply(ownerOf, that, []) as Element | null;
		if (!element) return false;
		set(
			element,
			Reflect_apply(namespaceOf, that, []) as string | null,
			Reflect_apply(nameOf, that, []) as string,
			String(value)
		);
		return true;
	};
	client.Trap("Attr.prototype.value", {
		set(ctx, value) {
			if (!assign(ctx.this, value)) ctx.set(value);
		},
	});
	// nodeValue and textContent of an Attr set its value too
	for (const property of ["nodeValue", "textContent"] as const) {
		const descriptor = Object_getOwnPropertyDescriptor(node, property);
		if (!descriptor?.set) continue;
		client.Trap(`Node.prototype.${property}`, {
			set(ctx, value) {
				if (isAttr(ctx.this) && value !== null && assign(ctx.this, value)) return;
				ctx.set(value);
			},
		});
	}
}
