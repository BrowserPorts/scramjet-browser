import { internalAttribute, internalAttributePrefix, injectedAttribute } from "@/runtime-identity";
import { htmlRules } from "@/shared/htmlRules";
import {
	String,
	TextEncoder_encode,
	Object_keys,
	Object_defineProperty,
	atob,
} from "@/shared/snapshot";
import { bytesToBase64 } from "@/shared/util";
import { rewriteCss, unrewriteCss } from "@rewriters/css";
import { rewriteHtml, unrewriteHtml } from "@rewriters/html";
import { rewriteJs } from "@rewriters/js";
import { REALM_INERT_JAVASCRIPT_URL } from "@rewriters/realm";
import { unrewriteUrl } from "@rewriters/url";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
import { scriptBlockTypeForElement } from "@client/helpers";
import { providers } from "@/shared/providers";
import { isModuleScriptType, isScriptType } from "@/shared/mime";
import { ForeignContext } from "@/shared/rewriters/html";

export function foreignContextForElement(
	client: ScramjetClient,
	element: Element
): ForeignContext {
	if (client.box.instanceof(element, "SVGElement")) return "svg";
	if (client.box.instanceof(element, "MathMLElement")) return "math";
	return "html";
}

// NOTE: NOT INCLUSIVE OF THE CURRENT ELEMENT
export function insideForeignContext(
	client: ScramjetClient,
	element: Element | null
): ForeignContext {
	let current: Element | null = element.parentElement;

	while (current) {
		const context = foreignContextForElement(client, current);
		if (context !== "html") return context;
		// EXPLICITLY an html context, don't go up further
		if (client.box.instanceof(current, "SVGForeignObjectElement"))
			return "html";
		current = current.parentElement;
	}

	return "html";
}

// TODO: this is pretty bad. really this whole file sucks
function collectAttributeMap(
	client: ScramjetClient,
	element: Element,
	overrideName: string,
	overrideValue: unknown
) {
	const attrs: Record<string, string | undefined> = {};
	const attrNames =
		client.natives.call("Element.prototype.getAttributeNames", element) ?? [];

	for (const attrName of attrNames) {
		if (String(attrName).startsWith(internalAttributePrefix)) continue;
		const value = client.natives.call(
			"Element.prototype.getAttribute",
			element,
			attrName
		);
		attrs[String(attrName).toLowerCase()] =
			typeof value === "string" ? value : undefined;
	}

	attrs[String(overrideName).toLowerCase()] = String(overrideValue);
	return attrs;
}

