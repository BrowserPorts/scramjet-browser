/* eslint-disable scramjet-core/no-globals -- loaded on its own by the gate tests, and only
   reached with realmExecution on, where page code does not run in this realm to tamper
   with the globals it uses */

/**
 * Stand-ins for page script text in realm mode.
 *
 * Scramjet never rewrites the page's script in this mode. It hands the text to
 * a realm the embedder owns, and what the document carries in its place is a
 * stub: a few statements that pass the original source to that realm as the
 * detail of a DOM event. The page's code is only ever data in a string here,
 * and the stub defines no global to find the realm through.
 *
 * Event handler attributes are different. Their stub is the same fixed text for
 * every handler, with the source kept in an internal attribute that the client
 * reads when the event fires. The browser admits an attribute handler only by
 * the hash of its text, and one fixed text means one hash covers every handler,
 * including the ones the page creates after the document's policy was sent.
 */

export type RealmScriptKind = "classic" | "module" | "handler";

/** What a stub passes to the realm's listener, as the detail of its event */
export interface RealmScriptDetail {
	/** What the source is */
	k: RealmScriptKind;
	/** The page's own source text. A handler's is filled in by the client before the embedder sees it */
	s: string | null;
	/** Where the page says the source came from, or null for inline code */
	u: string | null;
	/** The script element running the stub, for classic scripts */
	e?: object | null;
	/** The element or window an event handler runs for */
	t?: unknown;
	/** The event an event handler runs for */
	ev?: unknown;
	/** The arguments an event handler was called with */
	a?: ArrayLike<unknown>;
	/** Filled in by the listener with an event handler's return value */
	r?: unknown;
	/** Filled in by the listener with a module's evaluation, which a module stub awaits */
	p?: unknown;
}

/** The error a stub throws when nothing in the frame took its event */
export const REALM_NO_LISTENER_MESSAGE = "The hardened frame has no active realm";

/** What an anchor or form with a `javascript:` URL carries once its code has moved to an internal attribute */
export const REALM_INERT_JAVASCRIPT_URL = "javascript:void 0";

const STUB_START = "var d={k:";
// A classic script's top-level `var` becomes a property of the window, so its
// stub keeps its data in a block where `const` leaves nothing behind
const CLASSIC_START = "{const d={k:";

const HANDLER_PROLOGUE =
	"var d={k:\"handler\",s:null,u:null,t:this,ev:event,a:arguments,r:void 0};";
const HANDLER_TARGET = "(this.ownerDocument||this.document)";
const HANDLER_EPILOGUE = "return d.r";

/**
 * JSON that is safe inside an HTML script element and anywhere JavaScript is
 * parsed. `<` would let source text close the element or open a comment, and
 * the line separators were not legal in older string literals.
 */
export function embedText(value: string): string {
	return JSON.stringify(value).replace(
		/[<\u2028\u2029]/gu,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
	);
}

function dispatch(eventType: string, target: string): string {
	// The event is cancelable and the listener cancels it, so a stub that nothing
	// took is an error and never a silently skipped script
	return `if(${target}.dispatchEvent(new CustomEvent(${embedText(eventType)},{cancelable:true,detail:d})))throw new Error(${embedText(REALM_NO_LISTENER_MESSAGE)});`;
}

/**
 * The stub for an event handler attribute. It is the same text for every
 * handler of a frame, so its hash can be listed in the document's policy up
 * front. `this` is the element (or the window, for a handler the body forwards)
 * and `event` is the event, as in a compiled attribute.
 */
export function createRealmHandlerStub(eventType: string): string {
	return `${HANDLER_PROLOGUE}${dispatch(eventType, HANDLER_TARGET)}${HANDLER_EPILOGUE}`;
}

/** The stub for a classic script or a module */
export function createRealmStub(options: {
	eventType: string;
	kind: "classic" | "module";
	source: string;
	url: string | null;
}): string {
	const { eventType, kind, source, url } = options;
	const data = `s:${embedText(source)},u:${url === null ? "null" : embedText(url)}`;
	if (kind === "module") {
		return `${STUB_START}"module",${data},e:null,p:void 0};${dispatch(eventType, "document")}await d.p;`;
	}
	return `${CLASSIC_START}"classic",${data},e:document.currentScript};${dispatch(eventType, "document")}}`;
}

/** Where a JSON string that starts at `index` ends, one past its closing quote, or -1 */
function stringEnd(text: string, index: number): number {
	if (text[index] !== "\"") return -1;
	let end = index + 1;
	while (end < text.length && text[end] !== "\"") end += text[end] === "\\" ? 2 : 1;
	return end < text.length ? end + 1 : -1;
}

