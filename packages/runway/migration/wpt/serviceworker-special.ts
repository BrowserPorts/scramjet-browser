/**
 * Runs the non-testharness cases the inventory records in `otherCases`.
 *
 * Only two upstream case forms are actually implemented here:
 *
 * * `crashtest`: load the document, let it clear `test-wait`/`reftest-wait`, and
 *   require that the page neither crashed nor closed.
 * * `reftest` in its simplest official form: exactly one `link[rel=match]`
 *   reference, no `link[rel=mismatch]`, no `meta[name=fuzzy]` tolerance and no
 *   further references inside the reference itself. The rendered PNGs must be
 *   byte-identical.
 *
 * Every other inventoried form — `print-reftest`, fuzzy or multi-reference
 * reftests, mismatch references, reference chains and any case type Runway does
 * not know — is recorded as `notrun` with the reason, and the Runway case fails.
 * A plain page load is never reported as a pass for a comparison Runway did not
 * perform, and no case is silently dropped from the manifest accounting.
 *
 * `manual` cases are not executed and deliberately produce no result record, so
 * the summary keeps counting them as manual-not-executed rather than as a run.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { Test } from "../../testcommon.ts";
import {
  loadRunwayPluginProfile,
  wptResultsDirectory,
} from "../../plugin-profile.ts";
import {
  browserProvenance,
  harnessLabelForUrl,
  resolveRunwayConfig,
} from "../../config.ts";

type SpecialCase = { path: string; type: string };

const config = resolveRunwayConfig();
const manifestPath = config.wpt.manifestPath;
const manifest: {
  revision: string;
  suite?: string;
  otherCases?: SpecialCase[];
} = manifestPath
  ? JSON.parse(await readFile(manifestPath, "utf8"))
  : { revision: "" };

/** Case types this file actually executes. Everything else is recorded not-run. */
const EXECUTED_TYPES = new Set(["crashtest", "reftest"]);

/** References and tolerance metadata, read from a loaded document. */
type ReftestMetadata = {
  match: string[];
  mismatch: string[];
  fuzzy: string[];
};

async function readReftestMetadata(page: Page): Promise<ReftestMetadata> {
  return page.evaluate(() => ({
    match: [...document.querySelectorAll('link[rel~="match"]')].map((link) =>
      link.getAttribute("href") ?? "",
    ),
    mismatch: [...document.querySelectorAll('link[rel~="mismatch"]')].map(
      (link) => link.getAttribute("href") ?? "",
    ),
    fuzzy: [...document.querySelectorAll('meta[name="fuzzy"]')].map(
      (meta) => meta.getAttribute("content") ?? "",
    ),
  }));
}

/** Why a reftest cannot be compared here, or null when it can. */
function unsupportedReftestReason(
  metadata: ReftestMetadata,
): string | null {
  if (metadata.fuzzy.length) {
    return `the reftest declares fuzzy tolerance (${metadata.fuzzy.join("; ")}); Runway implements exact PNG comparison only`;
  }
  if (metadata.mismatch.length) {
    return "the reftest uses link[rel=mismatch]; Runway implements link[rel=match] comparison only";
  }
  if (metadata.match.length === 0) {
    return "the document declares no link[rel=match] reference";
  }
  if (metadata.match.length > 1) {
    return `the reftest declares ${metadata.match.length} references; Runway compares a single reference only`;
  }
  if (!metadata.match[0]) {
    return "the link[rel=match] reference has no href";
  }
  return null;
}

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      !document.documentElement.classList.contains("test-wait") &&
      !document.documentElement.classList.contains("reftest-wait"),
    undefined,
    { timeout: 15000 },
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

