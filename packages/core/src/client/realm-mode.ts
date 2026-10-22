import {
	internalAttribute,
	internalAttributePrefix,
	logicalAttribute,
	messageFields,
} from "@/runtime-identity";
import { isModuleScriptType, isScriptType } from "@/shared/mime";
import { trustedTypesPolicyName } from "@rewriters/policy";
import {
	_Set,
	Array_from,
	Error,
	Reflect_apply,
	Reflect_get,
	String,
	TextEncoder_encode,
} from "@/shared/snapshot";
import { bytesToBase64 } from "@/shared/util";
import { isEventHandlerAttribute } from "@rewriters/html";
import {
	createRealmHandlerStub,
	isRealmStub,
	type RealmScriptDetail,
	realmScriptFor,
	readRealmStubSource,
	REALM_NO_LISTENER_MESSAGE,
	decodeJavascriptUrlBody,
	unstubText,
} from "@rewriters/realm";
import { isJavascriptUrl, parserReadableUrl } from "@rewriters/javascript-url";
import { scriptBlockTypeForElement } from "@client/helpers";
import type { ScramjetClient } from "@client/index";

/** What the embedder is told of a policy violation. The page is told nothing */
export interface ViolationReport {
	directive: string;
	blockedUri: string;
	sample: string;
}

/**
 * What a document that runs its scripts in an embedder's realm needs from its
 * client. The browser runs a script only if the page's policy admits it, and the
 * policy admits the scripts that carry the document's nonce. This class decides
 * which scripts get it, and gives it for no longer than one operation.
 *
 * A script gets the nonce only after the client has checked that it holds a stub
 * or a src that goes through the proxy, and loses it as soon as the operation
 * that could run it returns. A nonce that stayed on the element could later
 * admit text the page put there through a path the client does not watch.
 */
export class RealmSupport {
	private readonly resetListeners = new _Set<() => void>();
	private readonly violationListeners = new _Set<(report: ViolationReport) => void>();
	/** The document's one Trusted Types policy for script, or null when the document has none */
	private scriptPolicy: { createScript(text: string): unknown } | null = null;
	private installed = false;

	constructor(
		private readonly client: ScramjetClient,
		/** The event stubs dispatch, which the page must never learn */
		readonly eventType: string
	) {}

	/** The nonce of the document's policy, or undefined when the document was sent without one */
	get nonce(): string | undefined {
		const nonce = this.client.context.nonce;
		return typeof nonce === "string" && nonce !== "" ? nonce : undefined;
	}

	isStub(text: string): boolean {
		return isRealmStub(text, this.eventType);
	}

	/** The page's own source out of one of this frame's stubs, or null for any other text */
	sourceOf(text: string): string | null {
		return readRealmStubSource(text, this.eventType);
	}

	/**
	 * A text read from the document with the page's own source in place of each stub it holds. A
	 * stub names the event type, and the page must not learn it from any text it reads.
	 */
	unstub(text: string): string {
		return unstubText(text, this.eventType);
	}

	/** The one text every event handler attribute carries */
	handlerStub(): string {
		return createRealmHandlerStub(this.eventType);
	}

	/**
	 * Takes the Trusted Types policies of this document before any page code can. The
	 * document's policy requires script text to be trusted: a script runs only if its text is
	 * what was last given through a trusted sink, so text changed through any other path, one
	 * the client hooks or one it never thought of, is refused by the browser. This policy is
	 * the only way to make a trusted script, and the document's policy allows no other
	 * name. The default policy lets every other sink take a string as it always did.
	 */
	private takePolicies(): void {
		const nonce = this.nonce;
		if (nonce === undefined) return;
		const factory = Reflect_get(this.client.global, "trustedTypes") as
			| { createPolicy(name: string, rules: object): unknown }
			| undefined;
		if (typeof factory !== "object" || factory === null) return;
		const same = (text: string) => text;
		// The default policy is asked for a TrustedScript wherever a string reaches a script
		// sink without one, and every answer other than a refusal lets that text run. It
		// refuses all but the one fixed text every handler attribute carries, which an
		// attribute node can only be given as a string and which holds no page code
		const handlerStub = this.handlerStub();
		const onlyHandlerStub = (text: string) =>
			text === handlerStub ? text : null;
		try {
			Reflect_apply(factory.createPolicy, factory, [
				"default",
				{ createHTML: same, createScriptURL: same, createScript: onlyHandlerStub },
			]);
			this.scriptPolicy = Reflect_apply(factory.createPolicy, factory, [
				trustedTypesPolicyName(nonce),
				{ createScript: same },
			]) as { createScript(text: string): unknown };
		} catch {
			// The document's policy named another policy, so none of its script can be set
			// by the client, and the browser refuses what the page makes. That fails closed
			this.scriptPolicy = null;
		}
	}

