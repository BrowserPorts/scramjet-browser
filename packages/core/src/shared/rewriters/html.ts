import {
	injectedAttribute,
	internalAttribute,
	logicalAttribute,
} from "@/runtime-identity";
import type { RawHeaders } from "@mercuryworkshop/proxy-transports";
import { rewriteCss } from "@rewriters/css";
import { rewriteUrl, type URLMeta } from "@rewriters/url";
import render from "dom-serializer";
import { type ChildNode, Comment, DomHandler, Element } from "domhandler";
import { ElementType, Parser } from "htmlparser2";
import type { TrackedHistoryState } from "@/fetch";
import type { ScramjetContext } from "@/shared";
import { htmlRules } from "@/shared/htmlRules";
import {
	getScriptBlockTypeString,
	isModuleScriptType,
	isScriptType,
} from "@/shared/mime";
import { providers } from "@/shared/providers";
import { parseDeclarativeRefresh } from "@/shared/refresh";
import {
	_URL,
	Array_from,
	atob,
	btoa,
	JSON_parse,
	JSON_stringify,
	Object_defineProperty,
	Object_entries,
	Object_setPrototypeOf,
	Performance_now,
	String_fromCodePoint,
	TextEncoder_encode,
} from "@/shared/snapshot";
import { bytesToBase64 } from "@/shared/util";
import { Tap } from "@/Tap";
import { flagEnabled } from "@/shared/flags";

export type ForeignContext = "svg" | "math" | "html";

export type HtmlContext = {
	// should we inject scramjet scripts at the top of the document?
	loadScripts: boolean;
	// did the document come from the service worker, or from document.write/innerHTML?
	inline: boolean;
	/**
	 * True when this markup is parsed as a FRAGMENT rather than as a document.
	 *
	 * A `<base>` in fragment markup selects nothing, so the base already in force
	 * stays. Distinct from `inline`, which only says the markup did not come from
	 * the service worker — `document.write` is inline yet really is parsed into the
	 * document.
	 *
	 * BASE_SELECTION_BACKLOG — known gap, deliberately not modelled here.
	 * `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`setHTMLUnsafe` on a CONNECTED
	 * target can genuinely change the document's base (`head.innerHTML` replacing
	 * the old base is the clear case). Deciding that needs the post-operation tree
	 * order of every `base[href]`, which is circular here: the markup's own bases
	 * are only enumerable after this function parses them, and ordering a
	 * not-yet-inserted subtree against surviving document bases means modelling the
	 * document a second time. A previous attempt keyed on `isConnected` was both
	 * wrong (a connected `<template>`'s `innerHTML` writes inert `content`, and a
	 * shadow root is not the document tree) and inert (the seeding below already
	 * spent the selection whenever the document had a base). It was removed rather
	 * than left claiming support. Connected-insertion base selection is unresolved.
	 */
	fragment?: boolean;
	/**
	 * True when this markup becomes an INDEPENDENT new document.
	 *
	 * `DOMParser.parseFromString` and `Document.parseHTMLUnsafe` build a document of
	 * their own, so they inherit no base selection from the document that called
	 * them — their own markup makes it.
	 */
	newDocument?: boolean;
	// for worker originating documents, the source URL, otherwise the url of the page that triggered the rewrite
	source: string;
	// for api originating documents, the name of the api that triggered the rewrite
	apisource?: string;
	// response headers for worker originating documents
	headers?: RawHeaders;
	// service-worker navigation identity used by browser-process frame precommit
	clientId?: string;
	sourceClientId?: string;
	resultingClientId?: string;
	documentDestination?: "document" | "iframe";
	parentFrameName?: string;
	foreignContext?: ForeignContext;
	history?: TrackedHistoryState[];
};

const renderOptions = {
	encodeEntities: "utf8" as const,
	decodeEntities: false,
};
function serializeHtmlNode(node: ChildNode) {
	return render(node, renderOptions);
}

function isElementNode(node: ChildNode): node is Element {
	return (
		node.type === ElementType.Tag ||
		node.type === ElementType.Script ||
		node.type === ElementType.Style
	);
}

export class IncrementalHtmlRewriter {
	private readonly handler: DomHandler;
	private readonly parser: Parser;
	private readonly completedElements = new WeakSet<Element>();
	private readonly emittedLengths = new WeakMap<ChildNode, number>();
	private readonly rewrittenNodes = new WeakMap<ChildNode, string>();
	private ended = false;

