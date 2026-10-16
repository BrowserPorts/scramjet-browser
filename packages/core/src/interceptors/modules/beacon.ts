import type { InterceptorClient } from "../client";

export const order = 0;

export const enabled = (client: InterceptorClient) =>
	typeof client.global.navigator?.sendBeacon === "function";

export default function (client: InterceptorClient) {
	client.Proxy("Navigator.prototype.sendBeacon", {
		apply(ctx) {
			const url = client.resolve(String(ctx.args[0]));
			if (!url) return;
			const route = client.route(url);
			if (route === "native") {
				ctx.args[0] = url.href;
				return;
			}
			// A beacon is fire and forget, and one to a blocked host is dropped as if queued
			if (route === "wisp")
				client
					.fetch(
						new Request(url.href, {
							method: "POST",
							body: (ctx.args[1] as BodyInit | null) ?? null,
						})
					)
					.then((response) => response.body?.cancel())
					.catch((error) => client.report(error, url.href));
			ctx.return(true);
		},
	});
}
