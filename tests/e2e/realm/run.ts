// End-to-end run of realm mode against the real built client, controller and service worker, in
// headless Chrome. It needs the packages built (`pnpm --filter @mercuryworkshop/scramjet-controller build`
// builds the bundles this serves) and Chrome. Usage: node tests/e2e/realm/run.ts [only]
//
// The host page plays the embedder. It builds a controller in realm mode, listens for the stub event
// the way the guest-page plugin does, and answers each stub by running the scenario its script text
// names, driving the frame's DOM from the host world. Those calls reach the same hooked prototypes a
// guest's calls would. Pages that must never run anything natively set `window.__pwn*`, which the run
// reads from the frame afterwards.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SJ = path.resolve(here, "../../..");
const ONLY = process.argv[2];
const CHROME =
	process.env.CHROME_PATH ??
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HOST = Number(process.env.E2E_HOST_PORT ?? 8794);
const TARGET = Number(process.env.E2E_TARGET_PORT ?? 8795);

const HOST_PAGE = `<!doctype html><html><head><meta charset=utf-8><title>host</title>
<script>window.__target = "http://127.0.0.1:${TARGET}";</script>
<script src="/scramjet/scramjet.js"></script><script src="/controller/controller.api.js"></script></head>
<body><script type="module" src="/host.js"></script></body></html>`;

const SW = `importScripts("/controller/controller.sw.js");
addEventListener("fetch", (e) => { if ($scramjetController.shouldRoute(e)) e.respondWith($scramjetController.route(e)); });`;

const page = (title: string, body: string, head = "") => `<!doctype html><html><head><meta charset=utf-8><title>${title}</title>${head}</head><body>${body}</body></html>`;

const PAGES: Record<string, string> = {
  static: page("static",
    `<button id="b" onclick="@@run:h1">b</button><script>@@run:clickb</script>`,
    `<script>@@run:inline</script><script src="/ext1.js"></script><script type="module">@@run:mod1</script><script type="importmap">{"imports":{"x":"/x.js"}}</script>`),
  dynscripts: page("dyn", `<script>@@run:dynscripts</script>`),
  handlers: page("handlers", `<script>@@run:handlers</script>`),
  jsurls: page("jsurls", `<a id="l1" href="javascript:@@run:ju_1">x</a><form id="f1" action="javascript:@@run:ju_form"><input type="submit"></form><script>@@run:jsurls</script>`),
  messages: page("messages", `<script>@@run:messages</script>`),
  frames: page("frames", `<script>@@run:frames</script>`),
  uriframes: page("uriframes", `<script>@@run:uriframes</script>`),
  child: page("child", `<script>@@run:child_inline</script>`),
  reopen: page("reopen", `<script>@@run:reopen</script>`),
  writer: page("writer", `<script>@@run:writer</script>`),
  attacks: page("attacks", `<script>@@run:attacks</script>`),
  modflip: page("modflip", `<script>@@run:modflip</script>`),
  batch: page("batch", `<script>@@run:batch</script>`),
  navframe: page("navframe", `<script>@@run:navframe</script>`),
  navA: page("navA", `<script>@@run:nav_a</script>`),
  navB: page("navB", `<script>@@run:nav_b</script>`),
  navC: page("navC", `<script>@@run:nav_c</script>`),
  childwin: page("childwin", `<script>@@run:childwin</script>`),
  shadow: page("shadow", `<script>@@run:shadow</script>`),
  tpl: page("tpl", `<template id="t"><script>@@run:tplinner</script></template><script>@@run:tpl</script>`),
  reports: page("reports", `<script>@@run:reports</script>`),
  markup: page("markup",
    `<noscript><p title="</noscript><img src=x:1 onerror=window.__pwn_noscript=1>"></noscript>` +
    `<noscript><a title="</noscript><script>window.__pwn_noscript2=1</script>">x</a></noscript>` +
    `<script type=" text/javascript">window.__pwn_oddSpace=1</script>` +
    `<script type="\u000btext/javascript">window.__pwn_oddVT=1</script>` +
    `<script type="\u000ctext/javascript">window.__pwn_oddFF=1</script>` +
    `<script type="TEXT/JAVASCRIPT">window.__pwn_oddCase=1</script>` +
    `<script type="module  ">window.__pwn_oddModule=1</script>` +
    `<iframe src="JavaScript:parent.__pwn_jsCase=1"></iframe>` +
    `<iframe src="java&#9;script:parent.__pwn_jsTab=1"></iframe>` +
    `<a id="m1" href=" javascript:window.__pwn_jsSpace=1">l</a>` +
    `<svg><script href="/raw.js"></script></svg><svg><script xlink:href="/raw.js"></script></svg>` +
    `<svg><script>window.__pwn_svgInline=1</script></svg>` +
    `<svg><script><!--c-->window.__pwn_svgCommentFirst=1</script></svg>` +
    `<svg><script><!--c-->@@run:svg_comment</script></svg>` +
    `<svg><script><![CDATA[window.__pwn_svgCdata=1]]></script></svg>` +
    `<svg><script><!--c--></script></svg>` +
    `<div id="svgholder"><svg><script>@@run:svg_split;window.__pwn_svgSplitA=1<!--c-->window.__pwn_svgSplitB=1</script></svg></div>` +
    `<div id="holder"><script id="na">@@run:nonascii /* \u00e9\u2603\u{1f600} */</script></div>` +
    `<img src="x:1" onerror="window.__pwn_imgHandler=1">` +
    `<script src="data:text/javascript,window.__pwn_dataSrc=1"></script>` +
    `<script src="//127.0.0.1:${TARGET}/raw.js"></script>` +
    `<script>@@run:markupdone</script>`),
};

