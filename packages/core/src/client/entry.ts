// entrypoint for scramjet.client.js

import { ScramjetContext, ScramjetInterface } from "@/shared/index";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
import { ScramjetConfig } from "@/types";
import { QP } from "@/fetch/parse";
import { _URL } from "@/shared/snapshot";

export const iswindow = "window" in globalThis && window instanceof Window;
export const isworker = "WorkerGlobalScope" in globalThis;
export const issw = "ServiceWorkerGlobalScope" in globalThis;
export const isdedicated = "DedicatedWorkerGlobalScope" in globalThis;
export const isshared = "SharedWorkerGlobalScope" in globalThis;

// Virtual scope stamped on transformed service-worker source. Native workers
// keep their browser-provided global; the legacy non-SW realm path is retained
// only for compatibility with callers that still construct one directly.
export const swrealmscope: string | null = (() => {
  if (!isworker) return null;
  try {
    return (
      new _URL(globalThis.location.href).searchParams.get(QP.swScope) || null
    );
  } catch {
    return null;
  }
})();

export const isnativesw = issw && swrealmscope !== null;
export const isemulatedsw = !issw && swrealmscope !== null;