export default function (client: ScramjetClient, self: typeof window) {
	const isScriptElement = (node: unknown): node is Element =>
		client.box.instanceof(node, "HTMLScriptElement") ||
		client.box.instanceof(node, "SVGScriptElement");
	// A connected script runs the moment its text is set, so in realm mode the text
	// it is given, which is always a stub, is set while the script holds the nonce
	const setScriptText = (element: Element, set: () => void) => {
		if (client.realm && isScriptElement(element)) {
			client.realm.withTextNonce(element, set);
		} else {
			set();
		}
	};

	const attrObject = {
		nonce: [self.HTMLElement, self.SVGElement],
		integrity: [self.HTMLScriptElement, self.HTMLLinkElement],
		csp: [self.HTMLIFrameElement],
		credentialless: [self.HTMLIFrameElement],
		src: [
			self.HTMLImageElement,
			self.HTMLMediaElement,
			self.HTMLIFrameElement,
			self.HTMLFrameElement,
			self.HTMLEmbedElement,
			self.HTMLScriptElement,
			self.HTMLSourceElement,
		],
		href: [self.HTMLAnchorElement, self.HTMLLinkElement],
		data: [self.HTMLObjectElement],
		action: [self.HTMLFormElement],
		formaction: [self.HTMLButtonElement, self.HTMLInputElement],
		srcdoc: [self.HTMLIFrameElement],
		poster: [self.HTMLVideoElement],
		imagesrcset: [self.HTMLLinkElement],
	};

	const urlinterfaces = [
		self.HTMLAnchorElement.prototype,
		self.HTMLAreaElement.prototype,
	];
	const originalhrefs = [
		client.natives.call(
			"Object.getOwnPropertyDescriptor",
			null,
			self.HTMLAnchorElement.prototype,
			"href"
		),
		client.natives.call(
			"Object.getOwnPropertyDescriptor",
			null,
			self.HTMLAreaElement.prototype,
			"href"
		),
	];

	const attrs = Object_keys(attrObject);

	for (const attr of attrs) {
		for (const element of attrObject[attr]) {
			const descriptor = client.natives.call(
				"Object.getOwnPropertyDescriptor",
				null,
				element.prototype,
				attr
			);
			Object_defineProperty(element.prototype, attr, {
				get() {
					if (["src", "data", "href", "action", "formaction"].includes(attr)) {
						const value = descriptor.get.call(this);
						// A link or form whose javascript: URL moved into the realm reports the
						// URL the page gave it, not the inert one it carries
						if (client.realm && value === REALM_INERT_JAVASCRIPT_URL) {
							const original = client.natives.call(
								"Element.prototype.getAttribute",
								this,
								internalAttribute(attr)
							);
							if (typeof original === "string") return original;
						}
						return unrewriteUrl(value, client.context);
					}
					if (attr === "nonce" && client.realm) {
						// The nonce an element holds is the document's own while the client has it
						// on the element, and the page must never read it. It reads back the value
						// the page gave the element, which the rules kept
						const original = client.natives.call(
							"Element.prototype.getAttribute",
							this,
							internalAttribute("nonce")
						);
						return typeof original === "string" ? original : "";
					}

					return descriptor.get.call(this);
				},

				set(value) {
					// if (
					// 	this.tagName === "IFRAME" &&
					// 	attr === "src" &&
					// 	value === "about:blank"
					// ) {
					// 	this.setAttribute("srcdoc", "");
					// 	return;
					// }
					return this.setAttribute(attr, value);
				},
			});
		}
	}

	client.Trap("HTMLImageElement.prototype.currentSrc", {
		get(ctx) {
			const currentSrc = ctx.get() as string;
			if (!currentSrc) return currentSrc;
			return unrewriteUrl(currentSrc, client.context);
		},
	});

	// note that href is not here
	const urlprops = [
		"protocol",
		"hash",
		"host",
		"hostname",
		"origin",
		"pathname",
		"port",
		"search",
	];
	for (const prop of urlprops) {
		for (const i in urlinterfaces) {
			const target = urlinterfaces[i];
			const desc = originalhrefs[i];
			client.RawTrap(target, prop, {
				get(ctx) {
					const href = desc.get.call(ctx.this);
					if (!href) return href;

					const url = new URL(unrewriteUrl(href, client.context));

					return url[prop];
				},
			});
		}
	}

	client.Trap("Node.prototype.baseURI", {
		get(ctx) {
			const node = ctx.this as Node;
			const doc = client.box.instanceof(node, "Document")
				? (node as Document)
				: node.ownerDocument;
			const base = doc?.querySelector("base[href]") as HTMLBaseElement | null;

			if (base) {
				const href = base.getAttribute("href") || base.href;
				if (href) return new URL(href, client.url.href).href;
			}

			return client.url.href;
		},
		set() {
			return false;
		},
	});

	// A handler attribute's name is kept lowercase wherever its original is stored, because the
	// browser lowercases the names of HTML attributes and the stored name has to match
	const attributeKey = (name: unknown) =>
		client.realm?.isHandlerAttribute(String(name))
			? String(name).toLowerCase()
			: name;

	client.Proxy("Element.prototype.getAttribute", {
		apply(ctx) {
			const [name] = ctx.args;

			if (name.startsWith(internalAttributePrefix)) {
				return ctx.return(null);
			}

			if (
				client.natives.call(
					"Element.prototype.hasAttribute",
					ctx.this,
					internalAttribute(attributeKey(name) as string)
				)
			) {
				const attrib = ctx.fn.call(
					ctx.this,
					internalAttribute(attributeKey(name) as string)
				);
				if (attrib === null) return ctx.return("");

				return ctx.return(attrib);
			}
		},
	});

	client.Proxy("Element.prototype.getAttributeNames", {
		apply(ctx) {
			const attrNames = ctx.call() as string[];
			const cleaned = attrNames.filter(
				(attr) => !attr.startsWith(internalAttributePrefix)
			);

			ctx.return(cleaned);
		},
	});

	client.Proxy("Element.prototype.getAttributeNode", {
		apply(ctx) {
			if (String(ctx.args[0]).startsWith(internalAttributePrefix))
				return ctx.return(null);
		},
	});

	client.Proxy("Element.prototype.hasAttribute", {
		apply(ctx) {
			if (String(ctx.args[0]).startsWith(internalAttributePrefix))
				return ctx.return(false);
		},
	});

	// The namespaced reads were unhooked, so they bypassed the masking above:
	// `getAttributeNS(null, "scramjet-attr-src")` leaked the stored original and
	// `getAttributeNS(null, "src")` returned nothing on a rewritten element. Keep
	// them consistent with getAttribute: Scramjet's own attributes do not exist,
	// and a rewritten attribute reports its stored original.
	client.Proxy("Element.prototype.getAttributeNS", {
		apply(ctx) {
			const name = String(ctx.args[1]);

			if (name.startsWith(internalAttributePrefix)) return ctx.return(null);

			if (
				client.natives.call(
					"Element.prototype.hasAttribute",
					ctx.this,
					internalAttribute(name)
				)
			) {
				const attrib = client.natives.call(
					"Element.prototype.getAttribute",
					ctx.this,
					internalAttribute(name)
				);
				if (attrib === null) return ctx.return("");

				return ctx.return(attrib);
			}
		},
	});

	client.Proxy("Element.prototype.hasAttributeNS", {
		apply(ctx) {
			const name = String(ctx.args[1]);

			if (name.startsWith(internalAttributePrefix)) return ctx.return(false);

			if (
				client.natives.call(
					"Element.prototype.hasAttribute",
					ctx.this,
					internalAttribute(name)
				)
			) {
				return ctx.return(true);
			}
		},
	});

	client.Proxy("Element.prototype.getAttributeNodeNS", {
		apply(ctx) {
			if (String(ctx.args[1]).startsWith(internalAttributePrefix))
				return ctx.return(null);
		},
	});

	client.Proxy("Element.prototype.setAttribute", {
		apply(ctx) {
			let [name, value] = ctx.args;
			const tagName = ctx.this.tagName.toLowerCase();

			if (value != null) value = String(value);
			ctx.args[1] = value;

			if (client.realm?.isHandlerAttribute(name)) {
				// The attribute carries the one stub every handler has, and the realm reads
				// the page's source back from the copy kept beside it
				const handlerName = String(name).toLowerCase();
				ctx.fn.call(ctx.this, internalAttribute(handlerName), value);
				ctx.args[0] = handlerName;
				ctx.args[1] = client.realm.handlerStub();
				return;
			}

			const ruleList = htmlRules.find((rule) => {
				const r = rule[name.toLowerCase()];
				if (!r) return false;
				if (r === "*") return true;
				if (typeof r === "function") return false; // this can't happen but ts

				return r.includes(tagName);
			});

			if (ruleList) {
				const ret = ruleList.fn(
					value,
					client.context,
					client.meta,
					collectAttributeMap(client, ctx.this, name, value)
				);
				if (ret == null) {
					client.natives.call(
						"Element.prototype.removeAttribute",
						ctx.this,
						name
					);
					ctx.fn.call(ctx.this, internalAttribute(name), value);
					ctx.return(undefined);

					return;
				}
				ctx.args[1] = ret;
				ctx.fn.call(ctx.this, internalAttribute(ctx.args[0]), value);
			}
		},
	});

	// i actually need to do something with this
	client.Proxy("Element.prototype.setAttributeNode", {
		apply(_ctx) {},
	});

	client.Proxy("Element.prototype.setAttributeNS", {
		apply(ctx) {
			// TODO: this could leak by like calling stringify twice or some dumb shit lol
			const name = String(ctx.args[1]);
			const value = String(ctx.args[2]);

			const ruleList = htmlRules.find((rule) => {
				const r = rule[String(name).toLowerCase()];
				if (!r) return false;
				if (r === "*") return true;
				if (typeof r === "function") return false; // this can't happen but ts

				return r.includes(ctx.this.tagName.toLowerCase());
			});

			if (ruleList) {
				ctx.args[2] = ruleList.fn(
					value,
					client.context,
					client.meta,
					collectAttributeMap(client, ctx.this, name, value)
				);
				client.natives.call(
					"Element.prototype.setAttribute",
					ctx.this,
					internalAttribute(ctx.args[1]),
					value
				);
			}
		},
	});

	// this is separate from the regular href handlers because it returns an SVGAnimatedString
	client.Trap("SVGAnimatedString.prototype.baseVal", {
		get(ctx) {
			const href = ctx.get() as string;
			if (!href) return href;

			return unrewriteUrl(href, client.context);
		},
		set(ctx, val: string) {
			ctx.set(client.rewriteUrl(val));
		},
	});
	client.Trap("SVGAnimatedString.prototype.animVal", {
		get(ctx) {
			const href = ctx.get() as string;
			if (!href) return href;

			return unrewriteUrl(href, client.context);
		},
		// it has no setter
	});

	client.Proxy("Element.prototype.removeAttribute", {
		apply(ctx) {
			const name = String(ctx.args[0]);
			if (name.startsWith(internalAttributePrefix)) return ctx.return(undefined);
			if (
				client.natives.call("Element.prototype.hasAttribute", ctx.this, name)
			) {
				ctx.fn.call(
					ctx.this,
					internalAttribute(attributeKey(ctx.args[0]) as string)
				);
			}
		},
	});

	client.Proxy("Element.prototype.toggleAttribute", {
		apply(ctx) {
			const name = String(ctx.args[0]);
			if (name.startsWith(internalAttributePrefix)) return ctx.return(false);
			if (
				client.natives.call("Element.prototype.hasAttribute", ctx.this, name)
			) {
				ctx.fn.call(
					ctx.this,
					internalAttribute(attributeKey(ctx.args[0]) as string)
				);
			}
		},
	});

	client.Trap("Element.prototype.innerHTML", {
		set(ctx, value: string) {
			// null specifically becomes "" and not "null". undefined does not
			if (value === null) return;
			const html = String(value);
			let newval;
			const scriptBlockType = isScriptElement(ctx.this)
				? scriptBlockTypeForElement(client, ctx.this)
				: null;
			if (isScriptElement(ctx.this) && isScriptType(scriptBlockType)) {
				newval = rewriteJs(
					html,
					"(anonymous script element)",
					client.context,
					client.meta,
					isModuleScriptType(scriptBlockType)
				);
				client.natives.call(
					"Element.prototype.setAttribute",
					ctx.this,
					internalAttribute("script-source-src"),
					bytesToBase64(TextEncoder_encode(newval))
				);
			} else if (client.box.instanceof(ctx.this, "HTMLStyleElement")) {
				newval = rewriteCss(html, client.context, client.meta);
			} else {
				try {
					newval = rewriteHtml(html, client.context, client.meta, {
						loadScripts: false,
						inline: true,
						source: client.url.href,
						// Parsed as a fragment: a `<base>` in this markup does not select, so the
						// base already in force stays. Connected insertions that really would
						// change the document's base are a known gap — see BASE_SELECTION_BACKLOG.
						fragment: true,
						apisource: "set Element.prototype.innerHTML",
						foreignContext: foreignContextForElement(client, ctx.this),
					});
				} catch {
					newval = html;
				}
			}

			setScriptText(ctx.this, () => ctx.set(newval));
		},
		get(ctx) {
			if (isScriptElement(ctx.this)) {
				const scriptSource = client.natives.call(
					"Element.prototype.getAttribute",
					ctx.this,
					internalAttribute("script-source-src")
				);

				if (scriptSource) {
					return atob(scriptSource);
				}

				return ctx.get();
			}
			if (client.box.instanceof(ctx.this, "HTMLStyleElement")) {
				return ctx.get();
			}

			return unrewriteHtml(
				ctx.get(),
				foreignContextForElement(client, ctx.this)
			);
		},
	});

	const rewriteTextForElement = (element: Element, value: string) => {
		const scriptBlockType = isScriptElement(element)
			? scriptBlockTypeForElement(client, element)
			: null;

		if (isScriptElement(element) && isScriptType(scriptBlockType)) {
			const newval: string = rewriteJs(
				value,
				"(anonymous script element)",
				client.context,
				client.meta,
				isModuleScriptType(scriptBlockType)
			) as string;
			client.natives.call(
				"Element.prototype.setAttribute",
				element,
				internalAttribute("script-source-src"),
				bytesToBase64(TextEncoder_encode(value))
			);

			return newval;
		} else if (client.box.instanceof(element, "HTMLStyleElement")) {
			return rewriteCss(value, client.context, client.meta);
		} else {
			return value;
		}
	};
	const getTextForElement = (element: Element, text: string) => {
		if (isScriptElement(element)) {
			const scriptSource = client.natives.call(
				"Element.prototype.getAttribute",
				element,
				internalAttribute("script-source-src")
			);
			if (scriptSource) return atob(scriptSource);
			return text;
		}
		if (client.box.instanceof(element, "HTMLStyleElement")) {
			return unrewriteCss(text, client.context);
		}
		return text;
	};
	const rewritesInsertedText = (element: Node) =>
		client.box.instanceof(element, "HTMLStyleElement") ||
		isScriptElement(element);
	const rewriteInsertedTextNode = (parent: Node, node: Node) => {
		if (!rewritesInsertedText(parent)) return;
		if (client.box.instanceof(node, "Text")) {
			const text = client.descriptors.get("Node.prototype.textContent", node);
			client.descriptors.set(
				"Node.prototype.textContent",
				node,
				rewriteTextForElement(parent as Element, String(text))
			);
			return;
		}
		if (!client.box.instanceof(node, "DocumentFragment")) return;
		for (const child of Array.from(node.childNodes)) {
			rewriteInsertedTextNode(parent, child);
		}
	};

	client.Trap(
		["Node.prototype.textContent", "HTMLScriptElement.prototype.textContent"],
		{
			set(ctx, value) {
				const text = rewriteTextForElement(ctx.this, String(value));
				setScriptText(ctx.this, () => ctx.set(text));
			},
			get(ctx) {
				return getTextForElement(ctx.this, ctx.get());
			},
		}
	);
	client.Trap(
		[
			"HTMLElement.prototype.innerText",
			"HTMLScriptElement.prototype.innerText",
		],
		{
			set(ctx, value: string) {
				const text = rewriteTextForElement(ctx.this, String(value));
				setScriptText(ctx.this, () => ctx.set(text));
			},
			get(ctx) {
				return getTextForElement(ctx.this, ctx.get());
			},
		}
	);

	// A script's text is the most common way to run code the page builds, and was not hooked
	client.Trap("HTMLScriptElement.prototype.text", {
		set(ctx, value) {
			const text = rewriteTextForElement(ctx.this, String(value));
			setScriptText(ctx.this, () => ctx.set(text));
		},
		get(ctx) {
			return getTextForElement(ctx.this, ctx.get());
		},
	});

	// Text inside a script or style is rewritten as it is set, wherever it is set from
	const textNodeParent = (node: any): Element | null =>
		client.descriptors.get("Node.prototype.parentElement", node);
	client.Trap(["CharacterData.prototype.data", "Node.prototype.nodeValue"], {
		get(ctx) {
			const parent = client.box.instanceof(ctx.this, "Text")
				? textNodeParent(ctx.this)
				: null;
			if (parent && rewritesInsertedText(parent)) {
				return getTextForElement(parent, ctx.get());
			}
			return ctx.get();
		},
		set(ctx, value) {
			const parent = client.box.instanceof(ctx.this, "Text")
				? textNodeParent(ctx.this)
				: null;
			if (parent && rewritesInsertedText(parent)) {
				return ctx.set(rewriteTextForElement(parent, String(value)));
			}
			return ctx.set(value);
		},
	});

	client.Trap("Element.prototype.outerHTML", {
		set(ctx, value: string) {
			const html = String(value);
			ctx.set(
				rewriteHtml(html, client.context, client.meta, {
					loadScripts: false,
					inline: true,
					source: client.url.href,
					// Parsed as a fragment: a `<base>` in this markup does not select, so the
					// base already in force stays. Connected insertions that really would
					// change the document's base are a known gap — see BASE_SELECTION_BACKLOG.
					fragment: true,
					apisource: "set Element.prototype.outerHTML",
					foreignContext: insideForeignContext(client, ctx.this),
				})
			);
		},
		get(ctx) {
			return unrewriteHtml(ctx.get(), insideForeignContext(client, ctx.this));
		},
	});

	client.Proxy("Element.prototype.setHTMLUnsafe", {
		apply(ctx) {
			const html = String(ctx.args[0]);
			ctx.args[0] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				// Parsed as a fragment: a `<base>` in this markup does not select, so the
				// base already in force stays. Connected insertions that really would
				// change the document's base are a known gap — see BASE_SELECTION_BACKLOG.
				fragment: true,
				apisource: "set Element.prototype.setHTMLUnsafe",
				foreignContext: foreignContextForElement(client, ctx.this),
			});
		},
	});

	client.Proxy("Element.prototype.getHTML", {
		apply(ctx) {
			ctx.return(unrewriteHtml(ctx.call()));
		},
	});

	// XMLSerializer was unhooked, so `new XMLSerializer().serializeToString(el)`
	// emitted the raw `scramjet-attr-*` attributes and rewritten URLs. Run the
	// output back through the same unrewrite the innerHTML/outerHTML getters use,
	// which restores the original attributes and drops the scramjet ones.
	client.Proxy("XMLSerializer.prototype.serializeToString", {
		apply(ctx) {
			const serialized = ctx.call() as string;
			if (!serialized) return;

			const node = ctx.args[0];
			let foreignContext: ForeignContext = "html";
			try {
				if (node && client.box.instanceof(node, "Element")) {
					foreignContext = insideForeignContext(client, node as Element);
				}
			} catch {
				// A non-element node (document, fragment); fall back to html context.
			}

			return ctx.return(unrewriteHtml(serialized, foreignContext));
		},
	});

	// MutationObserver was unhooked, so a page observer saw Scramjet's internal
	// attribute mutations (`scramjet-attr-*`) and the injected scripts being
	// added/removed. Filter those records so what the page observes matches the
	// masked DOM it reads through getAttribute.
	const nodeListAllInjected = (nodes: NodeList): boolean => {
		for (const node of nodes) {
			if (!client.box.instanceof(node, "Element")) return false;
			if (
				!client.natives.call(
					"Element.prototype.hasAttribute",
					node as Element,
					injectedAttribute
				)
			) {
				return false;
			}
		}

		return true;
	};
	const filterMutationRecords = (
		records: MutationRecord[]
	): MutationRecord[] => {
		return records.filter((record) => {
			if (
				record.type === "attributes" &&
				record.attributeName &&
				String(record.attributeName).startsWith(internalAttributePrefix)
			) {
				return false;
			}

			if (
				record.type === "childList" &&
				(record.addedNodes.length > 0 || record.removedNodes.length > 0) &&
				nodeListAllInjected(record.addedNodes) &&
				nodeListAllInjected(record.removedNodes)
			) {
				return false;
			}

			return true;
		});
	};

	client.Proxy("MutationObserver", {
		construct(ctx) {
			const callback = ctx.args[0];
			if (typeof callback !== "function") return;

			ctx.args[0] = function (
				this: MutationObserver,
				records: MutationRecord[],
				observer: MutationObserver
			) {
				const cleaned = filterMutationRecords(records);
				if (cleaned.length === 0) return;

				return callback.call(this, cleaned, observer);
			};
		},
	});

	client.Proxy("MutationObserver.prototype.takeRecords", {
		apply(ctx) {
			const records = ctx.call() as MutationRecord[];

			return ctx.return(filterMutationRecords(records));
		},
	});

	client.Proxy("Element.prototype.insertAdjacentHTML", {
		apply(ctx) {
			const html = String(ctx.args[1]);
			ctx.args[1] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				// Parsed as a fragment: a `<base>` in this markup does not select, so the
				// base already in force stays. Connected insertions that really would
				// change the document's base are a known gap — see BASE_SELECTION_BACKLOG.
				fragment: true,
				apisource: "set Element.prototype.insertAdjacentHTML",
				foreignContext: foreignContextForElement(client, ctx.this),
			});
		},
	});

	client.Proxy(
		[
			"Node.prototype.appendChild",
			"Node.prototype.insertBefore",
			"Node.prototype.replaceChild",
		],
		{
			apply(ctx) {
				if (ctx.args[0]) rewriteInsertedTextNode(ctx.this, ctx.args[0]);
			},
		}
	);

	client.Proxy(
		[
			"Element.prototype.append",
			"Element.prototype.prepend",
			"Element.prototype.replaceChildren",
		],
		{
			apply(ctx) {
				if (!rewritesInsertedText(ctx.this)) return;
				for (let i = 0; i < ctx.args.length; i++) {
					const value = ctx.args[i];
					if (typeof value === "string") {
						ctx.args[i] = rewriteTextForElement(ctx.this, value);
					} else if (value) {
						rewriteInsertedTextNode(ctx.this, value);
					}
				}
			},
		}
	);

	client.Proxy("Audio", {
		construct(ctx) {
			if (ctx.args[0]) ctx.args[0] = client.rewriteUrl(ctx.args[0]);
		},
	});
	client.Proxy("Text.prototype.appendData", {
		apply(ctx) {
			const text = String(ctx.args[0]);
			const parent = client.descriptors.get(
				"Node.prototype.parentElement",
				ctx.this
			);
			ctx.args[0] = rewriteTextForElement(parent, text);
		},
	});

	client.Proxy("Text.prototype.insertData", {
		apply(ctx) {
			const text = String(ctx.args[1]);
			const parent = client.descriptors.get(
				"Node.prototype.parentElement",
				ctx.this
			);
			ctx.args[1] = rewriteTextForElement(parent, text);
		},
	});

	client.Proxy("Text.prototype.replaceData", {
		apply(ctx) {
			const text = String(ctx.args[2]);
			const parent = client.descriptors.get(
				"Node.prototype.parentElement",
				ctx.this
			);
			ctx.args[2] = rewriteTextForElement(parent, text);
		},
	});

	client.Trap("Text.prototype.wholeText", {
		get(ctx) {
			const parent = client.descriptors.get(
				"Node.prototype.parentElement",
				ctx.this
			);
			return getTextForElement(parent, ctx.get());
		},
		set(ctx, v) {
			const text = String(v);
			const parent = client.descriptors.get(
				"Node.prototype.parentElement",
				ctx.this
			);
			return ctx.set(rewriteTextForElement(parent, text));
		},
	});

	client.Proxy("HTMLAnchorElement.prototype.toString", {
		apply(ctx) {
			const href = ctx.call();
			if (!href) return href;
			return ctx.return(unrewriteUrl(href, client.context));
		},
	});

	client.Trap(
		[
			"HTMLIFrameElement.prototype.contentWindow",
			"HTMLFrameElement.prototype.contentWindow",
			"HTMLObjectElement.prototype.contentWindow",
			"HTMLEmbedElement.prototype.contentWindow",
		],
		{
			get(ctx) {
				const realwin = ctx.get() as Window;
				if (!realwin) return realwin;

				try {
					if (!(SCRAMJETCLIENT in realwin)) {
						// hook the iframe before the client can start to steal globals out of it
						client.init.hookSubcontext(realwin, ctx.this);
					}
				} catch {
					// cross-origin iframe, can't do anything here
					return realwin;
				}

				return realwin;
			},
		}
	);

	client.Trap(
		[
			"HTMLIFrameElement.prototype.contentDocument",
			"HTMLFrameElement.prototype.contentDocument",
			"HTMLObjectElement.prototype.contentDocument",
			"HTMLEmbedElement.prototype.contentDocument",
		],
		{
			get(ctx) {
				const realwin = client.descriptors.get(
					`${ctx.this.constructor.name}.prototype.contentWindow`,
					ctx.this
				);
				if (!realwin) return realwin;

				if (!(SCRAMJETCLIENT in realwin)) {
					client.init.hookSubcontext(realwin, ctx.this);
				}

				return realwin.document;
			},
		}
	);

	client.Proxy(
		[
			"HTMLIFrameElement.prototype.getSVGDocument",
			"HTMLObjectElement.prototype.getSVGDocument",
			"HTMLEmbedElement.prototype.getSVGDocument",
		],
		{
			apply(ctx) {
				const doc = ctx.call();
				if (doc) {
					// we trap the contentDocument, this is really the scramjet version
					return ctx.return(ctx.this.contentDocument);
				}
			},
		}
	);

	client.Proxy("DOMParser.prototype.parseFromString", {
		apply(ctx) {
			const html = String(ctx.args[0]);
			const mime = String(ctx.args[1]);
			// TODO: what do we do if it's xml/svg?
			if (!providers().contentTypeIsHtml(mime)) return;
			ctx.args[0] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				// Builds a document of its own: it inherits no base selection from the
				// document that called it.
				newDocument: true,
				apisource: "DOMParser.prototype.parseFromString",
			});
		},
	});
}
