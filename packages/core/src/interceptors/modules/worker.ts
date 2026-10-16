import { JSON_stringify, URL_createObjectURL } from "@/shared/snapshot";
import type { InterceptorClient } from "../client";
import { serveTransport } from "../transport";

export const order = 0;

/** The first message a wrapped worker receives, carrying its transport port */
export const WORKER_INIT = "scramjet-interceptors-init";

export const enabled = (client: InterceptorClient) =>
	Boolean(client.config.script) && typeof client.global.Worker === "function";

export default function (client: InterceptorClient) {
	client.Proxy("Worker", {
		construct(ctx) {
			const url = client.resolve(String(ctx.args[0]));
			if (!url) return;
			const route = client.route(url);
			if (route === "blocked") return;
			const options = ctx.args[1] as WorkerOptions | undefined;
			const script = JSON_stringify(client.config.script);
			// Every worker starts from a bootstrap that installs these interceptors before its own
			// script, which also lets a worker load from the page's origin or a blob at all
			const bootstrap =
				options?.type === "module"
					? `await import(${script});await self.$scramjetInterceptors.worker(true);`
					: `importScripts(${script});self.$scramjetInterceptors.worker();`;
			ctx.args[0] = URL_createObjectURL(
				new Blob([bootstrap], { type: "text/javascript" })
			);
			const worker = ctx.call() as Worker;
			const channel = new MessageChannel();
			serveTransport(channel.port1, client.transport);
			const blobScript = url.protocol === "blob:" || url.protocol === "data:";
			// Pages often revoke a worker's blob URL straight after constructing it, so its script
			// is read now, while the URL still resolves, rather than when the worker asks for it
			const copy = blobScript
				? client
						.nativeFetch(url.href)
						.then(async (response: Response) =>
							URL_createObjectURL(await response.blob())
						)
				: null;
			(async () => {
				const entry =
					route === "wisp"
						? await client.blob(url, "script")
						: ((await copy) ?? url.href);
				worker.postMessage(
					{
						type: WORKER_INIT,
						entry,
						// A blob worker resolves its relative URLs the way the page that made it does
						base: blobScript ? client.base : url.href,
						config: { ...client.config, origin: client.origin },
					},
					[channel.port2]
				);
			})().catch((error) => {
				client.report(error, url.href);
				worker.dispatchEvent(
					new ErrorEvent("error", { message: String(error) })
				);
			});
		},
	});
}
