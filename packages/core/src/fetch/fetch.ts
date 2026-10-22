import {
	BareRequestInit,
	BareResponse,
	RawHeaders,
} from "@mercuryworkshop/proxy-transports";
import {
	BodyType,
	ScramjetFetchHandler,
	ScramjetFetchParsed,
	ScramjetFetchRequest,
	ScramjetFetchResponse,
} from ".";
import { rewriteUrl, unrewriteBlob, unrewriteUrl } from "@rewriters/url";
import { QP, parseRequest } from "./parse";
import { flagEnabled, ScramjetHeaders } from "@/shared";
import {
	createDocumentPolicy,
	type DocumentPolicy,
	policyHeaderFor,
} from "@rewriters/policy";
import { isDocument, isRedirect, normalizeContentType } from "./util";
import { rewriteBody } from "./body";
import { Tap } from "@/Tap";
import {
	computeFetchSite,
	rewriteRequestHeaders,
	rewriteResponseHeaders,
	worstFetchSite,
} from "./headers";
import { Error, _URL } from "@/shared/snapshot";

/**
 * In realm mode each document response gets a content security policy of its
 * own, and the nonce in it goes on the scripts the rewritten markup keeps. The
 * browser then refuses any script the rewriter did not account for, whatever it
 * misread.
 */
function realmDocumentPolicy(
	handler: ScramjetFetchHandler,
	parsed: ScramjetFetchParsed
): DocumentPolicy | undefined {
	if (!flagEnabled("realmExecution", handler.context, parsed.meta.base)) {
		return undefined;
	}
	return isDocument(parsed) ? createDocumentPolicy() : undefined;
}

/** Sets the realm mode policy on a response that can hold script, replacing the page's own */
function applyDocumentPolicy(
	handler: ScramjetFetchHandler,
	parsed: ScramjetFetchParsed,
	headers: ScramjetHeaders,
	policy: DocumentPolicy | undefined
) {
	if (!flagEnabled("realmExecution", handler.context, parsed.meta.base)) return;
	const header = policyHeaderFor(parsed.destination, policy);
	if (header !== null) headers.set("Content-Security-Policy", header);
}

export async function doHandleFetch(
	handler: ScramjetFetchHandler,
	request: ScramjetFetchRequest
): Promise<ScramjetFetchResponse> {
	const parsed = parseRequest(request, handler);
	try {
		return await handleParsedFetch(handler, request, parsed);
	} catch (thrown) {
		// A load that produced no response is a failed load. Nothing downstream
		// of this rejection can name the request any more -- the service worker's
		// `route` catch only sees a message -- so the failure is dispatched here,
		// on the same `parsed` identity every other fetch hook receives, and then
		// rethrown unchanged.
		const error = thrown instanceof Error ? thrown : new Error(String(thrown));
		const errorContext: typeof handler.hooks.fetch.error.context = {
			request,
			parsed,
		};
		const errorProps: typeof handler.hooks.fetch.error.props = { error };
		await Tap.dispatchSeries(
			handler.hooks.fetch.error,
			errorContext,
			errorProps
		);
		throw error;
	}
}

