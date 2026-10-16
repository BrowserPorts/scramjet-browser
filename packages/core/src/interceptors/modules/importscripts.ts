import type { InterceptorClient } from "../client";

export const order = 0;

export const enabled = (client: InterceptorClient) =>
	typeof (client.global as { importScripts?: unknown }).importScripts ===
	"function";

export default function (client: InterceptorClient) {
	client.Proxy("importScripts", {
		apply(ctx) {
			ctx.args = ctx.args.map((raw: unknown) => {
				const url = client.resolve(String(raw));
				if (!url) return raw;
				// importScripts blocks the worker, which cannot wait on the transport
				if (client.route(url) !== "native")
					throw new DOMException(
						`Failed to load '${url.href}'`,
						"NetworkError"
					);
				return url.href;
			});
		},
	});
}