	constructor(
		private readonly context: ScramjetContext,
		private readonly meta: URLMeta,
		private readonly htmlcontext: HtmlContext
	) {
		this.handler = new DomHandler(undefined, undefined, (element) => {
			this.completedElements.add(element);
		});
		this.parser = new Parser(this.handler, {
			startingForeignContext: htmlcontext.foreignContext,
		});
	}

	write(html: string) {
		if (this.ended) {
			throw new Error("IncrementalHtmlRewriter stream already ended");
		}

		this.parser.write(html);

		return this.flush();
	}

	end(html = "") {
		if (this.ended) {
			return "";
		}

		if (html) {
			this.parser.write(html);
		}

		this.parser.end();
		this.ended = true;

		return this.flush();
	}

	private flush() {
		let output = "";

		for (const node of this.handler.root.childNodes) {
			const rewritten = this.getAvailableOutput(node);
			if (rewritten === null) {
				break;
			}

			const emittedLength = this.emittedLengths.get(node) ?? 0;
			if (rewritten.length > emittedLength) {
				output += rewritten.slice(emittedLength);
				this.emittedLengths.set(node, rewritten.length);
			}
		}

		return output;
	}

	private getAvailableOutput(node: ChildNode) {
		if (!isElementNode(node)) {
			return serializeHtmlNode(node);
		}

		if (!this.completedElements.has(node)) {
			return null;
		}

		let rewritten = this.rewrittenNodes.get(node);
		if (rewritten === undefined) {
			rewritten = rewriteHtmlInner(
				node,
				this.context,
				this.meta,
				this.htmlcontext
			);
			this.rewrittenNodes.set(node, rewritten);
		}

		return rewritten;
	}
}

function rewriteHtmlInner(
	html: string | ChildNode,
	context: ScramjetContext,
	meta: URLMeta,
	htmlcontext: HtmlContext
) {
	if (typeof html !== "string") {
		html = serializeHtmlNode(html);
	}

	const handler = new DomHandler((err, dom) => dom);
	/*
	 * Whether each `<base href>` sits in foreign content, recorded while parsing.
	 *
	 * Only the parser knows this. `isInForeignContext()` already accounts for
	 * SVG/MathML and for every HTML integration point the installed (patched)
	 * htmlparser2 handles — `foreignObject`, `desc`, `title`, `mi`/`mo`/`mn`/`ms`/
	 * `mtext`, `annotation-xml` — using the SVG-adjusted casing it applies itself.
	 * A tag-name list here would have to restate all of that and would drift.
	 *
	 * Read inside `onopentag`, which the parser fires AFTER pushing the element's own
	 * foreign-context transition (`Parser.onopentagname`). `base` is never an
	 * integration element and never `svg`/`math`, so it pushes nothing and the flag
	 * still describes the context the base actually sits in.
	 *
	 * `<template>` is not a namespace question — it is ordinary HTML to the parser —
	 * so its inert contents are excluded structurally during the walk instead.
	 */
	const baseInForeignContext: boolean[] = [];
	const handlerOnOpenTag = handler.onopentag.bind(handler);
	handler.onopentag = (name: string, attribs: { [key: string]: string }) => {
		if (name === "base" && attribs.href !== undefined) {
			baseInForeignContext.push(parser.isInForeignContext());
		}
		handlerOnOpenTag(name, attribs);
	};
	const parser = new Parser(handler, {
		startingForeignContext: htmlcontext.foreignContext,
	});

	parser.write(html);
	parser.end();
	Tap.dispatchSync(
		context.hooks!.rewriter.html.pre,
		{
			handler,
			meta,
			htmlcontext,
			origHtml: html,
		},
		undefined
	);
	traverseParsedHtml(
		handler.root,
		context,
		meta,
		{
			base: meta.base,
			/*
			 * Whether the selection is already spent before this markup is walked.
			 *
			 * - A fragment's markup cannot select: it is parsed detached, or the base
			 *   already in force is outside what this operation replaces.
			 * - A continuing document (service-worker body, `document.write`) inherits
			 *   the selection the document already made — `baseIsSelected`, not
			 *   `baseIsDeclared`, so an existing FIRST base that failed to parse still
			 *   blocks a later one rather than letting it take over.
			 * - An independent new document (DOMParser, `parseHTMLUnsafe`) inherits
			 *   nothing: its own markup makes the selection.
			 */
			selected:
				htmlcontext.fragment === true ||
				(htmlcontext.newDocument !== true &&
					(meta.baseIsSelected ?? meta.baseIsDeclared) === true),
			declared: meta.baseIsDeclared === true,
			foreign: baseInForeignContext,
			seen: 0,
		},
		false
	);

	let htmlRoot: Element | undefined;
	let headElement: Element | undefined;
	let bodyElement: Element | undefined;

	function detectQuirks() {
		for (const child of handler.root.childNodes) {
			if (
				child.type === ElementType.Directive ||
				child.type === ElementType.Comment ||
				child.type === ElementType.Text
			) {
				continue;
			}

			if (child.type === ElementType.Tag && child.name === "html") {
				htmlRoot = child as Element;
			} else {
				// there's a child of the root that isn't an html element or a doctype/comment/text
				return true;
			}
		}

		if (!htmlRoot) return true; // no html tag or it's somewhere else other than first child

		for (const child of htmlRoot.childNodes) {
			if (
				child.type === ElementType.Directive ||
				child.type === ElementType.Comment ||
				child.type === ElementType.Text
			) {
				continue;
			}

			if (child.type === ElementType.Tag && child.name === "head") {
				if (bodyElement) {
					// head comes after body
					return true;
				}
				headElement = child as Element;
			} else if (child.type === ElementType.Tag && child.name === "body") {
				bodyElement = child as Element;
			} else {
				// there's a child of html that isn't head or body
				// fine if head already exists, bad if it doesn't
				if (!headElement) {
					return true;
				}
			}

			return false;
		}
	}

	const isQuirky = detectQuirks();

	if (htmlcontext.loadScripts) {
		const script = (src: string) =>
			new Element("script", { src, [injectedAttribute]: "true" });
		const injectScripts = context.interface.getInjectScripts(
			meta,
			handler,
			htmlcontext,
			script
		);

		if (isQuirky) {
			dbg.warn(
				`detected quirky document structure parsing @ ${meta.origin.href}!`
			);
			// there's weird stuff going on with the document that could result in page scripts being loaded before our inject scripts
			// so inject them at position 0
			handler.root.children.unshift(...injectScripts);
		} else {
			if (!headElement) {
				headElement = new Element("head", {}, []);
				htmlRoot.children.unshift(headElement);
			}

			headElement.children.unshift(...injectScripts);
		}
	}

	const props: typeof context.hooks.rewriter.html.post.props = {};
	Tap.dispatchSync(
		context.hooks!.rewriter.html.post,
		{
			handler,
			meta,
			htmlcontext,
			origHtml: html,
		},
		props
	);

	if (props.setRawHtml !== undefined) {
		return props.setRawHtml;
	}

	return render(handler.root, renderOptions);
}