async function handleParsedFetch(
	handler: ScramjetFetchHandler,
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed
): Promise<ScramjetFetchResponse> {
	if (isBlobOrDataUrl(parsed.url)) {
		return handleBlobOrDataUrlFetch(handler, request, parsed);
	}

	const interceptCtx: typeof handler.hooks.fetch.intercept.context = {
		request,
		parsed,
	};
	const interceptProps: typeof handler.hooks.fetch.intercept.props = {};
	await Tap.dispatchSeries(
		handler.hooks.fetch.intercept,
		interceptCtx,
		interceptProps
	);
	if (interceptProps.response) {
		return interceptProps.response;
	}

	if (parsed.hadExtraParams && isDocument(parsed)) {
		const location = rewriteUrl(parsed.url, handler.context, parsed.meta);
		if (location !== request.rawUrl.href) {
			const responseHeaders = new ScramjetHeaders();
			responseHeaders.set("location", location);
			return {
				body: "",
				headers: responseHeaders,
				status: 307,
				statusText: "Temporary Redirect",
			};
		}
	}

	const newheaders = await rewriteRequestHeaders(request, handler, parsed);

	let responseBody: BodyType;
	const response = await doNetworkFetch(handler, request, parsed, newheaders);

	// set-cookie needs to take the raw headers. after this, we can flatten the headers into a ScramjetHeaders object
	await handleCookies(
		handler,
		request,
		parsed,
		response.rawHeaders,
		response.status
	);

	if (isDocument(parsed)) {
		// Keep the navigation's policy-filtered referrer for the document it creates
		parsed.trackedClient?.history.push({
			url: parsed.url.href,
			referrer: newheaders.get("Referer") ?? "",
		});
	}

	const responseHeaders = await rewriteResponseHeaders(
		handler,
		request,
		parsed,
		response.rawHeaders
	);

	if (isRedirect(response)) {
		const location = new _URL(responseHeaders.get("location"));
		const referer = newheaders.get("Referer");

		// Compute the page (initiator) URL once. The initiator never changes
		// through a redirect chain, so prefer the propagated `sj$io` value if
		// the chain has already started; otherwise fall back to rawClientUrl
		// or rawReferrer (which point at the page for the *first* hop).
		let initiatorOriginUrl: URL | undefined;
		if (parsed.fetchInitiatorOrigin) {
			try {
				initiatorOriginUrl = new URL(parsed.fetchInitiatorOrigin);
			} catch {
				initiatorOriginUrl = undefined;
			}
		}
		if (!initiatorOriginUrl) {
			const rawClient =
				request.rawClientUrl ||
				(request.rawReferrer ? new URL(request.rawReferrer) : undefined);
			initiatorOriginUrl =
				rawClient &&
				rawClient.pathname.startsWith(handler.context.prefix.pathname)
					? new URL(unrewriteUrl(rawClient, handler.context))
					: undefined;
		}

		// Cross-site redirect poisoning (SameSite): if this hop was cross-site, or a
		// previous hop already was, propagate the flag so the final destination
		// enforces cross-site SameSite restrictions.
		const crossSiteRedirect =
			parsed.crossSiteRedirect ||
			(!!initiatorOriginUrl &&
				registrableDomainForRedirect(initiatorOriginUrl.hostname) !==
					registrableDomainForRedirect(parsed.url.hostname));

		// Sec-Fetch-Site chain state: combine the worst classification seen so
		// far with the relation between the initiator and *this* hop's URL.
		// Once "cross-site" appears, it sticks for the rest of the chain.
		let propagatedFetchSite: "same-site" | "cross-site" | undefined;
		if (initiatorOriginUrl) {
			const hopSite = computeFetchSite(initiatorOriginUrl, parsed.url);
			const propagated = parsed.fetchSiteState
				? worstFetchSite(parsed.fetchSiteState, hopSite)
				: hopSite;
			if (propagated !== "same-origin" && propagated !== "none") {
				propagatedFetchSite = propagated;
			}
		}

		location.searchParams.set(QP.referrerSource, referer ?? "");
		if (crossSiteRedirect) location.searchParams.set(QP.crossSiteRedirect, "1");
		if (propagatedFetchSite)
			location.searchParams.set(QP.fetchSite, propagatedFetchSite);
		if (initiatorOriginUrl)
			location.searchParams.set(QP.initiatorOrigin, initiatorOriginUrl.origin);
		if (parsed.isModule) location.searchParams.set(QP.isModule, "module");

		responseHeaders.set("location", location.href);
	}

	const documentPolicy = realmDocumentPolicy(handler, parsed);
	if (response.body && !isRedirect(response)) {
		responseBody = await rewriteBody(
			handler,
			request,
			parsed,
			response,
			documentPolicy
		);

		// After rewriting HTML, the body is a JS string which will be encoded as
		// UTF-8 by the Response constructor. Normalize the Content-Type charset so
		// the browser doesn't try to decode UTF-8 bytes with the original encoding.
		normalizeContentType(parsed, responseHeaders);
	}
	applyDocumentPolicy(handler, parsed, responseHeaders, documentPolicy);

	const respcontext: typeof handler.hooks.fetch.response.context = {
		request,
		parsed,
	};
	const respprops: typeof handler.hooks.fetch.response.props = {
		response: {
			body: responseBody,
			headers: responseHeaders,
			status: response.status,
			statusText: response.statusText,
		},
	};

	await Tap.dispatchSeries(
		handler.hooks.fetch.response,
		respcontext,
		respprops
	);

	return respprops.response;
}

