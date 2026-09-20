import { ScramjetConfig, ScramjetFlags, ScramjetVersionInfo } from "@/types";
import DomHandler, { Element } from "domhandler";
import { URLMeta } from "@rewriters/url";
import { CookieStore } from "./cookie";
import type { ScramjetStorageManager } from "./storage";
import { TapInstance } from "@/Tap";
import { HtmlContext } from "@/shared/rewriters/html";
import { _RegExp } from "./snapshot";

export * from "./cookie";
export * from "./headers";
export * from "./htmlRules";
export * from "./mime";
export * from "./providers";
export * from "./realmchannel";
export * from "./rewriters";
export * from "./serviceworker";
export * from "./storage";

export function flagEnabled(
  flag: keyof ScramjetFlags,
  context: ScramjetContext,
  url: URL,
): boolean {
  const value = context.config.flags[flag];
  for (const regex in context.config.siteFlags) {
    const partialflags = context.config.siteFlags[regex];
    if (new _RegExp(regex).test(url.href) && flag in partialflags) {
      return partialflags[flag];
    }
  }

  return value;
}
export type ScramjetInterface = {
  codecEncode: (input: string) => string;
  codecDecode: (input: string) => string;

  getInjectScripts(
    meta: URLMeta,
    handler: DomHandler,
    htmlcontext: HtmlContext,
    script: (src: string) => Element,
  ): Element[];
  getWorkerInjectScripts?(
    meta: URLMeta,
    isModule: boolean,
    script: (src: string) => string,
    nativeServiceWorker?: boolean,
  ): string;
  getWorkerFinalizeScript?(): string;
  nativeServiceWorkerPath?: string;
};

export type ScramjetContext = {
  config: ScramjetConfig;
  prefix: URL;
  interface: ScramjetInterface;
  cookieJar: CookieStore;
  storage?: ScramjetStorageManager;
  // identity of the StoragePartition this realm executes in; CacheStorage
  // and IndexedDB names are scoped by it so two partitions on one browser
  // origin never share a cache or database
  storagePartitionKey?: string;
  hooks?: {
    rewriter: {
      html: TapInstance<HtmlRewriterHooks>;
      script?: TapInstance<ScriptRewriterHooks>;
    };
  };
};

export type HtmlRewriterHooks = {
  pre: {
    context: {
      handler: DomHandler;
      meta: URLMeta;
      origHtml: string;
      htmlcontext: HtmlContext;
    };
  };
  post: {
    context: {
      handler: DomHandler;
      meta: URLMeta;
      origHtml: string;
      htmlcontext: HtmlContext;
    };
    props: {
      setRawHtml?: string;
    };
  };
};
/**
 * Dispatched with the author bytes of a "script" destination fetch before
 * `rewriteJs` runs. A tap replaces the body only by setting `replacement`;
 * a tap rejection rejects the fetch. `scriptRouteId` is the `sj$script-route`
 * query parameter when the HTML rewriter marked the request for a page-engine
 * route; unmarked scripts omit it.
 */
export type ScriptRewriterHooks = {
  response: {
    context: {
      parsed: {
        scriptRouteId?: string;
        scriptType: "module" | "regular";
        url: URL;
      };
      url: string;
    };
    props: {
      replacement?: string;
      source: string;
    };
  };
};