// Pages for the ordinary mode, where the page's own code runs in the frame after the rewriter
const ORDINARY: Record<string, string> = {
  ordinary: page("ordinary", `<button id="b" onclick="window.__t.handler=(window.__t.handler||0)+1">b</button><script>
window.__t = {}; window.__t.inline = 1;
document.getElementById("b").click();
var s = document.createElement("script"); s.text = "window.__t.dynText = 1"; document.head.appendChild(s);
window.__t.textRead = s.text;
var s2 = document.createElement("script"); s2.textContent = "window.__t.dynTC = 1"; document.head.appendChild(s2);
var s3 = document.createElement("script"); s3.appendChild(document.createTextNode("window.__t.dynNode = 1")); document.head.appendChild(s3);
var s4 = document.createElement("script"); s4.src = "/ord1.js"; document.head.appendChild(s4);
var t = document.createTextNode("x"); var s5 = document.createElement("script"); s5.appendChild(t); t.data = "window.__t.dynData = 1"; document.head.appendChild(s5);
window.__t.dataRead = t.data;
window.__t.loc = location.href; window.__t.origin = location.origin;
window.__t.topSame = (top === window);
var a = document.createElement("a"); a.href = "JavaScript:window.__t.jsu=1"; document.body.appendChild(a); a.click();
window.__t.hrefBack = a.getAttribute("href");
setTimeout("window.__t.timerStr = 1", 0);
eval("window.__t.evalDirect = 1");
new Function("window.__t.fn = 1")();
var st = document.createElement("script"); st.type = "\u000btext/javascript"; st.text = "window.__t.vtType = 1"; document.head.appendChild(st);
var sj = document.createElement("script"); sj.type = "application/json"; sj.text = '{"a":1}'; document.head.appendChild(sj); window.__t.json = sj.text;
setTimeout(function () { window.__done = 1; }, 800);
</script>`),
};

const RAW: Record<string, string> = {
  "/ord1.js": "window.__t.dynSrc = 1",
  "/ext1.js": "@@run:ext1",
  "/d_ext.js": "@@run:d_ext",
  "/d_ext2.js": "@@run:d_ext2",
  "/w_ext.js": "@@run:w_ext",
  "/raw.js": "window.__pwn_foreign=1",
  "/raw2.js": "window.__pwn_foreign2=1",
};

const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };

// Each batch of pages runs in a host page of its own. A host page that has made about twenty frames
// stops answering, whatever the frames hold, so a run of more pages than that goes in batches
let resolveResult: (r: any) => void = () => {};
let result = new Promise<any>((r) => (resolveResult = r));
const BATCH = 10;

type Handler = (url: URL, method: string, body: string) => { status?: number; headers?: Record<string, string>; body: string | Buffer };

