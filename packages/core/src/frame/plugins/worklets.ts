import type { ScramjetMinimalClient } from "@/minimal/client";
import type { ScramjetMinimalPlugin } from "@/plugins/types";
import { Reflect_apply } from "@/shared/snapshot";
import { frameOf } from "../state";

/**
 * A worklet module (an AudioWorklet's processor, a paint worklet) loads natively, which the frame's
 * policy refuses, so it is fetched over the link as a module and added from a blob this frame made,
 * which a worklet in the same opaque origin can load (measured for AudioWorklet).
 */
function install(client: ScramjetMinimalClient) {
	client.Proxy("Worklet.prototype.addModule", {
		apply(ctx) {
			const url = client.resolve(String(ctx.args[0]), client.base);
			if (!url || client.route(url) !== "wisp") return;
			const worklet = ctx.this;
			const native = ctx.fn;
			const options = ctx.args[1];
			ctx.return(
				client
					.blob(url, "script", true)
					.then((blob) => Reflect_apply(native, worklet, [blob, options]) as Promise<void>)
			);
		},
	});
}

export default {
	name: "frame-worklets",
	scope: ["window"],
	enabled: (client: ScramjetMinimalClient) => frameOf(client) !== null,
	install,
} satisfies ScramjetMinimalPlugin<ScramjetMinimalClient>;
