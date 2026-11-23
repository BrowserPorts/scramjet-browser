import {
	type ChildNode,
	type Element,
	ElementType,
	Text,
	parseDocument,
	render,
} from "@/shared/htmlparser";
import type { NullArray } from "@/shared/htmlparser/safe";
import { Array_splice } from "@/shared/snapshot";
import type { ScramjetMinimalClient } from "@/minimal/client";
import type { MinimalPluginContext, ScramjetMinimalPlugin } from "@/plugins/types";
import { frameOf } from "../state";
import { rewriteModule } from "./modules";
import { inlineStyleBlobs } from "./styles";

/** Images read ahead before the document is written; more load once it runs */
const MAX_IMAGES = 64;

const JAVASCRIPT =
	/^(|module|(application|text)\/(x-)?(java|ecma)script|text\/(j|live)script|application\/x-javascript)$/i;

/** Hints that would open connections or load pages the runtime never sees */
const DROPPED_LINKS = ["preconnect", "dns-prefetch", "prefetch", "prerender"];

type Swap = { element: Element; attribute: string; pending: Promise<string> };

// Scramjet's own parser and tree, whose child lists are null-prototype arrays:
// they are read and changed by index, never through Array.prototype

function replaceText(element: Element, data: string) {
	element.children.length = 0;
	element.append([new Text(data)]);
}

function textOf(element: Element): string {
	let text = "";
	for (let index = 0; index < element.children.length; index++) {
		const child = element.children[index];
		if ("data" in child) text += child.data;
	}

	return text;
}

function walk(nodes: NullArray<ChildNode>, visit: (element: Element) => void) {
	for (let index = 0; index < nodes.length; index++) {
		const node = nodes[index];
		if (node.type !== ElementType.Tag) continue;
		visit(node);
		walk(node.children, visit);
	}
}

/**
 * Before the document is written, everything its markup names that the parser would load (scripts
 * of every kind, stylesheets, preloads and the first images) is fetched over the link in parallel
 * and swapped for a blob this frame made, so the parser runs the page's scripts in their order
 * with nothing to load natively, which the frame's policy refuses anyway. Stylesheets carry their
 * own references as blobs, module scripts their imports, and inline styles and modules are
 * rewritten in place. Scripts are kept as files too, for workers that import them synchronously.
 * Elements the page adds later go through the element hooks of the embedder's plugins.
 */
function install(client: ScramjetMinimalClient, _self: typeof globalThis, { tap }: MinimalPluginContext<ScramjetMinimalClient>) {
	const state = frameOf(client)!;
	tap.tap(client.hooks.document, async (_context, props) => {
		const document = parseDocument(props.html);
		const base = client.base;
		const swaps: Swap[] = [];
		const texts: Promise<unknown>[] = [];
		const removed: Element[] = [];
		let images = 0;
		const fetch = (element: Element, attribute: string, kind: "script" | "style" | "other", module = false) => {
			const raw = element.attribs[attribute];
			if (raw === undefined) return;
			const url = client.resolve(raw.trim(), base);
			if (!url || client.route(url) === "native") return;
			if (client.route(url) === "blocked") return;
			const pending = client.blob(url, kind, module);
			swaps.push({ element, attribute, pending });
			if (kind === "script" && !module)
				texts.push(
					pending.then(async (blob) => {
						const file = await (await client.nativeFetch(blob)).blob();
						state.files.set(url.href, file);
					}, () => undefined)
				);
		};
		walk(document.children, (element) => {
			const attribs = element.attribs;
			const style = attribs.style !== undefined ? inlineStyleBlobs(client, attribs.style) : null;
			if (style)
				texts.push(
					style.then((next) => {
						attribs.style = next;
					})
				);
			switch (element.name) {
				case "script": {
					const type = (attribs.type ?? "").trim();
					if (!JAVASCRIPT.test(type) || "nomodule" in attribs) return;
					const module = type.toLowerCase() === "module";
					if (attribs.src !== undefined) fetch(element, "src", "script", module);
					else if (module) {
						const text = textOf(element);
						texts.push(
							rewriteModule(client, text, base).then((next) => {
								if (next !== text) replaceText(element, next);
							})
						);
					}
					return;
				}
				case "link": {
					const rel = (attribs.rel ?? "").toLowerCase().split(/\s+/);
					// A frame shows no icon, so one would only be a load the policy refuses
					if (rel.some((value) => DROPPED_LINKS.includes(value) || value.includes("icon"))) removed.push(element);
					else if (rel.includes("stylesheet")) fetch(element, "href", "style");
					else if (rel.includes("modulepreload")) fetch(element, "href", "script", true);
					else if (rel.includes("preload") && attribs.as === "script") fetch(element, "href", "script");
					else if (rel.includes("preload") && attribs.as === "style") fetch(element, "href", "style");
					else if (rel.includes("preload")) removed.push(element);
					return;
				}
				case "style": {
					const text = textOf(element);
					if (!/url\(|@import/i.test(text)) return;
					texts.push(
						client.css(text, new URL(base)).then((next) => {
							replaceText(element, next);
						})
					);
					return;
				}
				case "img":
				case "input":
				case "video": {
					if (images >= MAX_IMAGES) return;
					const attribute = element.name === "video" ? "poster" : "src";
					if (element.name === "input" && (attribs.type ?? "").toLowerCase() !== "image") return;
					if (attribs[attribute] === undefined) return;
					images++;
					fetch(element, attribute, "other");
					return;
				}
			}
		});
		for (const element of removed) {
			const siblings = element.parent?.children;
			if (!siblings) continue;
			for (let index = 0; index < siblings.length; index++) {
				if (siblings[index] !== element) continue;
				Array_splice(siblings as unknown as unknown[], index, 1);
				break;
			}
			element.parent = null;
		}
		await Promise.all(
			swaps.map(async ({ element, attribute, pending }) => {
				try {
					element.attribs[attribute] = await pending;
				} catch (error) {
					// The element keeps its URL and fails as it would have; the report says why
					client.report(error, element.attribs[attribute] ?? "");
				}
			})
		);
		await Promise.all(texts);
		props.html = render(document);
	});
}

export default {
	name: "frame-prefetch",
	order: 0,
	scope: ["window"],
	enabled: (client: ScramjetMinimalClient) => frameOf(client) !== null,
	install,
} satisfies ScramjetMinimalPlugin<ScramjetMinimalClient>;
