import { ScramjetConfig, ScramjetFlags, ScramjetVersionInfo } from "@/types";
import DomHandler, { Element } from "domhandler";
import { URLMeta } from "@rewriters/url";
import { CookieStore } from "./cookie";
import type { ScramjetStorageManager } from "./storage";
import type { UrlCodec } from "@/plugins/types";
import { TapInstance } from "@/Tap";
import { HtmlContext } from "@/shared/rewriters/html";

export * from "./cookie";
export * from "./flags";
export * from "./headers";
export * from "./htmlRules";
export * from "./mime";
export * from "./providers";
export * from "./rewriters";
export * from "./storage";

export type ScramjetInterface = {
  codecEncode: (input: string) => string;
  codecDecode: (input: string) => string;

  getInjectScripts(
    meta: URLMeta,
    handler: DomHandler,
    htmlcontext: HtmlContext,
    script: (src: string) => Element,
    transform?: (source: string) => string,
  ): Element[];
  getWorkerInjectScripts?(
    meta: URLMeta,
    isModule: boolean,
    script: (src: string) => string,
    transform?: (source: string) => string,
  ): string;
};

export type ScramjetContext = {
  config: ScramjetConfig;
  prefix: URL;
  /**
   * Where original URLs load from, for runtimes without the proxy's wire
   * format. With a codec, rewriteUrl maps each URL the codec owns and leaves
   * the rest as written, and unrewriteUrl maps back; the prefix is unused.
   */
  codec?: UrlCodec;
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
      code?: TapInstance<CodeRewriterHooks>;
    };
  };
};

export type HtmlRewriterHooks = {
  element: {
    context: { element: Element; meta: URLMeta };
    props: {};
  };
  text: {
    context: { parent: Element | null; meta: URLMeta };
    props: { text: string };
  };
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

/** Synchronous transforms run inside Scramjet's rewriters before their result is exposed */
export type CodeRewriterHooks = {
  /** Runtime code is transformed without treating it as guest JavaScript */
  injectedJavascript: {
    context: {
      kind: "document" | "worker" | "wasm";
      meta: URLMeta;
      isModule: boolean;
    };
    props: { source: string };
  };
  javascript: {
    context: { url: string | null; meta: URLMeta; isModule: boolean };
    props: { source: string };
  };
  css: {
    context: {
      meta: URLMeta;
      direction: "rewrite" | "unrewrite";
      kind: "stylesheet" | "declarations" | "value";
    };
    props: { source: string };
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