function jsonString(token: string): string | null {
	try {
		const value: unknown = JSON.parse(token);
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

/** What a classic or module stub carries, read out of its text */
export interface ParsedRealmStub {
	kind: "classic" | "module";
	source: string;
	url: string | null;
}

/** Where one stub begins in a text, read as far as it goes */
interface StubAt extends ParsedRealmStub {
	/** One past the stub's last character */
	end: number;
}

/**
 * Reads a classic or module stub that begins at `start`, or answers null when what begins there
 * is not exactly one. The two JSON strings are read, a stub is built again from them, and the text
 * has to be that stub character for character. A prefix and a suffix are not enough: text a page
 * puts between two stubs, or around one, would pass a check on the ends and run in this
 * document's own realm.
 */
function stubAt(text: string, start: number, eventType: string): StubAt | null {
	let kind: "classic" | "module";
	let offset: number;
	if (text.startsWith(CLASSIC_START, start)) {
		kind = "classic";
		offset = start + `${CLASSIC_START}"classic",s:`.length;
	} else if (text.startsWith(`${STUB_START}"module"`, start)) {
		kind = "module";
		offset = start + `${STUB_START}"module",s:`.length;
	} else {
		return null;
	}
	const sourceEnd = stringEnd(text, offset);
	if (sourceEnd === -1) return null;
	const source = jsonString(text.slice(offset, sourceEnd));
	if (source === null || !text.startsWith(",u:", sourceEnd)) return null;
	const urlStart = sourceEnd + ",u:".length;
	let url: string | null;
	if (text.startsWith("null", urlStart)) {
		url = null;
	} else {
		const urlEnd = stringEnd(text, urlStart);
		if (urlEnd === -1) return null;
		url = jsonString(text.slice(urlStart, urlEnd));
		if (url === null) return null;
	}
	const rebuilt = createRealmStub({ eventType, kind, source, url });
	return text.startsWith(rebuilt, start) ? { kind, source, url, end: start + rebuilt.length } : null;
}

/** The page's source and address out of a text that is exactly one classic or module stub of this frame, or null */
export function parseRealmStub(text: string, eventType: string): ParsedRealmStub | null {
	const found = stubAt(text, 0, eventType);
	if (found === null || found.end !== text.length) return null;
	return { kind: found.kind, source: found.source, url: found.url };
}

/**
 * A text with the page's own source in place of each of this frame's stubs it holds. Reading
 * what a script element's text nodes hold, through any API, is a way to learn the stub's event
 * type, so a read of text the page did not write gives it back what it did.
 */
export function unstubText(text: string, eventType: string): string {
	// Every stub names the event type, so text without it holds none
	if (!text.includes(eventType)) return text;
	let result = "";
	let cursor = 0;
	for (;;) {
		const classic = text.indexOf(CLASSIC_START, cursor);
		const module = text.indexOf(STUB_START, cursor);
		const candidates = [classic, module].filter((position) => position !== -1);
		if (candidates.length === 0) break;
		const start = Math.min(...candidates);
		const found = stubAt(text, start, eventType);
		if (found === null) {
			result += text.slice(cursor, start + 1);
			cursor = start + 1;
			continue;
		}
		result += text.slice(cursor, start) + found.source;
		cursor = found.end;
	}
	return result + text.slice(cursor);
}

/**
 * Whether script text is exactly one of this frame's stubs and holds no page code of
 * its own. Text written by the page cannot pass for one without knowing the frame's
 * event type, and text that merely starts and ends like one is not one.
 */
export function isRealmStub(text: string, eventType: string): boolean {
	return text === createRealmHandlerStub(eventType) || parseRealmStub(text, eventType) !== null;
}

/**
 * The page's own source out of one of this frame's stubs, or null for any other text. A page
 * that reads the text of its own script element expects its source, and the stub, which names
 * the frame's event type, is not for it.
 */
export function readRealmStubSource(text: string, eventType: string): string | null {
	return parseRealmStub(text, eventType)?.source ?? null;
}

/**
 * The source a browser runs for a `javascript:` URL. The URL parser drops tabs
 * and newlines first, then the body is percent-decoded as bytes and read as
 * UTF-8, and a `%` that does not start two hex digits stays as it is.
 */
export function decodeJavascriptUrlBody(body: string): string {
	const text = body.replace(/[\t\n\r]/gu, "");
	const encoder = new TextEncoder();
	const bytes: number[] = [];
	let index = 0;
	while (index < text.length) {
		const hex = text.slice(index + 1, index + 3);
		if (text[index] === "%" && /^[0-9a-fA-F]{2}$/u.test(hex)) {
			bytes.push(Number.parseInt(hex, 16));
			index += 3;
			continue;
		}
		const character = String.fromCodePoint(text.codePointAt(index) ?? 0);
		for (const byte of encoder.encode(character)) bytes.push(byte);
		index += character.length;
	}
	return new TextDecoder("utf-8", { ignoreBOM: true }).decode(Uint8Array.from(bytes));
}

/** The label the URL rewriter gives script text taken from a `javascript:` URL */
export const JAVASCRIPT_URL_LABEL = "(javascript: url)";

export function realmScriptKind(isModule: boolean, functionBody: boolean): RealmScriptKind {
	if (functionBody) return "handler";
	return isModule ? "module" : "classic";
}

/**
 * A script label that says nothing about the page. Inline code has no URL, and
 * Scramjet's placeholder labels for it are not URLs a page could see.
 */
function stubUrl(label: string | null): string | null {
	if (label === null) return null;
	return label.startsWith("(") ? null : label;
}

/**
 * The text a document carries in place of script text. A config without a realm
 * event type is an error: the flag exists so page code never runs in this
 * document's own realm, and leaving the text as it is would put it there.
 *
 * @param config The context's config, which names the event the embedder's realm listens for
 */
export function realmScriptFor(
	config: { realm?: { eventType: string } },
	js: string | Uint8Array,
	url: string | null,
	isModule: boolean,
	functionBody: boolean
): string {
	const eventType = config.realm?.eventType;
	if (typeof eventType !== "string" || eventType === "") {
		throw new Error("realmExecution is on but the config names no realm event type");
	}
	const kind = realmScriptKind(isModule, functionBody);
	if (kind === "handler") return createRealmHandlerStub(eventType);
	const source = typeof js === "string" ? js : new TextDecoder().decode(js);
	return createRealmStub({ eventType, kind, source, url: stubUrl(url) });
}
