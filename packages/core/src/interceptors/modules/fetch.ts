import type { InterceptorClient } from "../client";

export const order = 0;

export default function (client: InterceptorClient, self: typeof globalThis) {
	const Request_ = self.Request;
	client.Proxy("fetch", {
		apply(ctx) {
			let [input, init] = ctx.args as [
				RequestInfo | URL,
				RequestInit | undefined,
			];
			// Workers run from blob URLs, so relative URLs resolve against their script instead
			if (!(input instanceof Request_)) {
				const url = client.resolve(String(input));
				if (url) input = url.href;
			}
			let request: Request;
			try {
				request = new Request_(input, init);
			} catch {
				ctx.args = [input, init];
				return;
			}
			const url = client.resolve(request.url)!;
			const route = client.route(url);
			if (route === "native") {
				ctx.args = [request];
				return;
			}
			if (route === "blocked") {
				ctx.return(Promise.reject(new TypeError("Failed to fetch")));
				return;
			}
			ctx.return(
				client.fetch(request).catch((error) => {
					if (error?.name === "AbortError") throw error;
					client.report(error, url.href);
					throw new TypeError("Failed to fetch");
				})
			);
		},
	});
}
