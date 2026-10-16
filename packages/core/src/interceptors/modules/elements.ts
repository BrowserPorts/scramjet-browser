import { Reflect_apply, Reflect_construct } from "@/shared/snapshot";
import type { InterceptorClient } from "../client";
import { NativeURL, NativeWeakMap, NativeWeakSet } from "../natives";

export const order = 1;

export const enabled = (client: InterceptorClient) =>
	typeof (client.global as { document?: unknown }).document !== "undefined";

type Kind = "script" | "style" | "other" | "srcset";

/** Element properties whose URL the browser loads by itself */
const PROPERTIES: [string, string, Kind][] = [
	["HTMLScriptElement", "src", "script"],
	["HTMLImageElement", "src", "other"],
	["HTMLImageElement", "srcset", "srcset"],
	["HTMLSourceElement", "src", "other"],
	["HTMLSourceElement", "srcset", "srcset"],
	["HTMLMediaElement", "src", "other"],
	["HTMLVideoElement", "poster", "other"],
	["HTMLInputElement", "src", "other"],
	["HTMLTrackElement", "src", "other"],
	["HTMLEmbedElement", "src", "other"],
	["HTMLObjectElement", "data", "other"],
	["HTMLLinkElement", "href", "style"],
];

const SELECTOR =
	"script[src],img[src],img[srcset],source[src],source[srcset],audio[src],video[src],video[poster],input[src],track[src],embed[src],object[data],link[href],style";
const JAVASCRIPT =
	/^(|module|(application|text)\/(x-)?(java|ecma)script|text\/(j|live)script|application\/x-javascript)$/i;