	/**
	 * Script text as the browser takes it where it requires trusted text. The value is a
	 * TrustedScript, which a text sink reads as its string, and any other place that takes
	 * a string takes it as one.
	 */
	trusted(text: string): string {
		return this.scriptPolicy === null
			? text
			: (this.scriptPolicy.createScript(text) as unknown as string);
	}

	/** The handler stub, trusted, for an attribute the browser reads as script */
	trustedHandlerStub(): string {
		return this.trusted(this.handlerStub());
	}

	/** Whether a name is an event handler content attribute, whatever its case */
	isHandlerAttribute(name: string): boolean {
		return isEventHandlerAttribute(String(name).toLowerCase());
	}

	/**
	 * Calls `listener` for each policy violation in this frame. The page never sees one: the
	 * report names the policy, which holds the document's nonce, and the addresses the proxy
	 * blocked.
	 */
	onViolation(listener: (report: ViolationReport) => void): () => void {
		this.violationListeners.add(listener);
		return () => {
			this.violationListeners.delete(listener);
		};
	}

	/** Runs `listener` after the realm is rebuilt following `document.open()` erased this frame's listeners */
	onReset(listener: () => void): () => void {
		this.resetListeners.add(listener);
		return () => {
			this.resetListeners.delete(listener);
		};
	}

	isScriptElement(node: unknown): node is Element {
		return (
			this.client.box.instanceof(node, "HTMLScriptElement") ||
			this.client.box.instanceof(node, "SVGScriptElement")
		);
	}

	private attribute(element: Element, name: string): string | null {
		return this.client.natives.call(
			"Element.prototype.getAttribute",
			element,
			name
		) as string | null;
	}

	/** The text a script element runs, which is the data of its direct text children */
	scriptSource(script: Element): string {
		const children = this.client.descriptors.get(
			"Node.prototype.childNodes",
			script
		) as NodeList;
		let text = "";
		for (const child of Array_from(children)) {
			if (
				this.client.descriptors.get("Node.prototype.nodeType", child) === 3
			) {
				text += String(
					this.client.descriptors.get("CharacterData.prototype.data", child)
				);
			}
		}
		return text;
	}

	/** Whether the script's src goes through the proxy, which answers a script with a stub */
	hasProxiedSrc(script: Element): boolean {
		const src = this.attribute(script, "src");
		return (
			src !== null && src.startsWith(this.client.context.prefix.href)
		);
	}

	/**
	 * Makes the script one the realm can run, and says whether it is. Text that
	 * reached the element through a path the client does not hook is turned into
	 * a stub here. A script with a src the proxy does not own is left alone and
	 * stays without a nonce, so the browser refuses it.
	 */
	makeSafe(script: Element, convert = true): boolean {
		const type = scriptBlockTypeForElement(this.client, script);
		if (!isScriptType(type)) return false;
		if (
			this.client.natives.call(
				"Element.prototype.hasAttribute",
				script,
				"src"
			)
		) {
			return this.hasProxiedSrc(script);
		}
		const text = this.scriptSource(script);
		if (text === "") return false;
		if (this.isStub(text)) {
			// The browser runs a script whose text is what was last set through a trusted sink.
			// The text of this one may have arrived another way, as a clone's or a text node's
			// does, so it is set again, here, where nothing can run it
			if (convert) this.writeScriptText(script, text);
			return true;
		}
		// A script already in the document has run, and its text is left as it is
		if (!convert) return false;
		const stub = realmScriptFor(
			this.client.context.config,
			text,
			"(anonymous script element)",
			isModuleScriptType(type),
			false
		);
		this.client.natives.call(
			"Element.prototype.setAttribute",
			script,
			internalAttribute("script-source-src"),
			bytesToBase64(TextEncoder_encode(text))
		);
		this.writeScriptText(script, stub);
		return true;
	}

