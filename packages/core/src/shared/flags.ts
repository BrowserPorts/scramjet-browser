import type { ScramjetFlags } from "@/types";
import type { ScramjetContext } from "@/shared";
import { _RegExp } from "./snapshot";

export function flagEnabled(
  flag: keyof ScramjetFlags,
  context: ScramjetContext,
  url: URL,
): boolean {
  const value = context.config.flags[flag];
  // Whether page scripts run in an embedder's realm is decided once for the whole
  // controller. A site that turned it off would be rewritten by one half of the
  // runtime and hosted by the other, so no site flag can change it
  if (flag === "realmExecution") return value === true;
  for (const regex in context.config.siteFlags) {
    const partialflags = context.config.siteFlags[regex];
    if (new _RegExp(regex).test(url.href) && flag in partialflags) {
      return partialflags[flag];
    }
  }

  return value;
}