export async function doNetworkFetch(
	handler: ScramjetFetchHandler,
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed,
	newheaders: ScramjetHeaders
): Promise<BareResponse> {
	const init = {
		body: request.body,
		headers: newheaders.toRawHeaders(),
		method: request.method,
		redirect: "manual",
	} as BareRequestInit;

	const reqcontext: typeof handler.hooks.fetch.request.context = {
		client: handler.client,
		request,
		parsed,
	};
	const reqprops: typeof handler.hooks.fetch.request.props = {
		init,
		url: parsed.url,
	};
	await Tap.dispatchSeries(handler.hooks.fetch.request, reqcontext, reqprops);
	let earlyResponse: BareResponse;

	if (reqprops.earlyResponse) {
		const resp = reqprops.earlyResponse;
		if ("rawHeaders" in resp) {
			// it's a bare response
			earlyResponse = resp;
		} else {
			// it's a native response, convert it
			earlyResponse = BareResponse.fromNativeResponse(resp);
		}
	} else {
		earlyResponse = await handler.client.fetch(reqprops.url, reqprops.init);
	}

	const prerespcontext: typeof handler.hooks.fetch.preresponse.context = {
		request,
		parsed,
	};

	const prerespprops: typeof handler.hooks.fetch.preresponse.props = {
		response: earlyResponse,
	};

	await Tap.dispatchSeries(
		handler.hooks.fetch.preresponse,
		prerespcontext,
		prerespprops
	);

	return prerespprops.response;
}

function isBlobOrDataUrl(url: _URL): boolean {
	return url.protocol === "blob:" || url.protocol === "data:";
}