export default function (client: InterceptorClient, self: typeof globalThis) {
	const document = self.document;
	const setAttribute = self.Element.prototype.setAttribute;
	const getAttribute = self.Element.prototype.getAttribute;
	/** The URL each element asked for, which reads return while it loads from a blob */
	const requested = new NativeWeakMap<Element, Record<string, string>>();
	const handled = new NativeWeakSet<Element>();
	const styles = new NativeWeakMap<Element, string>();
	let ordered: Promise<unknown> = Promise.resolve();

	const nativeSet = (element: Element, name: string, value: string) =>
		Reflect_apply(setAttribute, element, [name, value]);
	const nativeGet = (element: Element, name: string): string | null =>
		Reflect_apply(getAttribute, element, [name]);

	/** What a link loads, or null for links that load nothing worth carrying over */
	const linkKind = (element: Element): Kind | null => {
		const rel = (nativeGet(element, "rel") ?? "").toLowerCase().split(/\s+/);
		if (rel.includes("stylesheet")) return "style";
		if (rel.some((value) => value.includes("icon"))) return "other";
		return null;
	};

	const kindOf = (element: Element, name: string): Kind | null => {
		const tag = element.localName;
		if (tag === "link") return name === "href" ? linkKind(element) : null;
		if (tag === "script") return name === "src" ? "script" : null;
		if (name === "srcset")
			return tag === "img" || tag === "source" ? "srcset" : null;
		for (const [constructor, property] of PROPERTIES)
			if (
				property === name &&
				(self as any)[constructor] &&
				element instanceof (self as any)[constructor]
			)
				return "other";
		return null;
	};

	const remember = (element: Element, name: string, url: string | null) => {
		const entry = requested.get(element) ?? {};
		if (url === null) delete entry[name];
		else entry[name] = url;
		requested.set(element, entry);
	};

	const srcset = async (value: string): Promise<string> => {
		const candidates = value
			.split(",")
			.map((candidate) => candidate.trim())
			.filter(Boolean);
		const swapped = await Promise.all(
			candidates.map(async (candidate) => {
				const [raw, ...descriptor] = candidate.split(/\s+/);
				const url = client.resolve(raw);
				if (!url || client.route(url) !== "wisp") return candidate;
				const blob = await client.blob(url).catch(() => url.href);
				return [blob, ...descriptor].join(" ");
			})
		);
		return swapped.join(", ");
	};

	/**
	 * Loads an element's resource over the transport, then points the element at the blob. The
	 * element has no URL meanwhile, so an inserted script waits instead of running empty.
	 */
	const swap = (
		element: Element,
		name: string,
		value: string,
		kind: Kind
	): boolean => {
		if (kind === "srcset") {
			if (
				!value.split(",").some((part) => {
					const url = client.resolve(part.trim().split(/\s+/)[0] ?? "");
					return url && client.route(url) !== "native";
				})
			) {
				remember(element, name, null);
				return false;
			}
			remember(element, name, value);
			srcset(value).then((next) => {
				if (requested.get(element)?.[name] === value)
					nativeSet(element, name, next);
			});
			return true;
		}
		const url = client.resolve(value);
		if (!url || client.route(url) === "native") {
			remember(element, name, null);
			return false;
		}
		remember(element, name, url.href);
		if (client.route(url) === "blocked") {
			queueMicrotask(() => element.dispatchEvent(new Event("error")));
			return true;
		}
		let load: Promise<string> = client.blob(url, kind);
		// Scripts that asked to run in order still do, even though their blobs finish in any order
		if (kind === "script" && (element as HTMLScriptElement).async === false) {
			const previous = ordered;
			load = previous.then(() => load);
			ordered = load.catch(() => undefined);
		}
		load
			.then((blob) => {
				if (requested.get(element)?.[name] === url.href)
					nativeSet(element, name, blob);
			})
			.catch((error) => {
				client.report(error, url.href);
				if (requested.get(element)?.[name] === url.href)
					element.dispatchEvent(new Event("error"));
			});
		return true;
	};

	for (const [constructor, property, kind] of PROPERTIES) {
		const name = property === "data" ? "data" : property;
		client.Trap(`${constructor}.prototype.${property}`, {
			get(ctx) {
				const original = requested.get(ctx.this)?.[name];
				if (original !== undefined) return original;
				const value = ctx.get();
				return typeof value === "string"
					? (client.origins.get(value) ?? value)
					: value;
			},
			set(ctx, value: string) {
				const actual =
					constructor === "HTMLLinkElement" ? linkKind(ctx.this) : kind;
				if (actual && swap(ctx.this, name, String(value), actual)) return;
				ctx.set(value);
			},
		});
	}

	client.Proxy(
		["Element.prototype.setAttribute", "Element.prototype.setAttributeNS"],
		{
			apply(ctx) {
				const namespaced = ctx.args.length > 2;
				const name = String(ctx.args[namespaced ? 1 : 0]).toLowerCase();
				const value = String(ctx.args[namespaced ? 2 : 1]);
				const kind = kindOf(ctx.this as Element, name);
				if (kind && swap(ctx.this as Element, name, value, kind))
					ctx.return(undefined);
			},
		}
	);

	/** A parser script is caught before it runs and replaced by one that loads from a blob */
	const rescueScript = (script: HTMLScriptElement, url: URL) => {
		const type = nativeGet(script, "type") ?? "";
		if (!JAVASCRIPT.test(type.trim())) return;
		nativeSet(script, "type", "text/x-scramjet-pending");
		const replacement = document.createElement("script");
		for (const attribute of Array.from(script.attributes))
			if (attribute.name !== "src" && attribute.name !== "type")
				nativeSet(replacement, attribute.name, attribute.value);
		if (type) nativeSet(replacement, "type", type);
		replacement.async = script.hasAttribute("async");
		swap(replacement, "src", url.href, "script");
		script.replaceWith(replacement);
	};

	const rewriteStyle = (element: Element) => {
		const text = element.textContent ?? "";
		if (styles.get(element) === text || !/url\(|@import/i.test(text)) return;
		client.css(text, new NativeURL(client.base), false).then((next) => {
			if (element.textContent !== text) return;
			styles.set(element, next);
			if (next !== text) element.textContent = next;
		});
	};

	const check = (element: Element) => {
		const tag = element.localName;
		if (tag === "style") {
			rewriteStyle(element);
			return;
		}
		if (tag === "script") {
			const raw = nativeGet(element, "src");
			if (raw === null || handled.has(element)) return;
			handled.add(element);
			const url = client.resolve(raw);
			if (url && client.route(url) !== "native" && !requested.get(element)?.src)
				rescueScript(element as HTMLScriptElement, url);
			return;
		}
		for (const name of ["src", "srcset", "href", "poster", "data"]) {
			const value = nativeGet(element, name);
			if (value === null || requested.get(element)?.[name] !== undefined)
				continue;
			const kind = kindOf(element, name);
			if (kind) swap(element, name, value, kind);
		}
	};

	const scan = (node: Node) => {
		if (node.nodeType !== 1) return;
		const element = node as Element;
		check(element);
		for (const child of Array.from(element.querySelectorAll(SELECTOR)))
			check(child);
	};

	// Markup from the parser, innerHTML or document.write never passes through the setters above;
	// the parser checks microtasks before it runs a script, so a script is caught before it loads
	new MutationObserver((records) => {
		for (const record of records) {
			if (record.type === "attributes") {
				const element = record.target as Element;
				const name = record.attributeName!;
				const value = nativeGet(element, name);
				if (value === null || value.startsWith("blob:")) continue;
				if (requested.get(element)?.[name] !== undefined) continue;
				const kind = kindOf(element, name);
				if (kind && element.localName !== "script")
					swap(element, name, value, kind);
			} else if ((record.target as Element).localName === "style") {
				// Replacing a style's text replaces its children
				rewriteStyle(record.target as Element);
			}
			for (const node of Array.from(record.addedNodes)) scan(node);
		}
	}).observe(document, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeFilter: ["src", "srcset", "href", "poster", "data"],
	});

	client.Proxy("Audio", {
		construct(ctx) {
			if (ctx.args[0] === undefined) return;
			const audio = Reflect_construct(
				ctx.fn,
				[],
				ctx.newTarget
			) as HTMLAudioElement;
			audio.src = String(ctx.args[0]);
			ctx.return(audio);
		},
	});
}