export default (manifest.otherCases ?? [])
  // Manual cases are never executed. Leaving them unrecorded keeps the summary's
  // manual accounting truthful instead of implying a run.
  .filter((entry) => entry.type !== "manual")
  .map(
    (entry): Test => ({
      name: `wpt-${manifest.suite ?? "serviceworker"}-special:/${entry.path}`,
      port: config.wpt.httpsPort,
      reloadHarness: true,
      serialHarnesses: true,
      async start() {},
      async stop() {},
      async playwrightFn({ page }) {
        const harness = harnessLabelForUrl(page.url());
        const url = `https://${config.wpt.host}:${config.wpt.httpsPort}/${entry.path}`;
        await page.evaluate(() => {
          Object.assign(window, {
            __runwayCleartextHttps: false,
            __runwayWptTransport: true,
          });
        });
        const proxyUrl = (url: string) =>
          page.evaluate((url) => {
            const proxy = (
              window as typeof window & {
                __runwayGetProxiedUrl?: (url: string) => string;
              }
            ).__runwayGetProxiedUrl;
            return proxy ? proxy(url) : url;
          }, url);
        const directory = path.join(await wptResultsDirectory(), "special");
        await mkdir(directory, { recursive: true });
        const artifact = `${harness}-${encodeURIComponent(entry.path)}`;
        const { profile } = await loadRunwayPluginProfile();
        /** "pass" and "fail" mean Runway ran the case; "notrun" means it did not. */
        let status: "pass" | "fail" | "notrun" = "pass";
        let failure: string | null = null;
        let notRunReason: string | null = null;
        let testPage: Page | null = null;

        if (!EXECUTED_TYPES.has(entry.type)) {
          status = "notrun";
          notRunReason =
            `Runway implements no ${entry.type} execution, so this inventoried case ` +
            `was not run (it is neither loaded nor compared). Supported types: ` +
            `${[...EXECUTED_TYPES].sort().join(", ")}.`;
        } else {
          testPage = await page.context().newPage();
          let crashed = false;
          testPage.on("crash", () => {
            crashed = true;
          });
          try {
            await testPage.goto(await proxyUrl(url), {
              waitUntil: "load",
              timeout: 15000,
            });
            await settle(testPage);
            if (crashed || testPage.isClosed())
              throw new Error("The test page crashed or closed");
            if (entry.type === "reftest") {
              const metadata = await readReftestMetadata(testPage);
              const unsupported = unsupportedReftestReason(metadata);
              if (unsupported) {
                status = "notrun";
                notRunReason =
                  `${unsupported}. The document loaded, but no reference comparison ` +
                  "was performed, so this is not a pass.";
              } else {
                const href = metadata.match[0];
                const actual = await testPage.screenshot({
                  path: path.join(directory, `${artifact}.png`),
                });
                const referencePage = await page.context().newPage();
                try {
                  await referencePage.goto(
                    await proxyUrl(new URL(href, url).href),
                    { waitUntil: "load", timeout: 15000 },
                  );
                  await settle(referencePage);
                  const referenceMetadata =
                    await readReftestMetadata(referencePage);
                  if (
                    referenceMetadata.match.length ||
                    referenceMetadata.mismatch.length
                  ) {
                    status = "notrun";
                    notRunReason =
                      "the reference declares further references (a reftest chain); " +
                      "Runway compares a single reference only, so no comparison was performed";
                  } else {
                    const expected = await referencePage.screenshot({
                      path: path.join(directory, `${artifact}-reference.png`),
                    });
                    if (!actual.equals(expected))
                      throw new Error(
                        "The rendered test and reference PNGs differ",
                      );
                  }
                } finally {
                  await referencePage.close();
                }
              }
            }
          } catch (error) {
            status = "fail";
            failure = String(error);
          }
        }

        await testPage?.close().catch(() => {});
        const pluginVerificationFailures =
          harness === "scramjet"
            ? await page.evaluate(
                (testURL) =>
                  (
                    window as typeof window & {
                      __runwayVerifyPlugins: (context: {
                        testURL: string;
                      }) => Promise<{ module: string; error: string }[]>;
                    }
                  ).__runwayVerifyPlugins({ testURL }),
                url,
              )
            : [];
        const pluginReports =
          harness === "scramjet"
            ? await page.evaluate(() =>
                (
                  window as typeof window & {
                    __runwayPluginReports: () => Promise<unknown>;
                  }
                ).__runwayPluginReports(),
              )
            : [];
        if (pluginVerificationFailures.length && status === "pass") {
          status = "fail";
        }
        if (pluginVerificationFailures.length) {
          failure = [failure, JSON.stringify(pluginVerificationFailures)]
            .filter(Boolean)
            .join("\n");
        }
        await writeFile(
          path.join(directory, `${artifact}.json`),
          JSON.stringify(
            {
              revision: manifest.revision,
              url,
              harness,
              browser: browserProvenance(config, {
                name: page.context().browser()?.browserType().name(),
                version: page.context().browser()?.version(),
              }),
              pluginProfile: { ...profile, applied: harness === "scramjet" },
              pluginReports,
              pluginVerificationFailures,
              // The manifest's own type, recorded verbatim so the inventory and
              // the result can be matched.
              type: entry.type,
              // Additive execution evidence: `executed` false means Runway
              // performed no comparison for this case at all.
              executed: status !== "notrun",
              executedTypes: [...EXECUTED_TYPES].sort(),
              notRunReason,
              status,
              failure,
            },
            null,
            2,
          ),
        );
        if (status === "notrun") throw new Error(`not run: ${notRunReason}`);
        if (failure) throw new Error(failure);
      },
    }),
  );