export function rewriteHtml(
	html: string,
	context: ScramjetContext,
	meta: URLMeta,
	htmlcontext: HtmlContext
) {
	const before = Performance_now();
	const ret = rewriteHtmlInner(html, context, meta, htmlcontext);
	if (flagEnabled("rewriterLogs", context, meta.base)) {
		dbg.time(meta, before, "html rewrite");
	}

	return ret;
}

// type ParseState = {
// 	base: string;
// 	origin?: URL;
// };

export function unrewriteHtml(html: string, foreignContext?: ForeignContext) {
	const handler = new DomHandler((err, dom) => dom);
	const parser = new Parser(handler, {
		startingForeignContext: foreignContext,
	});

	parser.write(html);
	parser.end();

	function traverse(node: ChildNode) {
		if ("attribs" in node) {
			for (const key in node.attribs) {
				if (key === internalAttribute("script-source-src")) {
					if (node.children[0] && "data" in node.children[0])
						node.children[0].data = atob(node.attribs[key]);
					continue;
				}

				const originalName = logicalAttribute(key);
				if (originalName !== null) {
					node.attribs[originalName] = node.attribs[key];
					delete node.attribs[key];
				}
			}
		}

		if ("childNodes" in node) {
			for (const child of node.childNodes) {
				traverse(child);
			}
		}
	}

	traverse(handler.root);

	return render(handler.root, {
		...renderOptions,
	});
}

// i need to add the attributes in during rewriting

/**
 * The base in force while walking the markup, in document order.
 *
 * Carried rather than written onto `meta`: the client passes its own live meta,
 * whose `base` is a getter with no setter, so the previous `meta.base = …` threw a
 * TypeError for any declared `<base href>` in client-rewritten markup.
 */
type BaseState = {
	base: _URL;
	/**
	 * A `base[href]` has been encountered and has consumed the selection.
	 *
	 * Separate from {@link BaseState.declared} on purpose: HTML selects the FIRST
	 * base with an href whether or not it parses. An unparseable first base keeps
	 * the fallback base *and* stops a later base from taking over.
	 */
	selected: boolean;
	/** The selected base parsed, so it is what resolution should use. */
	declared: boolean;
	/** Per-`base[href]` foreign-content flags, in document order, from the parser. */
	readonly foreign: readonly boolean[];
	/** How many `base[href]` elements the walk has passed, in document order. */
	seen: number;
};

