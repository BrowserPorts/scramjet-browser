import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { listen, pageTest } from "../testkit.ts";

let server: http.Server;
let documentLoads = 0;
async function startDestination() {
  documentLoads = 0;
  server = http.createServer((request, response) => {
    if (request.url === "/data") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ nested: true }));
    } else if (request.url === "/worker.js") {
      response.setHeader("Content-Type", "application/javascript");
      response.end('onmessage = () => postMessage("worker-ok")');
    } else {
      response.setHeader("Content-Type", "text/html");
      response.setHeader("Cache-Control", "no-store");
      response.end(`<!doctype html><title>Nested destination</title><h1 id="result" data-load="${++documentLoads}">Loading</h1>
<script>
(async () => {
 const data = await (await fetch('/data')).json();
 const worker = new Worker('/worker.js');
 const reply = new Promise(resolve => worker.onmessage = event => resolve(event.data));
 worker.postMessage('ping');
 if (!data.nested || await reply !== 'worker-ok') throw new Error('Nested request failed');
 document.getElementById('result').textContent = 'nested-ok';
 worker.terminate();
})().catch(error => document.getElementById('result').textContent = error.stack);
</script>`);
    }
  });
  return listen(server);
}

const test = pageTest({
  name: "nested-scramjet-end-to-end",
  deadlineMs: 120_000,
  async fn({
    page,
    navigate,
    harnessOrigin,
    artifactDirectory,
    browser,
    pluginProfileName,
  }) {
    const destinationPort = await startDestination();
    const errors: string[] = [];
    const stages: string[] = [];
    let failure: string | null = null;
    page.on("pageerror", (error) => errors.push(error.message));
    const nested = page.frameLocator("#testframe");
    try {
      // The harness proxies itself, so the nested target is whichever port the
      // harness actually bound in this run.
      await navigate(`${harnessOrigin}/?nested-scramjet`);
      stages.push("outer-navigation");
      await nested
        .locator("#status")
        .filter({ hasText: "Ready - waiting for test" })
        .waitFor({ timeout: 20000 });
      stages.push("inner-harness-ready");
      await nested.locator("body").evaluate((_body, url) => {
        (
          window as typeof window & {
            __runwayNavigate: (url: string) => unknown;
          }
        ).__runwayNavigate(url);
      }, `http://localhost:${destinationPort}/`);
      await nested
        .frameLocator("#testframe")
        .locator("#result")
        .filter({ hasText: "nested-ok" })
        .waitFor({ timeout: 20000 });
      stages.push("inner-navigation-fetch-worker-message");
      const firstLoad = await nested
        .frameLocator("#testframe")
        .locator("#result")
        .getAttribute("data-load");
      await nested.locator("body").evaluate(() => {
        (
          window as typeof window & { __runwayReload: () => unknown }
        ).__runwayReload();
      });
      await nested
        .frameLocator("#testframe")
        .locator(`#result:not([data-load="${firstLoad}"])`)
        .filter({ hasText: "nested-ok" })
        .waitFor({ timeout: 20000 });
      stages.push("inner-reload-fetch-worker-message");
    } catch (error) {
      failure = `${String(error)}\nInner harness: ${await nested
        .locator("#status")
        .textContent({ timeout: 1000 })
        .catch(() => "unavailable")}\n${errors.join("\n")}`;
      throw new Error(failure);
    } finally {
      try {
        // The run reserves this directory for the attempt; the test does not
        // decide where run output lives.
        const directory = artifactDirectory;
        await mkdir(directory, { recursive: true });
        const pluginReports = await page.evaluate(() =>
          (
            window as typeof window & {
              __runwayPluginReports: () => Promise<unknown>;
            }
          ).__runwayPluginReports(),
        );
        await writeFile(
          path.join(directory, "result.json"),
          JSON.stringify(
            {
              test: "nested-scramjet-end-to-end",
              status: failure ? "fail" : "pass",
              failure,
              stages,
              errors,
              pluginProfile: pluginProfileName,
              pluginReports,
              browser,
            },
            null,
            2,
          ),
        );
        await page.screenshot({
          path: path.join(directory, "screenshot.png"),
          fullPage: true,
        });
      } finally {
        server.closeAllConnections();
        await new Promise<undefined>((resolve) =>
          server.close(() => resolve(undefined)),
        );
      }
    }
  },
});
export default test;
