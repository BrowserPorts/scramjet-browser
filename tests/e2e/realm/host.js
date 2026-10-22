// The host page of the end-to-end run. It plays the part of the embedder: it builds a controller
// in realm mode, listens for the stub event the way the guest-page plugin does, and answers each
// stub by looking up the "@@run:name" scenario the page's script text names, then drives the frame's
// DOM from the host world. Those calls reach the same hooked prototypes a guest's calls would.
const TARGET = window.__target;
const eventType = "evt-" + crypto.randomUUID();

const transport = {
  ready: true,
  init: async () => {},
  connect() { throw new Error("no websockets in this test"); },
  async request(remote, method, body, headers, signal) {
    const init = { method, headers: Object.fromEntries(headers), signal, redirect: "manual" };
    if (body !== null && method !== "GET" && method !== "HEAD") init.body = body;
    const res = await fetch(remote.href, init);
    return { body: await res.arrayBuffer(), headers: [...res.headers], status: res.status, statusText: res.statusText };
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(test, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (test()) return true; await sleep(25); }
  return false;
}

// What the "guest" does once a stub hands it a script that names a scenario. Each one gets the
// frame's window, which is what a guest holds a projection of
const scenarios = {
  // markup
  inline(ctx) { ctx.sink.ran.push("inline"); },
  ext1(ctx) { ctx.sink.ran.push("ext1"); },
  mod1(ctx) { ctx.sink.ran.push("mod1"); },
  h1(ctx) { ctx.sink.ran.push("h1"); },
  clickb({ doc }) { doc.getElementById("b").click(); },
  markupdone(ctx) { ctx.sink.ran.push("markupdone"); },

  // dynamic scripts
  dynscripts({ win, doc }) {
    const head = doc.head;
    const mk = (text) => { const s = doc.createElement("script"); if (text !== undefined) s.text = text; return s; };
    // text set while detached, then inserted
    head.appendChild(mk("@@run:d_text"));
    { const s = doc.createElement("script"); s.textContent = "@@run:d_textContent"; head.append(s); }
    { const s = doc.createElement("script"); s.innerText = "@@run:d_innerText"; head.prepend(s); }
    { const s = doc.createElement("script"); s.appendChild(doc.createTextNode("@@run:d_textnode")); head.insertBefore(s, null); }
    // external, relative src
    { const s = doc.createElement("script"); s.src = "/d_ext.js"; head.appendChild(s); }
    { const s = doc.createElement("script"); s.setAttribute("src", "/d_ext2.js"); head.appendChild(s); }
    // module
    { const s = doc.createElement("script"); s.type = "module"; s.text = "@@run:d_module"; head.appendChild(s); }
    // other insertion calls
    { const host = doc.createElement("div"); doc.body.appendChild(host); const s = mk("@@run:d_adjacent"); host.insertAdjacentElement("beforeend", s); }
    { const host = doc.createElement("div"); doc.body.appendChild(host); host.append(mk("@@run:d_append")); }
    { const host = doc.createElement("div"); doc.body.appendChild(host); host.replaceChildren(mk("@@run:d_replaceChildren")); }
    { const marker = doc.createElement("i"); doc.body.appendChild(marker); marker.after(mk("@@run:d_after")); }
    { const marker = doc.createElement("i"); doc.body.appendChild(marker); marker.replaceWith(mk("@@run:d_replaceWith")); }
    // a fragment of scripts
    { const frag = doc.createDocumentFragment(); frag.append(mk("@@run:d_fragment1"), mk("@@run:d_fragment2")); doc.body.appendChild(frag); }
    // connected empty script that is given its text later
    { const s = doc.createElement("script"); head.appendChild(s); s.text = "@@run:d_late"; }
    // a clone of a script that already ran must not run again, and neither may a moved one
    { const s = mk("@@run:d_once"); head.appendChild(s); const c = s.cloneNode(true); doc.body.appendChild(c); doc.body.appendChild(s); }
    // markup from the range api
    { const r = doc.createRange(); r.selectNode(doc.body); const f = r.createContextualFragment("<script>@@run:d_range</script>"); doc.body.appendChild(f); }
    // innerHTML scripts never run
    { const d = doc.createElement("div"); d.innerHTML = "<script>@@run:d_innerHTML_never</script>"; doc.body.appendChild(d); }
    // a script type that is not javascript is a data block
    { const s = doc.createElement("script"); s.type = "application/json"; s.text = '{"data":1}'; head.appendChild(s); win.__dataBlockText = s.text; }
    // what the page reads back
    const probe = mk("@@run:d_readback");
    win.__readback = { text: probe.text, nonceBefore: probe.nonce };
    head.appendChild(probe);
    win.__readback.nonceAfter = probe.nonce;
    win.__readback.attr = probe.getAttribute("nonce");
  },
  d_text(c) { c.sink.ran.push("d_text"); }, d_textContent(c) { c.sink.ran.push("d_textContent"); },
  d_innerText(c) { c.sink.ran.push("d_innerText"); }, d_textnode(c) { c.sink.ran.push("d_textnode"); },
  d_ext(c) { c.sink.ran.push("d_ext"); }, d_ext2(c) { c.sink.ran.push("d_ext2"); },
  d_module(c) { c.sink.ran.push("d_module"); },
  d_adjacent(c) { c.sink.ran.push("d_adjacent"); }, d_append(c) { c.sink.ran.push("d_append"); },
  d_replaceChildren(c) { c.sink.ran.push("d_replaceChildren"); }, d_after(c) { c.sink.ran.push("d_after"); },
  d_replaceWith(c) { c.sink.ran.push("d_replaceWith"); },
  d_fragment1(c) { c.sink.ran.push("d_fragment1"); }, d_fragment2(c) { c.sink.ran.push("d_fragment2"); },
  d_late(c) { c.sink.ran.push("d_late"); }, d_once(c) { c.sink.ran.push("d_once"); },
  d_range(c) { c.sink.ran.push("d_range"); }, d_innerHTML_never(c) { c.sink.ran.push("d_innerHTML_never"); },
  d_readback(c) { c.sink.ran.push("d_readback"); },

  // handlers made after load
  handlers({ win, doc }) {
    const b = doc.createElement("button"); doc.body.appendChild(b);
    b.setAttribute("onclick", "@@run:hd_set"); b.click();
    win.__getAttr = b.getAttribute("onclick");
    const d = doc.createElement("div"); d.innerHTML = '<img id="i1" src="x:1" onerror="@@run:hd_img"><button id="b2" onclick="@@run:hd_inner">b</button>';
    doc.body.appendChild(d);
    d.querySelector("#b2").click();
    d.insertAdjacentHTML("beforeend", '<button id="b3" onclick="@@run:hd_adjacent">b</button>');
    d.querySelector("#b3").click();
    // a handler called without an event
    win.__direct = typeof b.onclick;
    try { b.onclick(); } catch (e) { win.__directErr = e.name; }
    // removing the attribute removes the handler
    b.removeAttribute("onclick"); b.click();
  },
  hd_set(c) { c.sink.ran.push("hd_set"); }, hd_img(c) { c.sink.ran.push("hd_img"); },
  hd_inner(c) { c.sink.ran.push("hd_inner"); }, hd_adjacent(c) { c.sink.ran.push("hd_adjacent"); },

  // javascript: urls
  jsurls({ win, doc, client }) {
    // what the embedder does when the page assigns a javascript: url to location
    client.url = "javascript:@@run:ju_location";
    const l = doc.getElementById("l1"); l.click();
    const m = doc.createElement("a"); m.href = "javascript:@@run:ju_dyn"; doc.body.appendChild(m); m.click();
    win.__hrefRead = m.href; win.__hrefAttr = m.getAttribute("href");
    const mod = doc.createElement("a"); mod.href = "javascript:@@run:ju_mod"; doc.body.appendChild(mod);
    mod.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    const f = doc.getElementById("f1"); f.requestSubmit();
    const cancelled = doc.createElement("a"); cancelled.href = "javascript:@@run:ju_cancelled"; doc.body.appendChild(cancelled);
    cancelled.addEventListener("click", (e) => e.preventDefault()); cancelled.click();
  },
  ju_1(c) { c.sink.ran.push("ju_1"); }, ju_dyn(c) { c.sink.ran.push("ju_dyn"); }, ju_mod(c) { c.sink.ran.push("ju_mod"); },
  ju_location(c) { c.sink.ran.push("ju_location"); },
  ju_form(c) { c.sink.ran.push("ju_form"); }, ju_cancelled(c) { c.sink.ran.push("ju_cancelled"); },

  // frames the page makes: one that loads a page, one that is written into, one with srcdoc
  frames({ win, doc, sink }) {
    const child = doc.createElement("iframe"); child.src = "/child"; doc.body.appendChild(child);
    const blank = doc.createElement("iframe"); doc.body.appendChild(blank);
    const blankDoc = blank.contentDocument;
    blankDoc.open();
    blankDoc.write('<!doctype html><html><body><script>@@run:blank_inline</script><button id="bb" onclick="@@run:blank_handler">b</button></body></html>');
    blankDoc.close();
    blankDoc.getElementById("bb").click();
    const srcdoc = doc.createElement("iframe");
    srcdoc.srcdoc = '<!doctype html><html><body><script>@@run:srcdoc_inline</script></body></html>';
    doc.body.appendChild(srcdoc);
    // the child document that script created while it was blank
    const later = doc.createElement("iframe"); doc.body.appendChild(later);
    const w = later.contentWindow;
    const s = w.document.createElement("script"); s.text = "@@run:blank_dynamic"; w.document.head.appendChild(s);
    sink.frames = (sink.frames || 0) + 1;
  },
  child_inline(c) { c.sink.ran.push("child_inline"); }, blank_inline(c) { c.sink.ran.push("blank_inline"); },
  blank_handler(c) { c.sink.ran.push("blank_handler"); }, srcdoc_inline(c) { c.sink.ran.push("srcdoc_inline"); },
  blank_dynamic(c) { c.sink.ran.push("blank_dynamic"); },

  // frames whose document is a blob or a data url
  uriframes({ win, doc }) {
    const html = '<!doctype html><html><body><script>@@run:blob_inline</script><button id="ub" onclick="@@run:blob_handler">b</button></body></html>';
    const url = win.URL.createObjectURL(new win.Blob([html], { type: "text/html" }));
    const f = doc.createElement("iframe"); f.src = url; doc.body.appendChild(f);
    const d = doc.createElement("iframe");
    d.src = "data:text/html," + encodeURIComponent('<!doctype html><script>@@run:data_inline</script>');
    doc.body.appendChild(d);
  },
  blob_inline(c) { c.sink.ran.push("blob_inline"); }, blob_handler(c) { c.sink.ran.push("blob_handler"); },
  data_inline(c) { c.sink.ran.push("data_inline"); },

  // a message from a frame to itself carries the page's origin, not the proxy's
  messages({ win, client }) {
    win.__messages = [];
    win.addEventListener("message", (e) => { win.__messages.push({ origin: e.origin, data: e.data, ownSource: e.source === win }); });
    win.postMessage(...client.realm.wrapWindowMessage(["hello", "https://elsewhere.test"]));
    win.postMessage(...client.realm.wrapWindowMessage([{ n: 1 }, { targetOrigin: "https://elsewhere.test" }]));
  },

  // document.open erases listeners
  reopen({ win, doc }) {
    doc.open();
    doc.write('<!doctype html><html><head></head><body><script>@@run:ro_written</script><button id="rb" onclick="@@run:ro_handler">b</button></body></html>');
    doc.close();
    doc.getElementById("rb")?.click();
  },
  ro_written(c) { c.sink.ran.push("ro_written"); }, ro_handler(c) { c.sink.ran.push("ro_handler"); },

  // document.write during parsing
  writer({ doc }) {
    doc.write('<script>@@run:w_one</script>');
    doc.write("<scr"); doc.write("ipt>@@run:w_two</scr"); doc.write("ipt>");
    doc.write('<script src="/w_ext.js"></script>');
  },
  w_one(c) { c.sink.ran.push("w_one"); }, w_two(c) { c.sink.ran.push("w_two"); }, w_ext(c) { c.sink.ran.push("w_ext"); },

  // things that must never run in the frame's own realm
  attacks({ win, doc }) {
    const head = doc.head;
    const tryit = (name, f) => { try { f(); } catch (e) { win.__attackErr = win.__attackErr || {}; win.__attackErr[name] = e.name; } };
    // raw text through every sink the client hooks or leaves alone
    tryit("textNodeData", () => { const s = doc.createElement("script"); const t = doc.createTextNode("x"); s.appendChild(t); t.data = "window.__pwn_textNodeData=1"; head.appendChild(s); });
    tryit("nodeValue", () => { const s = doc.createElement("script"); const t = doc.createTextNode("x"); s.appendChild(t); t.nodeValue = "window.__pwn_nodeValue=1"; head.appendChild(s); });
    tryit("appendData", () => { const s = doc.createElement("script"); const t = doc.createTextNode(""); s.appendChild(t); t.appendData("window.__pwn_appendData=1"); head.appendChild(s); });
    tryit("domparserSvg", () => {
      const p = new win.DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><script>window.__pwn_domparserSvg=1</script></svg>', "image/svg+xml");
      doc.body.appendChild(doc.importNode(p.documentElement, true));
    });
    tryit("domparserHtmlAdopt", () => {
      const p = new win.DOMParser().parseFromString("<script>window.__pwn_domparserHtml=1</script>", "text/html");
      doc.head.appendChild(doc.adoptNode(p.querySelector("script")));
    });
    tryit("template", () => {
      const t = doc.createElement("template"); t.innerHTML = "<script>window.__pwn_template=1</script>";
      doc.body.appendChild(doc.importNode(t.content, true));
    });
    tryit("attrNode", () => {
      const img = doc.createElement("img"); const a = doc.createAttribute("onerror"); a.value = "window.__pwn_attrNode=1";
      img.setAttributeNode(a); img.src = "x:2"; doc.body.appendChild(img);
    });
    tryit("setHTMLUnsafe", () => { const d = doc.createElement("div"); d.setHTMLUnsafe('<img src="x:3" onerror="window.__pwn_setHTMLUnsafe=1">'); doc.body.appendChild(d); });
    tryit("outerHTML", () => { const d = doc.createElement("div"); doc.body.appendChild(d); d.outerHTML = '<img src="x:4" onerror="window.__pwn_outerHTML=1">'; });
    tryit("jsIframe", () => { const f = doc.createElement("iframe"); f.src = "javascript:window.parent.__pwn_jsIframe=1"; doc.body.appendChild(f); });
    tryit("jsIframeCase", () => { const f = doc.createElement("iframe"); f.src = "  JaVaScRiPt:window.parent.__pwn_jsIframeCase=1"; doc.body.appendChild(f); });
    tryit("jsAnchorDirect", () => { const a = doc.createElement("a"); a.href = "java\tscript:window.__pwn_jsAnchorDirect=1"; doc.body.appendChild(a); a.click(); });
    tryit("eval", () => { win.eval("window.__pwn_eval=1"); });
    tryit("Function", () => { new win.Function("window.__pwn_Function=1")(); });
    tryit("timerString", () => { win.setTimeout("window.__pwn_timerString=1", 0); });
    tryit("blobScript", () => {
      const u = win.URL.createObjectURL(new win.Blob(["window.__pwn_blobScript=1"], { type: "text/javascript" }));
      const s = doc.createElement("script"); s.src = u; head.appendChild(s);
    });
    tryit("dataScript", () => { const s = doc.createElement("script"); s.src = "data:text/javascript,window.__pwn_dataScript=1"; head.appendChild(s); });
    tryit("foreignSrc", () => { const s = doc.createElement("script"); s.setAttribute("src", TARGET + "/raw.js"); head.appendChild(s); });
    tryit("nonProxiedSrcProp", () => { const s = doc.createElement("script"); s.src = TARGET + "/raw2.js"; head.appendChild(s); });
    tryit("writeRaw", () => { doc.write("<scr" + "ipt>window.__pwn_writeRaw=1</scr" + "ipt>"); });
    tryit("setNonce", () => { const s = doc.createElement("script"); s.nonce = "guess"; s.setAttribute("nonce", "guess2"); s.text = "window.__pwn_setNonce=1"; head.appendChild(s); });
    tryit("between", () => {
      // two real stubs with raw text between them must not pass for one stub
      const s = doc.createElement("script"); s.text = "@@run:atk_between_a";
      s.appendChild(doc.createTextNode("@@run:atk_between_b"));
      s.firstChild.after(doc.createTextNode("window.__pwn_between=1;"));
      head.appendChild(s);
    });
    tryit("leaks", () => {
      const s = doc.createElement("script"); s.text = "hello"; head.appendChild(s);
      const t = s.firstChild;
      const holder = doc.createElement("div"); holder.append(doc.createElement("script")); holder.firstChild.text = "inside";
      const range = doc.createRange(); range.selectNodeContents(s);
      win.__leaks = {
        substring: t.substringData(0, 400), cloneData: t.cloneNode().data, cloneNodeValue: t.cloneNode().nodeValue,
        divText: holder.textContent, rangeText: range.toString(), wholeText: t.wholeText, own: s.text, own2: s.textContent,
      };
    });
    tryit("swapAfterInsert", () => {
      const s = doc.createElement("script"); s.text = "@@run:atk_swap_stub"; const t = s.firstChild; head.appendChild(s);
      t.data = "window.__pwn_swapAfterInsert=1";
    });
    tryit("reinsertSwap", () => {
      const s = doc.createElement("script"); s.text = "@@run:atk_reinsert_stub"; head.appendChild(s); s.remove();
      s.firstChild.data = "window.__pwn_reinsertSwap=1"; head.appendChild(s);
    });
  },
  atk_between_a(c) { c.sink.ran.push("atk_between_a"); }, atk_between_b(c) { c.sink.ran.push("atk_between_b"); },
  atk_swap_stub(c) { c.sink.ran.push("atk_swap_stub"); }, atk_reinsert_stub(c) { c.sink.ran.push("atk_reinsert_stub"); },
};

function makeEmbedder(sink) {
  const tap = new $scramjet.Plugin("e2e-embedder");
  return {
    name: "e2e-embedder",
    dependencies: [],
    install(frame) {
      tap.tap(frame.hooks.init.post, ({ window: win, client, nonce }) => {
        const doc = win.document;
        sink.nonceSeen = typeof nonce === "string" && nonce.length > 0;
        const listener = (e) => {
          e.preventDefault(); e.stopImmediatePropagation();
          const d = e.detail;
          sink.bridge.push({ k: d.k, s: d.s, u: d.u });
          if (d.k === "module") d.p = Promise.resolve();
          const m = /^@@run:(\w+)/.exec(d.s || "");
          if (m) {
            if (!scenarios[m[1]]) { sink.errors.push("no scenario " + m[1]); return; }
            try { scenarios[m[1]]({ win, doc, d, sink, client }); } catch (err) { sink.errors.push(m[1] + ": " + err.name + ": " + err.message); }
          }
        };
        const violation = (e) => sink.violations.push((e.violatedDirective || "") + "|" + (e.blockedURI || "inline") + "|" + String(e.sample || "").slice(0, 60));
        const install = () => { doc.addEventListener(eventType, listener, true); doc.addEventListener("securitypolicyviolation", violation, true); };
        install();
        client.realm.onReset(install);
        sink.docs++;
      });
    },
  };
}

(async () => {
  const wanted = new URL(location.href).searchParams.get("only");
  const report = { eventType, runs: {}, env: { ua: navigator.userAgent } };
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
    const sw = navigator.serviceWorker.controller || reg.active;
    const controller = new $scramjetController.Controller({
      serviceworker: sw,
      transport,
      storagePartitionKey: "e2e:realm",
      scramjetConfig: {
        ...$scramjet.defaultConfigDev,
        flags: {
          ...$scramjet.defaultConfigDev.flags,
          realmExecution: true, sourcemaps: false, captureErrors: false, cleanErrors: false,
          scramitize: false, debugSourceURL: false, allowInvalidJs: false, rewriterLogs: false, debugTrampolines: false,
        },
        realm: { eventType },
      },
    });
    await controller.wait();

    const pages = await (await fetch(TARGET + "/_pages")).json();
    for (const page of pages) {
      if (wanted && wanted !== page) continue;
      const iframe = document.createElement("iframe");
      iframe.style.cssText = "width:600px;height:300px";
      document.body.append(iframe);
      const sink = { bridge: [], ran: [], violations: [], errors: [], docs: 0, nonceSeen: false };
      const frame = controller.createFrame(iframe, { plugins: [makeEmbedder(sink)] });
      frame.go(TARGET + "/" + page);
      await waitFor(() => sink.docs > 0, 8000);
      await sleep(1500);
      const win = iframe.contentWindow;
      const pwn = [];
      for (const k of Object.getOwnPropertyNames(win)) if (k.startsWith("__pwn")) pwn.push(k);
      const extra = {};
      for (const k of ["__leaks", "__messages", "__readback", "__dataBlockText", "__getAttr", "__direct", "__directErr", "__hrefRead", "__hrefAttr", "__attackErr"]) if (k in win) extra[k] = win[k];
      const globals = Object.getOwnPropertyNames(win).filter((k) => /scramjet|sj\$|e2e/i.test(k));
      report.runs[page] = { bridge: sink.bridge, ran: sink.ran, violations: sink.violations, errors: sink.errors, pwn, extra, globals, docs: sink.docs, nonceSeen: sink.nonceSeen };
    }
    // The same client in its ordinary mode, which has to go on working as it did
    if (!wanted || wanted === "default") {
      const ordinary = new $scramjetController.Controller({
        serviceworker: sw,
        transport,
        storagePartitionKey: "e2e:ordinary",
        scramjetConfig: { ...$scramjet.defaultConfigDev, flags: { ...$scramjet.defaultConfigDev.flags, realmExecution: false } },
      });
      await ordinary.wait();
      report.ordinary = {};
      for (const page of await (await fetch(TARGET + "/_ordinary")).json()) {
        const iframe = document.createElement("iframe");
        iframe.style.cssText = "width:600px;height:300px";
        document.body.append(iframe);
        ordinary.createFrame(iframe, {}).go(TARGET + "/" + page);
        await waitFor(() => iframe.contentWindow && iframe.contentWindow.__done, 10000);
        await sleep(500);
        report.ordinary[page] = JSON.parse(JSON.stringify(iframe.contentWindow.__t || null));
      }
    }
  } catch (e) {
    report.fatal = String(e && e.stack || e);
  }
  await fetch("/result", { method: "POST", body: JSON.stringify(report) });
})();