	/**
	 * Sets the text of a script through the sink the browser holds trusted text to. Only an HTML
	 * script has that sink, and the Node one does not record what it was given, so a script
	 * whose text was set through it is refused when it runs.
	 */
	writeScriptText(script: Element, text: string): void {
		this.client.descriptors.set(
			this.client.box.instanceof(script, "HTMLScriptElement")
				? "HTMLScriptElement.prototype.text"
				: "Node.prototype.textContent",
			script,
			this.trusted(text)
		);
	}

	private setNonce(script: Element, value: string): void {
		this.client.descriptors.set(
			this.client.box.instanceof(script, "SVGElement")
				? "SVGElement.prototype.nonce"
				: "HTMLElement.prototype.nonce",
			script,
			value
		);
	}

	/** The script elements in or under the nodes an insertion call is given */
	scriptsIn(values: readonly unknown[]): Element[] {
		const found: Element[] = [];
		for (const value of values) {
			if (value === null || typeof value !== "object") continue;
			if (this.isScriptElement(value)) {
				found.push(value);
			} else if (this.client.box.instanceof(value, "Element")) {
				found.push(
					...Array_from(
						this.client.natives.call(
							"Element.prototype.querySelectorAll",
							value as Element,
							"script"
						)
					)
				);
			} else if (this.client.box.instanceof(value, "DocumentFragment")) {
				found.push(
					...Array_from(
						this.client.natives.call(
							"DocumentFragment.prototype.querySelectorAll",
							value as DocumentFragment,
							"script"
						)
					)
				);
			}
		}
		return found;
	}

	/**
	 * Runs one operation that may run these scripts, with the nonce on each of
	 * the ones that are safe to run. The nonce is gone again when it returns,
	 * and a script without a nonce is one the browser refuses.
	 */
	withNonce<T>(scripts: readonly Element[], run: () => T): T {
		const nonce = this.nonce;
		if (nonce === undefined) return run();
		const stamped: Element[] = [];
		for (const script of scripts) {
			const connected = this.client.descriptors.get(
				"Node.prototype.isConnected",
				script
			);
			if (this.makeSafe(script, !connected)) {
				this.setNonce(script, nonce);
				stamped.push(script);
			}
		}
		try {
			return run();
		} finally {
			for (const script of stamped) this.setNonce(script, "");
		}
	}

	/**
	 * Runs an operation that sets the text of a script in the document, which runs
	 * the script at once. The text it sets is a stub the caller made, so the nonce
	 * goes on for the one operation, to a script with no src or one the proxy owns.
	 */
	withTextNonce<T>(script: Element, run: () => T): T {
		const nonce = this.nonce;
		if (
			nonce === undefined ||
			!this.client.descriptors.get("Node.prototype.isConnected", script) ||
			!isScriptType(scriptBlockTypeForElement(this.client, script)) ||
			(this.client.natives.call(
				"Element.prototype.hasAttribute",
				script,
				"src"
			) &&
				!this.hasProxiedSrc(script))
		) {
			return run();
		}
		this.setNonce(script, nonce);
		try {
			return run();
		} finally {
			this.setNonce(script, "");
		}
	}

	/** The origin a message from this frame carries: its own, or the parent's for a blank or srcdoc frame */
	private messageOrigin(): string {
		const href = this.client.url.href;
		if (href === "about:srcdoc" || href === "about:blank") {
			const parent = this.client.box.globals.get(
				this.client.global.parent as Self
			);
			if (parent) return parent.url.origin;
		}
		return this.client.url.origin;
	}

	/**
	 * The arguments of a `postMessage` from this frame, ready for the browser. The page
	 * on the other end has no way to know the real origin of a proxied one, so the
	 * message carries it, and the browser is told to deliver to any origin because the
	 * target's own address is the proxy's.
	 */
	wrapWindowMessage(args: readonly unknown[]): unknown[] {
		const rest = args.slice(1);
		const [options] = rest;
		if (typeof options === "string") {
			rest[0] = "*";
		} else if (typeof options === "object" && options !== null) {
			rest[0] = { ...options, targetOrigin: "*" };
		}
		return [
			{
				[messageFields.type]: "window",
				[messageFields.origin]: this.messageOrigin(),
				[messageFields.data]: args[0],
			},
			...rest,
		];
	}

