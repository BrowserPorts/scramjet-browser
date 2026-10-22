import type { BareResponse } from "@mercuryworkshop/proxy-transports";
import {
	flagEnabled,
	rewriteCss,
	rewriteHtml,
	getWorkerInjectScripts,
	rewriteJs,
	rewriteWorkers,
} from "@/shared";
import { providers } from "@/shared/providers";
import {
	_TextDecoder,
	_Uint8Array,
	TextDecoder_decode,
} from "@/shared/snapshot";
import { Tap } from "@/Tap";
import type {
	BodyType,
	ScramjetFetchHandler,
	ScramjetFetchParsed,
	ScramjetFetchRequest,
} from ".";

function responseCharset(contentType: string | null): string {
	if (contentType === null || contentType.length === 0) {
		return "";
	}
	const parsed = providers().parseContentType(contentType);
	return parsed.hadCharset ? parsed.charset : "";
}

export async function rewriteBody(
	handler: ScramjetFetchHandler,
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed,
	response: BareResponse
): Promise<BodyType> {
	switch (parsed.destination) {
		case "iframe":
		case "document": {
			const contentType = response.headers.get("content-type") ?? "";
			if (providers().contentTypeIsHtml(contentType)) {
				const buf = await response.arrayBuffer();
				const bytes = new _Uint8Array(buf);
				const parsedType = providers().parseContentType(contentType);
				const decoded = providers().decodeTextResource(
					bytes,
					parsed.url.href,
					parsedType.mimeType || "text/html",
					{
						defaultEncoding: "",
						parentCharset: "",
						responseCharset: parsedType.hadCharset ? parsedType.charset : "",
					}
				);

				return rewriteHtml(decoded.text, handler.context, parsed.meta, {
					loadScripts: true,
					inline: true,
					source: parsed.url.href,
					clientId: request.resultingClientId || request.clientId,
					documentDestination: parsed.destination,
					...(request.sourceClientId === undefined
						? {}
						: { sourceClientId: request.sourceClientId }),
					...(request.resultingClientId === undefined
						? {}
						: { resultingClientId: request.resultingClientId }),
					...(parsed.meta.parentFrameName === undefined
						? {}
						: { parentFrameName: parsed.meta.parentFrameName }),
					headers: response.rawHeaders,
					// reasonably confident that a document fetch is impossible without a client
					history: parsed.trackedClient!.history,
				});
			} else {
				return response.body;
			}
		}
		case "script": {
			// do not attempt to rewrite a 404 response
			if (response.ok) {
				const ct = response.headers.get("content-type");
				// don't rewrite invalid module scripts when the server declares a non-JS type
				if (
					parsed.isModule &&
					ct &&
					!providers().contentTypeIsSupportedJavascript(ct)
				) {
					return response.body;
				}

				const bytes = new _Uint8Array(await response.arrayBuffer());
				const source = TextDecoder_decode(bytes);
				const scriptRouteId =
					parsed.url.searchParams.get("sj$script-route") ?? undefined;
				const scriptContext: typeof handler.hooks.rewriter.script.response.context =
					{
						parsed: {
							scriptType: parsed.isModule ? "module" : "regular",
							url: parsed.url,
							...(scriptRouteId === undefined ? {} : { scriptRouteId }),
						},
						url: parsed.url.href,
					};
				const scriptProps: typeof handler.hooks.rewriter.script.response.props =
					{
						source,
					};
				await Tap.dispatchSeries(
					handler.hooks.rewriter.script.response,
					scriptContext,
					scriptProps
				);
				if (scriptProps.replacement !== undefined) {
					return scriptProps.replacement;
				}

				let rewritten = rewriteJs(
					bytes,
					response.url,
					handler.context,
					parsed.meta,
					parsed.isModule
				);

				if (
					flagEnabled("debugSourceURL", handler.context, parsed.meta.origin)
				) {
					if (typeof rewritten !== "string") {
						rewritten = new _TextDecoder().decode(rewritten);
					}
					rewritten += `\n//# sourceURL=${parsed.url.href}`;
				}

				return rewritten as unknown as ArrayBuffer;
			}
			return response.body;
		}
		case "style": {
			const bytes = new _Uint8Array(await response.arrayBuffer());
			const decoded = providers().decodeCssResource(
				bytes,
				"",
				responseCharset(response.headers.get("content-type"))
			);
			return rewriteCss(decoded.text, handler.context, parsed.meta);
		}
		case "sharedworker":
		case "worker": {
			const bytes = new _Uint8Array(await response.arrayBuffer());
			const rewritten = rewriteWorkers(
				bytes,
				response.url,
				handler.context,
				parsed.meta,
				parsed.isModule
			);
			const workerContext: typeof handler.hooks.fetch.worker.context = {
				request,
				parsed,
			};
			const workerProps: typeof handler.hooks.fetch.worker.props = {
				body: rewritten,
				contentType: response.headers.get("content-type") ?? "",
				inject: getWorkerInjectScripts(handler.context, parsed.meta, parsed.isModule),
				source: TextDecoder_decode(bytes),
			};
			await Tap.dispatchSeries(
				handler.hooks.fetch.worker,
				workerContext,
				workerProps
			);
			return workerProps.replacement ?? rewritten;
		}
		default:
			return response.body;
	}
}
