import { rewriteJs } from "@rewriters/js";
import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";

// The page's functions and string timers belong to its realm, and compiling text in this one
// would need the 'unsafe-eval' that realm mode's policy withholds
export const enabled = (client: ScramjetClient) =>
	!client.flagEnabled("realmExecution");

export default function (client: ScramjetClient, self: Self) {
	client.Proxy(["setTimeout", "setInterval"], {
		apply(ctx) {
			if (typeof ctx.args[0] !== "function") {
				const code = String(ctx.args[0]);
				// @ts-expect-error - for some reason it doesn't recognize setTimeout(string, number)
				ctx.args[0] = rewriteJs(
					code,
					"(setTimeout string eval)",
					client.context,
					client.meta
				);
			}
		},
	});
}
