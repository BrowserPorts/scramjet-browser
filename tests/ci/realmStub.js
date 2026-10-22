/**
 * @fileoverview
 * The stubs that stand in for page script in realm mode are executed here, in a
 * vm with a fake document, with sources chosen to break out of a string, a
 * script element or a URL. The page's text must arrive in the realm byte for
 * byte and never run in the stub's own realm.
 */

import test from "ava";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.resolve(here, "../../packages/core/src/shared/rewriters");

const realm = await import(pathToFileURL(path.join(core, "realm.ts")).href);
const jsUrl = await import(pathToFileURL(path.join(core, "javascript-url.ts")).href);

const EVENT = "evt-3f9c";

const ADVERSARIAL = [
	"",
	"alert(1)",
	"</script><script>alert(1)</script>",
	"<!-- <script>",
	"--> x",
	"a\u2028b\u2029c",
	"lone \ud800 surrogate",
	"`${x}` 'single' \"double\" \\back\\ \\u2028",
	"\0nul\0",
	"x".repeat(200000),
	"// comment with trailing line continuation \\",
	"});throw new Error('escaped');({",
	'"); throw new Error("escaped"); ("',
	"%41%42 #fragment",
];

class FakeEvent {
	constructor(type, init) {
		this.type = type;
		this.detail = init.detail;
		this.cancelable = init.cancelable;
		this.defaultPrevented = false;
	}
	preventDefault() {
		this.defaultPrevented = true;
	}
}

function world({ take = true, onEvent } = {}) {
	const received = [];
	const marker = { id: "current script" };
	const document = {
		currentScript: marker,
		dispatchEvent(event) {
			received.push(event);
			if (take) {
				onEvent?.(event);
				event.preventDefault();
			}
			return !event.defaultPrevented;
		},
	};
	document.ownerDocument = document;
	const context = vm.createContext({ document, CustomEvent: FakeEvent, Error });
	return { context, received, marker, document };
}

test("a classic stub hands the source over unchanged and runs nothing of it", (t) => {
	for (const source of ADVERSARIAL) {
		const { context, received, marker } = world();
		const stub = realm.createRealmStub({ eventType: EVENT, kind: "classic", source, url: null });
		vm.runInContext(stub, context);
		t.is(received.length, 1, source.slice(0, 30));
		t.is(received[0].type, EVENT);
		t.is(received[0].detail.k, "classic");
		t.is(received[0].detail.s, source);
		t.is(received[0].detail.u, null);
		t.is(received[0].detail.e, marker);
		t.is(vm.runInContext("typeof d", context), "undefined", "the stub leaves no variable behind");
		t.deepEqual(Object.keys(context).sort(), ["CustomEvent", "Error", "document"]);
	}
});

test("the url a stub carries is data too", (t) => {
	const url = 'https://a.test/x.js?q="</script>\u2028';
	const { context, received } = world();
	vm.runInContext(realm.createRealmStub({ eventType: EVENT, kind: "classic", source: "x", url }), context);
	t.is(received[0].detail.u, url);
});

test("a stub never contains characters that end a script element or a string", (t) => {
	for (const source of ADVERSARIAL.slice(0, 8)) {
		const stub = realm.createRealmStub({ eventType: EVENT, kind: "classic", source, url: source });
		t.false(stub.includes("<"));
		t.false(stub.includes("\u2028"));
		t.false(stub.includes("\u2029"));
	}
});

test("a stub that nothing takes throws instead of skipping the script", (t) => {
	const { context } = world({ take: false });
	const stub = realm.createRealmStub({ eventType: EVENT, kind: "classic", source: "x", url: null });
	const error = t.throws(() => vm.runInContext(stub, context));
	t.is(error.message, realm.REALM_NO_LISTENER_MESSAGE);
});

test("a module stub waits for the realm's evaluation", async (t) => {
	for (const source of ADVERSARIAL.slice(0, 8)) {
		let settled = false;
		const { context, received } = world({
			onEvent(event) {
				event.detail.p = new Promise((resolve) => setTimeout(() => {
					settled = true;
					resolve();
				}, 5));
			},
		});
		const stub = realm.createRealmStub({ eventType: EVENT, kind: "module", source, url: "https://a.test/m.js" });
		await vm.runInContext(`(async () => { ${stub} })()`, context);
		t.true(settled, "the stub awaited the evaluation");
		t.is(received[0].detail.k, "module");
		t.is(received[0].detail.s, source);
	}
});

test("a handler stub is one text and reports the element, event and arguments", (t) => {
	const stub = realm.createRealmHandlerStub(EVENT);
	t.is(stub, realm.createRealmHandlerStub(EVENT));
	t.not(stub, realm.createRealmHandlerStub("other"));

	const { context, received, document } = world({
		onEvent(event) {
			event.detail.r = false;
		},
	});
	const handler = vm.runInContext(`(function(event){${stub}\n})`, context);
	const element = { ownerDocument: document };
	const event = { type: "click" };
	const result = handler.call(element, event, "extra");
	t.is(result, false, "the listener's return value comes back");
	const detail = received[0].detail;
	t.is(detail.k, "handler");
	t.is(detail.s, null, "the client fills the source in");
	t.is(detail.t, element);
	t.is(detail.ev, event);
	t.is(detail.a[1], "extra");
});

test("a handler for a window reaches the document through the window", (t) => {
	const { context, received, document } = world();
	const handler = vm.runInContext(`(function(event){${realm.createRealmHandlerStub(EVENT)}\n})`, context);
	handler.call({ document }, { type: "load" });
	t.is(received.length, 1);
});

