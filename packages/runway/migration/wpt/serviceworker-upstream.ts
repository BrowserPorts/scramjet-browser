import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Test } from "../../testcommon.ts";
import {
  loadRunwayPluginProfile,
  wptResultsDirectory,
} from "../../plugin-profile.ts";
import {
  browserProvenance,
  harnessLabelForUrl,
  resolveRunwayConfig,
  wptDocumentUrl,
} from "../../config.ts";

type WptCase = { url: string; timeout: string | null; testdriver: boolean };
type WptResult = {
  status: { status: number; message: string | null };
  tests: { name: string; status: number; message: string | null }[];
};

const config = resolveRunwayConfig();
const manifestPath = config.wpt.manifestPath;
const manifest: { revision: string; suite?: string; tests: WptCase[] } =
  manifestPath
    ? JSON.parse(await readFile(manifestPath, "utf8"))
    : { revision: "", tests: [] };

// These cases use upstream testharness.js, its completion protocol, and wptserve.
// No assertions, fixture responses, cleanup hooks, or expected results are replaced.
export default manifest.tests.map(
  (entry): Test => ({
    name: `wpt-${manifest.suite ?? "serviceworker"}-upstream:${entry.url}`,
    port: config.wpt.httpsPort,
    reloadHarness: true,
    serialHarnesses: true,
    async start() {},
    async stop() {},
    async playwrightFn({ page }) {
      const harness = harnessLabelForUrl(page.url());
      await page.evaluate(() => {
        Object.assign(window, {
          __runwayCleartextHttps: false,
          __runwayWptTransport: true,
        });
      });
      await page
        .context()
        .exposeBinding("__runwayWptClick", async ({ frame }, id: number) => {
          const handle = await frame.evaluateHandle(
            (id) =>
              (
                window as typeof window & {
                  __runwayWptClickTargets: Map<number, Element>;
                }
              ).__runwayWptClickTargets.get(id),
            id,
          );
          try {
            const element = handle.asElement();
            if (!element)
              throw new Error("test_driver.click requires an element");
            await element.click();
          } finally {
            await handle.dispose();
          }
        });
      await page.context().addInitScript(() => {
        const clickTargets = new Map<number, Element>();
        let clickId = 0;
        Object.assign(window, { __runwayWptClickTargets: clickTargets });
        Object.defineProperty(window, "test_driver_internal", {
          configurable: true,
          set(driver) {
            Object.defineProperty(window, "test_driver_internal", {
              value: driver,
              configurable: true,
              writable: true,
            });
            driver.in_automation = true;
            driver.click = async (element: Element) => {
              const id = ++clickId;
              clickTargets.set(id, element);
              try {
                await (
                  window as typeof window & {
                    __runwayWptClick: (id: number) => Promise<unknown>;
                  }
                ).__runwayWptClick(id);
              } finally {
                clickTargets.delete(id);
              }
            };
          },
        });
        Object.defineProperty(window, "add_completion_callback", {
          configurable: true,
          set(callback) {
            Object.defineProperty(window, "add_completion_callback", {
              value: callback,
              configurable: true,
              writable: true,
            });
            queueMicrotask(() =>
              callback(
                (tests: WptResult["tests"], status: WptResult["status"]) => {
                  (
                    window as typeof window & { __runwayWptResult: WptResult }
                  ).__runwayWptResult = {
                    tests: tests.map(({ name, status, message }) => ({
                      name,
                      status,
                      message,
                    })),
                    status: { status: status.status, message: status.message },
                  };
                },
              ),
            );
          },
        });
      });
      const url = wptDocumentUrl(config, entry.url);
      const testPage = await page.context().newPage();
      let result: WptResult;
      try {
        const target = await page.evaluate((url) => {
          const proxy = (
            window as typeof window & {
              __runwayGetProxiedUrl?: (url: string) => string;
            }
          ).__runwayGetProxiedUrl;
          return proxy ? proxy(url) : url;
        }, url);
        await testPage.goto(target, { waitUntil: "commit", timeout: 15000 });
        await testPage.waitForFunction(
          () =>
            Boolean(
              (window as typeof window & { __runwayWptResult?: WptResult })
                .__runwayWptResult,
            ),
          undefined,
          { timeout: entry.timeout === "long" ? 65000 : 15000 },
        );
        result = await testPage.evaluate(
          () =>
            (window as typeof window & { __runwayWptResult: WptResult })
              .__runwayWptResult,
        );
      } catch (error) {
        result = { status: { status: 2, message: String(error) }, tests: [] };
      }
      await testPage.close();
      const directory = await wptResultsDirectory();
      const { profile } = await loadRunwayPluginProfile();
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
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(
          directory,
          `${harness}-${encodeURIComponent(entry.url)}.json`,
        ),
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
            testdriver: entry.testdriver,
            ...result,
          },
          null,
          2,
        ),
      );
      const failures = result.tests.filter((test) => test.status !== 0);
      if (
        result.status.status !== 0 ||
        pluginVerificationFailures.length ||
        !result.tests.length ||
        failures.length
      ) {
        throw new Error(
          JSON.stringify({
            harnessStatus: result.status,
            total: result.tests.length,
            failures,
            pluginVerificationFailures,
          }),
        );
      }
    },
  }),
);