function serve(port: number, handler: Handler): http.Server {
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
			const answer = handler(url, req.method ?? "GET", Buffer.concat(chunks).toString("utf8"));
			res.writeHead(answer.status ?? 200, answer.headers ?? {});
			res.end(answer.body);
		});
	});
	server.listen(port, "127.0.0.1");
	return server;
}

const file = (name: string, type: string, extra: Record<string, string> = {}) => ({
	headers: { "content-type": type, ...extra },
	body: fs.readFileSync(name),
});

const hostServer = serve(HOST, (u, method, body) => {
	if (u.pathname === "/") return { headers: { "content-type": "text/html" }, body: HOST_PAGE };
	if (u.pathname === "/host.js") return file(path.join(here, "host.js"), "text/javascript");
	if (u.pathname === "/sw.js") return { headers: { "content-type": "text/javascript", "service-worker-allowed": "/" }, body: SW };
	if (u.pathname.startsWith("/scramjet/")) {
		const f = path.join(SJ, "packages/core/dist", u.pathname.slice("/scramjet/".length));
		return file(f, f.endsWith(".wasm") ? "application/wasm" : "text/javascript");
	}
	if (u.pathname.startsWith("/controller/")) return file(path.join(SJ, "packages/controller/dist", u.pathname.slice("/controller/".length)), "text/javascript");
	if (u.pathname === "/result" && method === "POST") {
		resolveResult(JSON.parse(body));
		return { body: "ok" };
	}
	return { status: 404, body: "no" };
});

const targetServer = serve(TARGET, (u, method) => {
	const name = u.pathname.slice(1);
	if (method === "OPTIONS") return { headers: { ...CORS, "access-control-allow-headers": "*", "access-control-allow-methods": "*" }, body: "" };
	if (u.pathname === "/_ordinary") return { headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(Object.keys(ORDINARY)) };
	if (ORDINARY[name]) return { headers: { ...CORS, "content-type": "text/html; charset=utf-8" }, body: ORDINARY[name] };
	if (u.pathname === "/_pages") return { headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(Object.keys(PAGES)) };
	if (PAGES[name]) return { headers: { ...CORS, "content-type": "text/html; charset=utf-8", "content-security-policy": "script-src 'self'" }, body: PAGES[name] };
	if (u.pathname === "/evil.js") return { headers: { ...CORS, "content-type": "text/plain" }, body: "window.__pwn_modflip=1" };
	if (RAW[u.pathname]) return { headers: { ...CORS, "content-type": "text/javascript" }, body: RAW[u.pathname] };
	return { status: 404, headers: CORS, body: "not found" };
});