	/**
	 * Posts a message made by `wrapWindowMessage` to a window. The browser takes the realm that
	 * made the call as the sender, so the call is made from here, in this frame, and the
	 * receiving page is told its source is this frame's window and not the embedder's.
	 */
	postWindowMessage(target: Window, wrapped: readonly unknown[]): undefined {
		const post = this.client.natives.store["window.postMessage"];
		if (typeof post !== "function") throw new Error("The frame has no native postMessage");
		Reflect_apply(post, target, wrapped);
		return undefined;
	}

	private newEvent(detail: RealmScriptDetail): Event {
		return this.client.natives.construct("CustomEvent", this.eventType, {
			cancelable: true,
			detail,
		}) as Event;
	}

	/** Hands source to the embedder's realm as a classic script. Throws if nothing in the frame took it */
	runClassic(source: string): void {
		const notTaken = this.client.natives.call(
			"EventTarget.prototype.dispatchEvent",
			this.client.global.document,
			this.newEvent({ k: "classic", s: source, u: null, e: null })
		);
		if (notTaken) throw new Error(REALM_NO_LISTENER_MESSAGE);
	}

	/** Runs the code of a `javascript:` URL in the realm, as a navigation to it would */
	runJavascriptUrl(url: string): void {
		this.runClassic(
			decodeJavascriptUrlBody(
				parserReadableUrl(url).slice("javascript:".length)
			)
		);
	}

	/**
	 * Runs the code of a `javascript:` URL as a navigation to it does, in a task of its own
	 * rather than inside the call that asked for it.
	 */
	navigateToJavascriptUrl(url: string): void {
		this.later(() => this.runJavascriptUrl(url));
	}

	private later(task: () => void): void {
		this.client.natives.call("setTimeout", this.client.global, () => {
			try {
				task();
			} catch (error) {
				const report = Reflect_get(this.client.global, "reportError");
				if (typeof report === "function") {
					Reflect_apply(report, this.client.global, [error]);
				} else {
					throw error;
				}
			}
		}, 0);
	}

	/**
	 * The source of the event handler attribute that is running. A stub holds none,
	 * so it is read back from the copy the rewriter kept: the attribute named for
	 * the event, on the element the handler belongs to.
	 */
	private handlerSource(target: unknown, event: unknown): string | null {
		let element: Element | null = null;
		if (this.client.box.instanceof(target, "Window")) {
			// A body's handlers for window events are forwarded to the window
			const document = Reflect_get(target as object, "document") as Document;
			element =
				(this.client.natives.call(
					"Document.prototype.querySelector",
					document,
					"body, frameset"
				) as Element | null) ?? null;
		} else if (this.client.box.instanceof(target, "Element")) {
			element = target as Element;
		}
		if (element === null) return null;

		const type =
			event !== null && typeof event === "object"
				? Reflect_get(event, "type")
				: undefined;
		if (typeof type === "string") {
			const named = this.attribute(element, internalAttribute(`on${type}`));
			if (named !== null) return named;
		}
		// A handler called without an event, as in `element.onclick()`, has no type to
		// name its attribute. It can only be the element's single handler
		let only: string | null = null;
		for (const name of this.client.natives.call(
			"Element.prototype.getAttributeNames",
			element
		) as string[]) {
			if (!name.startsWith(internalAttributePrefix)) continue;
			const logical = logicalAttribute(name);
			if (logical === null || !this.isHandlerAttribute(logical)) continue;
			if (only !== null) return null;
			only = this.attribute(element, name);
		}
		return only;
	}

	private readonly onStubEvent = (event: Event): void => {
		const detail = Reflect_get(event, "detail") as RealmScriptDetail | null;
		if (
			detail === null ||
			typeof detail !== "object" ||
			detail.k !== "handler" ||
			(detail.s !== null && detail.s !== undefined)
		) {
			return;
		}
		const source = this.handlerSource(detail.t, detail.ev);
		if (source !== null) detail.s = source;
	};

	private readonly onViolationEvent = (event: Event): void => {
		// The browser reports a violation to the page's listeners, and the report holds the
		// policy it enforced. This listener is first, and nothing after it gets the event
		this.client.natives.call("Event.prototype.stopImmediatePropagation", event);
		const report: ViolationReport = {
			directive: String(Reflect_get(event, "violatedDirective")),
			blockedUri: String(Reflect_get(event, "blockedURI")),
			sample: String(Reflect_get(event, "sample")),
		};
		for (const listener of Array_from(this.violationListeners)) {
			try {
				listener(report);
			} catch {
				// An embedder's listener that throws does not stop the others
			}
		}
	};

