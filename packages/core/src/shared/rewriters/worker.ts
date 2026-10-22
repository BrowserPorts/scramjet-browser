import { flagEnabled, ScramjetContext } from "@/shared";
import { rewriteJs } from "@rewriters/js";
import { URLMeta } from "@rewriters/url";
import { Error, TextDecoder_decode } from "@/shared/snapshot";
import { base64Encode } from "@/shared/util";
import { rewriteInjectedJs } from "./injected";

/** Plugins can install dependencies before any worker runtime imports execute */
export function getWorkerInjectScripts(
  context: ScramjetContext,
  meta: URLMeta,
  isModule: boolean,
) {
  const script = (script: string) => {
    if (isModule) {
      return `import "${script}"\n`;
    }
    return `importScripts("${script}");\n`;
  };
  const b64 = (script: string) =>
    `data:text/javascript;charset=utf-8;base64,${base64Encode(script)}`;
  const prelude = rewriteInjectedJs(
    "",
    "workerPrelude",
    context,
    meta,
    isModule,
  );
  let str = prelude ? script(b64(prelude)) : "";
  str += context.interface.getWorkerInjectScripts(
    meta,
    isModule,
    script,
    (source) => rewriteInjectedJs(source, "worker", context, meta, isModule),
  );

  return str;
}

export function rewriteWorkers(
  js: string | Uint8Array,
  url: string,
  context: ScramjetContext,
  meta: URLMeta,
  isModule: boolean,
) {
  // The worker's own client would read the same realmExecution flag and skip the
  // helpers a rewritten worker script calls, and there is no worker realm yet,
  // so a worker cannot run in either way.
  if (flagEnabled("realmExecution", context, meta.origin)) {
    throw new Error("workers are not supported while realmExecution is on");
  }

  let str = getWorkerInjectScripts(context, meta, isModule);

  const code = rewriteJs(js, url, context, meta, isModule);
  let rewritten: string = typeof code === "string" ? code : TextDecoder_decode(code);

  if (flagEnabled("encapsulateWorkers", context, meta.origin)) {
    // TODO: check if there's already a sourceURL/sourcemap before appending another?
    rewritten += `//# sourceURL=${url}`;
    const source = `data:text/javascript;charset=utf-8;base64,${base64Encode(rewritten)}`;
    str += isModule ? `import "${source}"\n` : `importScripts("${source}");\n`;
  } else {
    str += rewritten;
  }

  return str;
}