test("only this frame's own stubs are recognised, and the page cannot write one", (t) => {
	const stub = realm.createRealmStub({ eventType: EVENT, kind: "classic", source: "x", url: null });
	t.true(realm.isRealmStub(stub, EVENT));
	t.false(realm.isRealmStub(stub, "evt-other"));
	t.false(realm.isRealmStub(stub.slice(0, -1), EVENT));
	t.false(realm.isRealmStub(`alert(1);${stub}`, EVENT));
	t.false(realm.isRealmStub("", EVENT));
	t.false(realm.isRealmStub("{const d={k:", EVENT));
	// the data in the middle belongs to the page, but the end names the event type
	t.false(realm.isRealmStub(`{const d={k:"classic",s:"x",u:null,e:document.currentScript};alert(1)}`, EVENT));
	t.true(realm.isRealmStub(realm.createRealmHandlerStub(EVENT), EVENT));
});

test("the source comes back out of a stub exactly", (t) => {
	for (const source of ADVERSARIAL) {
		for (const kind of ["classic", "module"]) {
			const stub = realm.createRealmStub({ eventType: EVENT, kind, source, url: null });
			t.is(realm.readRealmStubSource(stub, EVENT), source);
		}
	}
	t.is(realm.readRealmStubSource("not a stub", EVENT), null);
	t.is(realm.readRealmStubSource(realm.createRealmHandlerStub(EVENT), EVENT), null);
});

test("javascript: urls are told apart the way the url parser tells them", (t) => {
	for (const url of [
		"javascript:x",
		"JavaScript:x",
		"JAVASCRIPT:x",
		"  javascript:x",
		"\u0001\u0002javascript:x",
		"java\tscript:x",
		"java\nscript:x",
		"jav&#x09;ascript:x".replace("&#x09;", "\t"),
		"\r\n javascript:x",
	]) {
		t.true(jsUrl.isJavascriptUrl(url), JSON.stringify(url));
	}
	for (const url of ["", "javascript", "xjavascript:x", "javascript :x", "data:text/html,javascript:x", "/javascript:x", "https://a.test/javascript:x"]) {
		t.false(jsUrl.isJavascriptUrl(url), JSON.stringify(url));
	}
	t.is(jsUrl.parserReadableUrl("  java\tscript:a\nb"), "javascript:ab");
});

test("the body of a javascript: url is decoded the way a browser decodes it", (t) => {
	t.is(realm.decodeJavascriptUrlBody("alert(1)"), "alert(1)");
	t.is(realm.decodeJavascriptUrlBody("a%20b"), "a b");
	t.is(realm.decodeJavascriptUrlBody("%E2%82%AC"), "€");
	t.is(realm.decodeJavascriptUrlBody("100%"), "100%");
	t.is(realm.decodeJavascriptUrlBody("%zz%4"), "%zz%4");
	t.is(realm.decodeJavascriptUrlBody("a\tb\nc"), "abc");
	t.is(realm.decodeJavascriptUrlBody("%EF%BB%BFx"), "﻿x", "a BOM is kept");
});

test("text that only starts and ends like a stub is not one", (t) => {
	const a = realm.createRealmStub({ eventType: EVENT, kind: "classic", source: "a()", url: null });
	const b = realm.createRealmStub({ eventType: EVENT, kind: "classic", source: "b()", url: null });
	// raw text between two real stubs, which a check of the two ends would let through
	t.false(realm.isRealmStub(`${a}window.__pwn=1;${b}`, EVENT));
	t.false(realm.isRealmStub(`${a}${b}`, EVENT));
	t.false(realm.isRealmStub(`${a}window.__pwn=1;`, EVENT));
	t.false(realm.isRealmStub(`window.__pwn=1;${a}`, EVENT));
	t.is(realm.readRealmStubSource(`${a}window.__pwn=1;${b}`, EVENT), null);
	const m = realm.createRealmStub({ eventType: EVENT, kind: "module", source: "export {}", url: null });
	t.false(realm.isRealmStub(`${m}window.__pwn=1;${m}`, EVENT));
	t.false(realm.isRealmStub(`${a}${m}`, EVENT));
});

test("a stub with a non-canonical string or a stray part is not one", (t) => {
	const stub = realm.createRealmStub({ eventType: EVENT, kind: "classic", source: "A", url: null });
	t.true(realm.isRealmStub(stub, EVENT));
	// the same data spelled another way is page-made text, not what the rewriter wrote
	t.false(realm.isRealmStub(stub.replace('"A"', '"\\u0041"'), EVENT));
	t.false(realm.isRealmStub(stub.replace(",u:null,", ",u:null,x:1,"), EVENT));
	t.false(realm.isRealmStub(stub.replace('s:"A"', 's:"A" '), EVENT));
	t.false(realm.isRealmStub(stub.replace("{const d=", "{var d="), EVENT));
	t.false(realm.isRealmStub(stub.replace(",u:null", ",u:undefined"), EVENT));
	t.false(realm.isRealmStub(stub.replace(",u:null", ",u:1"), EVENT));
	t.false(realm.isRealmStub(stub.replace(',s:"A"', ",s:1"), EVENT));
});

test("every adversarial source and address round trips through the strict reader", (t) => {
	for (const source of ADVERSARIAL) {
		for (const url of [null, "https://a.test/x.js", 'https://a.test/"quoted"?\u2028']) {
			for (const kind of ["classic", "module"]) {
				const stub = realm.createRealmStub({ eventType: EVENT, kind, source, url });
				t.deepEqual(realm.parseRealmStub(stub, EVENT), { kind, source, url });
			}
		}
	}
});
