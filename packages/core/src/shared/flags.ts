import type { ScramjetFlags } from "@/types";
import type { ScramjetContext } from "@/shared";
import { _RegExp } from "./snapshot";

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
