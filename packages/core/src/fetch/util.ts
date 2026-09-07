import { ScramjetHeaders } from "@/shared";
import { providers } from "@/shared/providers";
import { BareResponse } from "@mercuryworkshop/proxy-transports";
import { ScramjetFetchParsed } from ".";

// marks a body that already went through the rewriter. an emulated service
// worker can respond with something it fetched (rewritten) or something it built
// itself (not), and there's no other way to tell them apart. a header survives
// Cache round-trips, unlike anything attached to the Response object
export const REWRITTEN_HEADER = "x-scramjet-rewritten";

export function normalizeContentType(
	parsed: ScramjetFetchParsed,
	headers: ScramjetHeaders
) {
	if (!isDocument(parsed)) return;

	const ct = headers.get("content-type");
	if (!ct) return;
	if (!providers().contentTypeIsHtml(ct)) return;

	headers.set("content-type", "text/html; charset=utf-8");
}

export function isRedirect(response: BareResponse) {
	return response.status >= 300 && response.status < 400;
}

export function isDocument(parsed: ScramjetFetchParsed) {
	return parsed.destination === "document" || parsed.destination === "iframe";
}

export function createReferrerString(
	clientUrl: URL,
	resource: URL,
	policy: string | null
): string {
	policy ||= "strict-origin-when-cross-origin";
	const originIsHttps = clientUrl.protocol === "https:";
	const destIsHttps = resource.protocol === "https:";

	const isPotentialDowngrade = originIsHttps && !destIsHttps;

	const isSameOrigin =
		clientUrl.protocol === resource.protocol &&
		clientUrl.host === resource.host;

	const referrerOrigin = clientUrl.origin;

	const referrerUrl = new URL(clientUrl.href);
	referrerUrl.hash = "";
	const referrerUrlString = referrerUrl.href;

	switch (policy) {
		case "no-referrer":
			return "";

		case "no-referrer-when-downgrade":
			if (isPotentialDowngrade) return "";
			return referrerUrlString;

		case "same-origin":
			if (isSameOrigin) return referrerUrlString;
			return "";

		case "origin":
			return referrerOrigin === "null" ? "" : referrerOrigin + "/";

		case "strict-origin":
			if (isPotentialDowngrade) return "";
			return referrerOrigin === "null" ? "" : referrerOrigin + "/";

		case "origin-when-cross-origin":
			if (isSameOrigin) return referrerUrlString;
			return referrerOrigin === "null" ? "" : referrerOrigin + "/";

		case "strict-origin-when-cross-origin":
			if (isSameOrigin) return referrerUrlString;
			if (isPotentialDowngrade) return "";
			return referrerOrigin === "null" ? "" : referrerOrigin + "/";

		case "unsafe-url":
			return referrerUrlString;

		default:
			return "";
	}
}