async function runBatch(only: string | undefined): Promise<any> {
	result = new Promise<any>((r) => (resolveResult = r));
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sj-e2e-"));
	const chrome = spawn(
		CHROME,
		["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--disable-features=Translate", `http://127.0.0.1:${HOST}/${only ? `?only=${only}` : ""}`],
		{ stdio: "ignore" },
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<any>((r) => (timer = setTimeout(() => r({ fatal: "timed out waiting for the host page" }), Number(process.env.E2E_TIMEOUT ?? 300000))));
	const batchReport: any = await Promise.race([result, timeout]);
	clearTimeout(timer);
	chrome.kill();
	try {
		fs.rmSync(profile, { recursive: true, force: true });
	} catch {
		// a profile that is still in use is the temp directory's to clean up
	}
	return batchReport;
}

const names = Object.keys(PAGES);
const batches: (string | undefined)[] = ONLY ? [ONLY] : [...Array.from({ length: Math.ceil(names.length / BATCH) }, (_, i) => names.slice(i * BATCH, (i + 1) * BATCH).join(",")), "default"];
const report: any = { runs: {} };
for (const only of batches) {
	const part = await runBatch(only);
	if (part.fatal) {
		report.fatal = part.fatal;
		break;
	}
	Object.assign(report.runs, part.runs);
	if (part.ordinary) report.ordinary = part.ordinary;
	report.env = part.env;
}
hostServer.close();
targetServer.close();

if (process.env.E2E_DUMP) console.log(JSON.stringify(report, null, 1));

// ---- assertions
let failed = 0, passed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => { if (ok) passed++; else { failed++; console.log("FAIL", name, detail === undefined ? "" : JSON.stringify(detail)); } };
if (report.fatal) { console.log("FATAL", report.fatal); process.exit(2); }
const runs = report.runs;
const has = (r: any, src: string, kind?: string) => r.bridge.some((b: any) => b.s === src && (!kind || b.k === kind));
const count = (r: any, name: string) => r.ran.filter((x: string) => x === name).length;
console.log("pages:", Object.keys(runs).join(", "));

for (const [name, r] of Object.entries<any>(runs)) {
  check(`${name}: no native execution`, r.pwn.length === 0, r.pwn);
  check(`${name}: no host-side errors`, r.errors.length === 0, r.errors);
  check(`${name}: the embedder saw the nonce`, r.nonceSeen === true);
  check(`${name}: no scramjet or e2e global on the frame`, r.globals.length === 0, r.globals);
}
if (runs.static) {
  const r = runs.static;
  check("static: inline classic", has(r, "@@run:inline", "classic"));
  check("static: external classic", has(r, "@@run:ext1", "classic"));
  check("static: module", has(r, "@@run:mod1", "module"));
  check("static: handler resolved from the attribute", has(r, "@@run:h1", "handler"));
  check("static: no violations", r.violations.length === 0, r.violations);
}
if (runs.modflip) {
  const r = runs.modflip;
  // The body the browser loaded is a stub whatever the element became. It is a module stub, which a
  // classic load refuses to compile, so the page's text does not run in either realm
  check("modflip: the page's text did not run natively", !r.pwn.includes("__pwn_modflip"), r.pwn);
}
if (runs.batch) {
  const r = runs.batch;
  check("batch: nothing the first script changed in its sibling ran natively", r.pwn.length === 0, r.pwn);
  check("batch: an untouched batch runs both scripts in the realm", count(r, "b_plain_a") === 1 && count(r, "b_plain_b") === 1, r.ran);
  for (const n of ["textContent", "data", "nodeValue", "replaceWith", "appendData", "insertAdjacentText", "insertAdjacentHTML", "setHTMLUnsafe", "range", "append"]) check(`batch: the first script of the ${n} batch ran in the realm`, count(r, "b_first_" + n) === 1, [n, count(r, "b_first_" + n), r.extra.__batchErr]);
}
if (runs.tpl) {
  const r = runs.tpl;
  const raw = r.extra.__tplRaw;
  check("tpl: a script in a template holds no nonce the page could read", raw && raw.nonce === null && raw.has === false, raw);
  check("tpl: nothing the page did with the template's script ran natively", r.pwn.length === 0, r.pwn);
  check("tpl: a script imported from the template, untouched, runs in the realm", count(r, "tplinner") >= 1, count(r, "tplinner"));
}
if (runs.shadow) {
  const r = runs.shadow;
  check("shadow: a handler in markup set on a shadow root reaches the realm", count(r, "sh_inner") === 1 && count(r, "sh_unsafe") === 1, [count(r, "sh_inner"), count(r, "sh_unsafe"), r.violations]);
  const m = r.extra.__shadowRead;
  check("shadow: shadow markup reads back as the page wrote it", m && m.inner.includes('onerror="@@run:sh_inner"') && m.html.includes('onerror="@@run:sh_unsafe"') && !/scramjet|var d=/i.test(m.inner + m.html), m);
}
if (runs.navframe) {
  const r = runs.navframe;
  for (const n of ["nav_a", "nav_b", "nav_c"]) check(`navframe: ${n}, in a frame that had a window before its document, reached the realm`, count(r, n) === 1, [n, count(r, n), r.frameErrors]);
}
if (runs.childwin) {
  const r = runs.childwin;
  const c = r.extra.__childwin;
  for (const way of ["appendChild", "innerHTML", "insertAdjacentHTML", "fragment", "document.write", "shadow"]) {
    check(`childwin: a frame made by ${way} is hooked before the page can reach its window`, c && c[way] && c[way].defaultPolicy === "refused", c && c[way]);
    check(`childwin: a refused eval, Function or timer in a frame made by ${way} does not name the nonce`, c && c[way] && c[way].leak === false, c && c[way]);
  }
}
if (runs.reports) {
  const r = runs.reports;
  check("reports: a refused eval, Function or string timer does not name the nonce", r.extra.__refusals && r.extra.__refusals.count > 0 && r.extra.__refusals.leaksNonce === false, r.extra.__refusals);
  const rep = r.extra.__reports;
  check("reports: the page was told of no violation and no policy", rep && rep.seen.length === 0 && rep.reports.length === 0, rep);
  check("reports: the embedder was told of the violations", r.violations.length > 0, r.violations);
  const f = r.extra.__forged;
  check("reports: a nonce made through an attribute node is not an attribute the browser reads", f && f.rawScript === null && f.rawDiv === null && f.rawNs === null, f);
  check("reports: the page reads no nonce it did not give", f && f.pageScript === "FORGED" && f.pageDiv === "FORGED2" && f.pageNs === "FORGED3" && f.prop === "FORGED", f);
}
if (runs.markup) {
  const r = runs.markup;
  check("markup: an svg script that starts with a comment reaches the realm", count(r, "svg_comment") === 1, count(r, "svg_comment"));
  check("markup: an svg script split by a comment reaches the realm once", count(r, "svg_split") === 1, count(r, "svg_split"));
  const m = r.extra.__markupRead;
  check("markup: a script with non-ASCII text reads back as the page wrote it", m && m.text === "@@run:nonascii /* \u00e9\u2603\u{1f600} */", m && m.text);
  check("markup: the page's source and the nonce are not in a script's attributes", m && m.names.every((n: string) => n === "id") && m.attrs.every((n: string) => n === "id"), m && [m.names, m.attrs]);
  check("markup: markup read back carries no internal attribute or nonce", m && !/scramjet|nonce/i.test(m.outer + m.holderHtml + m.svgHtml), m && [m.outer, m.holderHtml, m.svgHtml]);
  check("markup: the nonce accessors answer for the native ones", m && m.nonceGetter === "get nonce|function get nonce() { [native code] }" && m.nonceSetter === "set nonce|1", m && [m.nonceGetter, m.nonceSetter]);
  check("markup: markup read back keeps the page's script text", m && m.holderHtml.includes("@@run:nonascii") && m.svgHtml.includes("window.__pwn_svgSplitB=1") && m.svgHtml.includes("<!--c-->"), m && [m.holderHtml, m.svgHtml]);
}
if (runs.dynscripts) {
  const r = runs.dynscripts;
  for (const n of ["d_text","d_textContent","d_innerText","d_textnode","d_ext","d_ext2","d_module","d_adjacent","d_append","d_replaceChildren","d_after","d_replaceWith","d_fragment1","d_fragment2","d_late","d_range","d_readback"]) check(`dynscripts: ${n} ran in the realm`, count(r, n) === 1, count(r, n));
  check("dynscripts: a clone and a move do not run a script again", count(r, "d_once") === 1, count(r, "d_once"));
  check("dynscripts: innerHTML scripts never run", count(r, "d_innerHTML_never") === 0);
  check("dynscripts: a data block keeps its text", r.extra.__dataBlockText === '{"data":1}', r.extra.__dataBlockText);
  const rb = r.extra.__readback;
  check("dynscripts: the page never reads the document nonce", rb && rb.nonceBefore === "" && rb.nonceAfter === "" && rb.attr === null, rb);
}
if (runs.handlers) {
  const r = runs.handlers;
  check("handlers: setAttribute handler ran for the click and the direct call", count(r, "hd_set") === 2, count(r, "hd_set"));
  check("handlers: innerHTML img onerror", count(r, "hd_img") === 1, count(r, "hd_img"));
  check("handlers: innerHTML button", count(r, "hd_inner") === 1, count(r, "hd_inner"));
  check("handlers: insertAdjacentHTML button", count(r, "hd_adjacent") === 1, count(r, "hd_adjacent"));
  check("handlers: an attribute node's handler runs in the realm and reads back as written", count(r, "hd_attrnode") === 1 && r.extra.__attrNodeRead === "@@run:hd_attrnode", [count(r, "hd_attrnode"), r.extra.__attrNodeRead]);
  check("handlers: getAttribute returns what was set", r.extra.__getAttr === "@@run:hd_set", r.extra.__getAttr);
}
if (runs.jsurls) {
  const r = runs.jsurls;
  check("jsurls: static link", count(r, "ju_1") === 1, count(r, "ju_1"));
  check("jsurls: dynamic link", count(r, "ju_dyn") === 1, count(r, "ju_dyn"));
  check("jsurls: form action", count(r, "ju_form") === 1, count(r, "ju_form"));
  check("jsurls: a javascript: url given to location runs in the realm", count(r, "ju_location") === 1, count(r, "ju_location"));
  check("jsurls: modified click does not run it", count(r, "ju_mod") === 0);
  check("jsurls: a cancelled click does not run it", count(r, "ju_cancelled") === 0);
  check("jsurls: href reads back as written", r.extra.__hrefRead === "javascript:@@run:ju_dyn" && r.extra.__hrefAttr === "javascript:@@run:ju_dyn", [r.extra.__hrefRead, r.extra.__hrefAttr]);
}
if (report.ordinary) {
  const o = report.ordinary.ordinary ?? {};
  for (const k of ["inline", "handler", "dynText", "dynTC", "dynNode", "dynSrc", "dynData", "jsu", "timerStr", "evalDirect", "fn", "vtType"]) check(`ordinary: ${k} ran`, o[k] === 1, o);
  check("ordinary: the page reads back what it wrote", o.textRead === "window.__t.dynText = 1" && o.dataRead === "window.__t.dynData = 1" && o.json === '{"a":1}', o);
  check("ordinary: location is the page's own address", o.loc === `http://127.0.0.1:${TARGET}/ordinary` && o.origin === `http://127.0.0.1:${TARGET}`, [o.loc, o.origin]);
  check("ordinary: top is the page's own window", o.topSame === true, o.topSame);
  check("ordinary: a javascript: link keeps the href the page gave", o.hrefBack === "JavaScript:window.__t.jsu=1", o.hrefBack);
}
if (runs.frames) {
  const r = runs.frames;
  for (const n of ["child_inline", "blank_inline", "blank_handler", "srcdoc_inline", "blank_dynamic"]) check(`frames: ${n} reached the realm`, count(r, n) === 1, [n, count(r, n), r.ran]);
}
if (runs.uriframes) {
  const r = runs.uriframes;
  for (const n of ["blob_inline", "data_inline"]) check(`uriframes: ${n} reached the realm`, count(r, n) === 1, [n, count(r, n), r.ran]);
}
if (runs.messages) {
  const m = runs.messages.extra.__messages;
  check("messages: the page's origin and data arrive unwrapped", Array.isArray(m) && m.length === 2 && m[0].origin === `http://127.0.0.1:${TARGET}` && m[0].data === "hello" && m[1].data.n === 1, m);
  check("messages: a message posted from the frame names the frame as its source", Array.isArray(m) && m[0]?.ownSource === true, m);
}
if (runs.reopen) check("reopen: scripts and handlers still reach the realm after document.open", count(runs.reopen, "ro_written") === 1 && count(runs.reopen, "ro_handler") === 1, runs.reopen.ran);
if (runs.writer) check("writer: document.write scripts reach the realm", count(runs.writer, "w_one") === 1 && count(runs.writer, "w_two") === 1 && count(runs.writer, "w_ext") === 1, runs.writer.ran);
if (runs.attacks) {
  const r = runs.attacks;
  check("attacks: raw text between two real stubs does not run natively or as one stub", count(r, "atk_between_a") === 0 && count(r, "atk_between_b") === 0, r.ran);
  const leaks = r.extra.__leaks;
  check("attacks: no text the page reads shows the event type", leaks && !JSON.stringify(leaks).includes(report.eventType) && !JSON.stringify(leaks).includes("CustomEvent"), leaks);
  check("attacks: the page reads its own source back through every text api", leaks && leaks.own === "hello" && leaks.own2 === "hello" && leaks.substring === "hello" && leaks.cloneData === "hello" && leaks.divText === "inside" && leaks.rangeText === "hello", leaks);
  check("attacks: a stub that ran before its text was swapped ran as the stub", count(r, "atk_swap_stub") === 1 && count(r, "atk_reinsert_stub") === 1, r.ran);
  console.log("attack errors:", JSON.stringify(r.extra.__attackErr));
  console.log("attack violations:", r.violations.length);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