	/** The `a` or `area` element whose activation behavior this click would run */
	private activationLink(event: Event): Element | null {
		const path = this.client.natives.call(
			"Event.prototype.composedPath",
			event
		) as unknown[];
		for (const node of path) {
			if (!this.client.box.instanceof(node, "Element")) continue;
			const element = node as Element;
			const name = String(
				this.client.descriptors.get("Element.prototype.localName", element)
			);
			if (
				(name === "a" || name === "area") &&
				this.client.natives.call(
					"Element.prototype.hasAttribute",
					element,
					"href"
				)
			) {
				return element;
			}
		}
		return null;
	}

	/**
	 * Runs the code of a `javascript:` URL after the event that activated it, if
	 * nothing cancelled that event. A browser queues it as a task, and the page's
	 * handlers see the event first.
	 */
	private activate(event: Event, original: string | null): void {
		if (original === null || !isJavascriptUrl(original)) return;
		this.later(() => {
			if (!Reflect_get(event, "defaultPrevented")) {
				this.runJavascriptUrl(original);
			}
		});
	}

	private readonly onClick = (event: Event): void => {
		const mouse = event as MouseEvent;
		if (mouse.ctrlKey || mouse.metaKey || mouse.shiftKey || mouse.altKey) return;
		const link = this.activationLink(event);
		if (link === null) return;
		this.activate(event, this.attribute(link, internalAttribute("href")));
	};

	private readonly onSubmit = (event: Event): void => {
		const submitter = Reflect_get(event, "submitter") as Element | null;
		const form = Reflect_get(event, "target") as Element | null;
		let original: string | null = null;
		if (submitter) {
			original = this.attribute(submitter, internalAttribute("formaction"));
		}
		if (original === null && form) {
			original = this.attribute(form, internalAttribute("action"));
		}
		this.activate(event, original);
	};

	private listen(): void {
		const add = (
			target: EventTarget,
			type: string,
			listener: (event: Event) => void
		) =>
			this.client.natives.call(
				"EventTarget.prototype.addEventListener",
				target,
				type,
				listener as EventListener,
				true
			);
		// Every listener is one function object, so adding it again after the browser
		// erased it is a no-op for the ones still there
		add(this.client.global.document, this.eventType, this.onStubEvent);
		add(
			this.client.global as unknown as EventTarget,
			"securitypolicyviolation",
			this.onViolationEvent
		);
		add(this.client.global as unknown as EventTarget, "click", this.onClick);
		add(this.client.global as unknown as EventTarget, "submit", this.onSubmit);
	}

	/**
	 * Takes hold of the natives this class depends on before any other client
	 * module replaces them, and starts listening. Called once, first.
	 */
	install(): void {
		if (this.installed) return;
		this.installed = true;
		this.takePolicies();
		const store = this.client.descriptors.store;
		const touch = (from: object, name: string) => Reflect_get(from, name);
		for (const name of [
			"Node.prototype.childNodes",
			"Node.prototype.nodeType",
			"Node.prototype.isConnected",
			"Node.prototype.parentElement",
			"Node.prototype.textContent",
			"HTMLScriptElement.prototype.text",
			"CharacterData.prototype.data",
			"HTMLElement.prototype.nonce",
			"SVGElement.prototype.nonce",
			"Element.prototype.localName",
			"Attr.prototype.ownerElement",
			"Attr.prototype.name",
			"Attr.prototype.namespaceURI",
			"Attr.prototype.value",
		]) {
			touch(store, name);
		}
		const natives = this.client.natives.store;
		for (const name of [
			"CustomEvent",
			"setTimeout",
			"EventTarget.prototype.addEventListener",
			"EventTarget.prototype.dispatchEvent",
			"Event.prototype.composedPath",
			"Event.prototype.stopImmediatePropagation",
			"Element.prototype.getAttribute",
			"Element.prototype.getAttributeNames",
			"Element.prototype.hasAttribute",
			"Element.prototype.setAttribute",
			"Element.prototype.querySelectorAll",
			"DocumentFragment.prototype.querySelectorAll",
			"Document.prototype.querySelector",
		]) {
			touch(natives, name);
		}
		this.listen();
	}

	/** Listens again after `document.open()` erased the document's and window's listeners */
	reinstall(): void {
		this.listen();
		for (const listener of this.resetListeners) listener();
	}
}