/** `meta` with the in-force base applied, without touching the caller's object. */
function withBase(meta: URLMeta, state: BaseState): URLMeta {
	if (!state.declared) return meta;
	// Delegating overlay, so the remaining fields stay lazy — reading
	// `topFrameName` eagerly throws in a worker.
	const overlay = Object_setPrototypeOf({}, meta) as URLMeta;
	Object_defineProperty(overlay, "base", {
		value: state.base,
		enumerable: true,
	});
	Object_defineProperty(overlay, "baseIsDeclared", {
		value: true,
		enumerable: true,
	});
	return overlay;
}

function traverseParsedHtml(
	node: any,
	context: ScramjetContext,
	callerMeta: URLMeta,
	state: BaseState,
	inTemplate: boolean
) {
	// HTML selects the FIRST `<base>` with an `href` content attribute, in tree
	// order — not the last, and not merely the first `<base>`: a preceding
	// `<base target=_blank>` carries no href and does not select, while an empty
	// href does select rather than deferring to a later element.
	//
	// Applied from here onward, in document order, which is what the parser does:
	// a resource referenced before the base still resolves against the document.
	if (node.name === "base" && node.attribs && node.attribs.href !== undefined) {
		const ordinal = state.seen;
		state.seen += 1;
		// Eligible when the parser did not see it in foreign content and it is not
		// inert template content. The first eligible one selects, in document order.
		if (
			!state.selected &&
			inTemplate === false &&
			state.foreign[ordinal] !== true
		) {
			// Selection is consumed HERE, before the parse: the eligible base is the
			// selected one whether or not its value parses, so an invalid base keeps
			// the fallback base and still blocks every later one.
			state.selected = true;
			try {
				state.base = new _URL(node.attribs.href, callerMeta.origin);
				state.declared = true;
			} catch {
				// Unparseable href: HTML keeps the fallback base, and this is not a
				// declared base for resolution purposes.
			}
		}
	}
	const meta = withBase(callerMeta, state);
	const htmlHooks = context.hooks?.rewriter.html;
	if (htmlHooks && node.type === ElementType.Text) {
		const props = { text: node.data as string };
		Tap.dispatchSync(
			htmlHooks.text,
			{ parent: node.parent?.name ? node.parent : null, meta },
			props
		);
		node.data = props.text;
	}

	if (node.attribs) {
		for (const rule of htmlRules) {
			for (const attr in rule) {
				const sel = rule[attr.toLowerCase()];
				if (typeof sel === "function") continue;

				if (sel === "*" || sel.includes(node.name)) {
					if (node.attribs[attr] !== undefined) {
						const value = node.attribs[attr];
						const v = rule.fn(value, context, meta, node.attribs);

						if (v === null) delete node.attribs[attr];
						else {
							node.attribs[attr] = v;
						}
						node.attribs[internalAttribute(attr)] = value;
					}
				}
			}
		}
		const rewriteJs = providers().rewriteJs;
		for (const [attr, value] of Object_entries(node.attribs)) {
			if (rewriteJs && eventAttributes.includes(attr)) {
				node.attribs[internalAttribute(attr)] = value;
				node.attribs[attr] = rewriteJs(
					value as string,
					`(inline ${attr} on element)`,
					context,
					meta
				);
			}
		}
	}

	if (node.name === "style" && node.children[0] !== undefined)
		node.children[0].data = rewriteCss(node.children[0].data, context, meta);

	if (
		node.name === "script" &&
		node.attribs.type?.toLowerCase() === "importmap" &&
		node.children[0] !== undefined
	) {
		const json = node.children[0].data;
		try {
			const map = JSON_parse(json);
			if (map.imports) {
				for (const key in map.imports) {
					let url = map.imports[key];
					if (typeof url === "string") {
						url = rewriteUrl(url, context, meta, { isModule: true });
						map.imports[key] = url;
					}
				}
			}

			node.children[0].data = JSON_stringify(map);
		} catch (e) {
			dbg.error("Failed to parse importmap JSON:", e);
		}
	}
	if (
		node.name === "script" &&
		node.attribs &&
		node.children[0] !== undefined
	) {
		const scriptBlockType = getScriptBlockTypeString(
			"type" in node.attribs ? node.attribs.type : undefined,
			"language" in node.attribs ? node.attribs.language : undefined,
			"type" in node.attribs,
			"language" in node.attribs
		);
		const rewriteJs = providers().rewriteJs;
		if (rewriteJs && isScriptType(scriptBlockType)) {
			let js = node.children[0].data;
			const module = isModuleScriptType(scriptBlockType);
			node.attribs[internalAttribute("script-source-src")] = bytesToBase64(
				TextEncoder_encode(js)
			);
			const htmlcomment = /<!--[\s\S]*?-->/g;
			js = js.replace(htmlcomment, "");
			node.children[0].data = rewriteJs(
				js,
				"(inline script element)",
				context,
				meta,
				module
			);
		}
	}

	if (node.name === "meta" && node.attribs["http-equiv"] !== undefined) {
		if (
			node.attribs["http-equiv"].toLowerCase() === "content-security-policy"
		) {
			// just delete it. this needs to be emulated eventually but like
			node = new Comment(node.attribs.content);
		} else if (node.attribs["http-equiv"].toLowerCase() === "refresh") {
			const refresh = parseDeclarativeRefresh(node.attribs.content || "");
			if (refresh && refresh.url !== null && refresh.url.length > 0) {
				const rewritten = rewriteUrl(refresh.url.trim(), context, meta);
				node.attribs.content =
					node.attribs.content.slice(0, refresh.urlStart) +
					rewritten +
					node.attribs.content.slice(refresh.urlEnd);
			}
		}
	}

	if (htmlHooks && isElementNode(node))
		Tap.dispatchSync(htmlHooks.element, { element: node, meta }, {});
	if (node.childNodes) {
		for (const childNode in node.childNodes) {
			node.childNodes[childNode] = traverseParsedHtml(
				node.childNodes[childNode],
				context,
				callerMeta,
				state,
				inTemplate || node.name === "template"
			);
		}
	}

	return node;
}