async function handleBlobOrDataUrlFetch(
	handler: ScramjetFetchHandler,
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed
): Promise<ScramjetFetchResponse> {
	let response: BareResponse;

	// The platform owns what each scheme does with a method, so it travels with
	// the URL instead of being flattened to a `GET` here.
	const schemeInit = { method: request.method };

	if (parsed.url.protocol === "data:") {
		/*
		 * The already-decoded logical URL, not a second read of the wire.
		 *
		 * `parseRequest` has run `unrewriteUrl` on this request, so the data: URL is
		 * recovered once, by the codec that wrote it. Re-deriving it here from
		 * `rawUrl.pathname` was the second adapter: `pathname` is normalized and
		 * percent-encoded by the URL parser and carries neither query nor fragment,
		 * so payload bytes were lost before the response was ever built.
		 *
		 * Served inline exactly as before — no network fetch, no http origin — so the
		 * arrangement around a data: document's origin is unchanged (and unverified).
		 */
		response = BareResponse.fromNativeResponse(
			await handler.fetchDataUrl(parsed.url.href, schemeInit)
		);
	} else {
		// blob: keeps its own raw-prefix wire format, untouched by this change.
		let blobUrl = request.rawUrl.pathname.substring(
			handler.context.prefix.pathname.length
		);
		blobUrl = unrewriteBlob(blobUrl, handler.context, parsed.meta);

		if (parsed.isFakeDataURL) {
			/*
			 * A data: URL too large to survive on the wire, parked in a control blob.
			 *
			 * The blob holds the data: URL TEXT, so the logical request is still a
			 * data: request and keeps data: semantics: `HEAD` answers with an empty
			 * body and `POST` answers with the payload, rather than inheriting blob's
			 * rule that every non-`GET` method is a network error.
			 *
			 * Reading our own backing storage is a `GET` — deliberately independent
			 * of the method the page asked for, which belongs to the logical data:
			 * fetch below. The read is bounded by a blob the browser already holds,
			 * not by dereferencing some arbitrary external URL.
			 *
			 * Nothing here revokes the object URL. `$fakedataurl=1` is written by the
			 * caller and the blob it names may belong to the page, so this request is
			 * not authority to destroy it: revoking on the failure path let a forged
			 * marker delete a page's own blob, and revoking on the success path was
			 * the same defect with a validated payload in front of it. Validated
			 * CONTENTS still do not make a caller-supplied marker an owner.
			 *
			 * Lifetime is left to whichever environment created the URL, and this
			 * code does not establish which one that is. `URL.createObjectURL` is
			 * absent in service workers, but that is an API fact, not a callgraph
			 * fact: it does not prove where the producer actually runs, and the
			 * rewriters it lives in are shared across several realms. Nor is the
			 * release itself verified here.
			 *
			 * So: not disposing is a deliberate choice against caller-directed
			 * destruction, and NOT a claim that these entries are released, or that
			 * nothing accumulates. Both the release and this oversized producer path
			 * as a whole remain unverified: this code never revokes the object URL,
			 * and nothing here establishes that its producer does.
			 */
			const control = await handler.fetchBlobUrl(blobUrl, { method: "GET" });
			const recovered = await control.text();

			/*
			 * The marker is a query parameter the page can write, pointing at a blob
			 * the page may own, so this text is untrusted input that decides what
			 * gets fetched next. Anything that is not a data: URL is refused —
			 * otherwise a forged marker could make this branch fetch an arbitrary
			 * http URL from the proxy's own origin.
			 *
			 * The parsed result is what gets used, so there is no gap between what
			 * was checked and what is fetched. This bounds what a forged marker can
			 * reach; it does NOT establish that the marker is ours, which remains an
			 * existing unfixed gap.
			 */
			let recoveredUrl: _URL | null = null;
			try {
				recoveredUrl = new _URL(recovered);
			} catch {
				recoveredUrl = null;
			}
			if (!recoveredUrl || recoveredUrl.protocol !== "data:") {
				throw new Error(
					"fake data URL did not resolve to a data: URL, refusing to fetch it"
				);
			}

			response = BareResponse.fromNativeResponse(
				await handler.fetchDataUrl(recoveredUrl.href, schemeInit)
			);
		} else {
			response = BareResponse.fromNativeResponse(
				await handler.fetchBlobUrl(blobUrl, schemeInit)
			);
		}
	}

	let body: BodyType;
	const documentPolicy = realmDocumentPolicy(handler, parsed);
	if (response.body) {
		body = await rewriteBody(
			handler,
			request,
			parsed,
			response as BareResponse,
			documentPolicy
		);
	}
	const headers = ScramjetHeaders.fromRawHeaders(response.rawHeaders);

	// blob urls actually *can* set charsets, so we need to normalize them if it goes down the html path
	normalizeContentType(parsed, headers);
	applyDocumentPolicy(handler, parsed, headers, documentPolicy);

	if (handler.crossOriginIsolated) {
		headers.set("Cross-Origin-Opener-Policy", "same-origin");
		headers.set("Cross-Origin-Embedder-Policy", "require-corp");
	}

	return {
		body,
		status: response.status,
		statusText: response.statusText,
		headers: headers,
	};
}

/** Simplified registrable-domain check used for cross-site redirect detection. */
export function registrableDomainForRedirect(hostname: string): string {
	if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return hostname;
	const labels = hostname.split(".");
	if (labels.length <= 1) return hostname;
	if (labels[0] === "www") return labels.slice(1).join(".");
	if (labels.length === 2) return hostname;
	return labels.slice(-2).join(".");
}

async function handleCookies(
	handler: ScramjetFetchHandler,
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed,
	rawHeaders: RawHeaders,
	status: number
) {
	const cookies: string[] = [];

	for (const [key, value] of rawHeaders) {
		if (key.toLowerCase() !== "set-cookie") continue;

		cookies.push(value);
	}

	if (cookies.length === 0) {
		return;
	}

	if (handler.context.cookieJar.setResponseCookies) {
		await handler.context.cookieJar.setResponseCookies({
			url: parsed.url,
			cookies,
			status,
			method: request.method,
			destination: parsed.destination,
			mode: request.mode,
			cache: request.cache,
			rawReferrer: request.rawReferrer,
			referrer: request.referrer,
			rawClientUrl: request.rawClientUrl,
			clientId: request.clientId,
			crossSiteRedirect: parsed.crossSiteRedirect,
		});
	} else {
		for (const cookie of cookies) {
			await handler.context.cookieJar.setCookies(cookie, parsed.url, false);
		}
	}

	await handler.sendSetCookie(
		cookies.map((cookie) => ({
			url: parsed.url,
			cookie,
		})),
		{
			destination: parsed.destination,
		}
	);
}
