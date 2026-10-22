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
  reopen: page("reopen", `<script>@@run:reopen</script>`),
  writer: page("writer", `<script>@@run:writer</script>`),
  attacks: page("attacks", `<script>@@run:attacks</script>`),
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
    `<img src="x:1" onerror="window.__pwn_imgHandler=1">` +
    `<script src="data:text/javascript,window.__pwn_dataSrc=1"></script>` +
    `<script src="//127.0.0.1:8795/raw.js"></script>` +
    `<script>@@run:markupdone</script>`),
};

const RAW: Record<string, string> = {
  "/ext1.js": "@@run:ext1",
  "/d_ext.js": "@@run:d_ext",
  "/d_ext2.js": "@@run:d_ext2",
  "/w_ext.js": "@@run:w_ext",
  "/raw.js": "window.__pwn_foreign=1",
  "/raw2.js": "window.__pwn_foreign2=1",
};

const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };

let resolveResult: (r: any) => void;
const result = new Promise<any>((r) => (resolveResult = r));

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
	if (u.pathname === "/_pages") return { headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(Object.keys(PAGES)) };
	if (PAGES[name]) return { headers: { ...CORS, "content-type": "text/html; charset=utf-8", "content-security-policy": "script-src 'self'" }, body: PAGES[name] };
	if (RAW[u.pathname]) return { headers: { ...CORS, "content-type": "text/javascript" }, body: RAW[u.pathname] };
	return { status: 404, headers: CORS, body: "not found" };
});

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sj-e2e-"));
const chrome = spawn(
	CHROME,
	["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--disable-features=Translate", `http://127.0.0.1:${HOST}/${ONLY ? `?only=${ONLY}` : ""}`],
	{ stdio: "ignore" },
);

const timeout = new Promise<any>((r) => setTimeout(() => r({ fatal: "timed out waiting for the host page" }), 150000));
const report: any = await Promise.race([result, timeout]);
chrome.kill();
hostServer.close();
targetServer.close();
try {
	fs.rmSync(profile, { recursive: true, force: true });
} catch {
	// a profile that is still in use is the temp directory's to clean up
}

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
  check("handlers: getAttribute returns what was set", r.extra.__getAttr === "@@run:hd_set", r.extra.__getAttr);
}
if (runs.jsurls) {
  const r = runs.jsurls;
  check("jsurls: static link", count(r, "ju_1") === 1, count(r, "ju_1"));
  check("jsurls: dynamic link", count(r, "ju_dyn") === 1, count(r, "ju_dyn"));
  check("jsurls: form action", count(r, "ju_form") === 1, count(r, "ju_form"));
  check("jsurls: modified click does not run it", count(r, "ju_mod") === 0);
  check("jsurls: a cancelled click does not run it", count(r, "ju_cancelled") === 0);
  check("jsurls: href reads back as written", r.extra.__hrefRead === "javascript:@@run:ju_dyn" && r.extra.__hrefAttr === "javascript:@@run:ju_dyn", [r.extra.__hrefRead, r.extra.__hrefAttr]);
}
if (runs.reopen) check("reopen: scripts and handlers still reach the realm after document.open", count(runs.reopen, "ro_written") === 1 && count(runs.reopen, "ro_handler") === 1, runs.reopen.ran);
if (runs.writer) check("writer: document.write scripts reach the realm", count(runs.writer, "w_one") === 1 && count(runs.writer, "w_two") === 1 && count(runs.writer, "w_ext") === 1, runs.writer.ran);
if (runs.attacks) {
  const r = runs.attacks;
  check("attacks: a stub that ran before its text was swapped ran as the stub", count(r, "atk_swap_stub") === 1 && count(r, "atk_reinsert_stub") === 1, r.ran);
  console.log("attack errors:", JSON.stringify(r.extra.__attackErr));
  console.log("attack violations:", r.violations.length);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