export function rewriteSrcset(
	srcset: string,
	context: ScramjetContext,
	meta: URLMeta
) {
	return providers().rewriteSrcsetUrls(srcset, (url) =>
		rewriteUrl(url, context, meta)
	);
}

// function base64ToBytes(base64) {
// 	const binString = atob(base64);

// 	return Uint8Array.from(binString, (m) => m.codePointAt(0));
// }

const eventAttributes = [
	"onbeforexrselect",
	"onabort",
	"onbeforeinput",
	"onbeforematch",
	"onbeforetoggle",
	"onblur",
	"oncancel",
	"oncanplay",
	"oncanplaythrough",
	"onchange",
	"onclick",
	"onclose",
	"oncontentvisibilityautostatechange",
	"oncontextlost",
	"oncontextmenu",
	"oncontextrestored",
	"oncuechange",
	"ondblclick",
	"ondrag",
	"ondragend",
	"ondragenter",
	"ondragleave",
	"ondragover",
	"ondragstart",
	"ondrop",
	"ondurationchange",
	"onemptied",
	"onended",
	"onerror",
	"onfocus",
	"onformdata",
	"oninput",
	"oninvalid",
	"onkeydown",
	"onkeypress",
	"onkeyup",
	"onload",
	"onloadeddata",
	"onloadedmetadata",
	"onloadstart",
	"onmousedown",
	"onmouseenter",
	"onmouseleave",
	"onmousemove",
	"onmouseout",
	"onmouseover",
	"onmouseup",
	"onmousewheel",
	"onpause",
	"onplay",
	"onplaying",
	"onprogress",
	"onratechange",
	"onreset",
	"onresize",
	"onscroll",
	"onsecuritypolicyviolation",
	"onseeked",
	"onseeking",
	"onselect",
	"onslotchange",
	"onstalled",
	"onsubmit",
	"onsuspend",
	"ontimeupdate",
	"ontoggle",
	"onvolumechange",
	"onwaiting",
	"onwebkitanimationend",
	"onwebkitanimationiteration",
	"onwebkitanimationstart",
	"onwebkittransitionend",
	"onwheel",
	"onauxclick",
	"ongotpointercapture",
	"onlostpointercapture",
	"onpointerdown",
	"onpointermove",
	"onpointerrawupdate",
	"onpointerup",
	"onpointercancel",
	"onpointerover",
	"onpointerout",
	"onpointerenter",
	"onpointerleave",
	"onselectstart",
	"onselectionchange",
	"onanimationend",
	"onanimationiteration",
	"onanimationstart",
	"ontransitionrun",
	"ontransitionstart",
	"ontransitionend",
	"ontransitioncancel",
	"oncopy",
	"oncut",
	"onpaste",
	"onscrollend",
	"onscrollsnapchange",
	"onscrollsnapchanging",
];
