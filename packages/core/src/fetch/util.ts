import { ScramjetHeaders } from "@/shared";
import { providers } from "@/shared/providers";
import { BareResponse } from "@mercuryworkshop/proxy-transports";
import { ScramjetFetchParsed } from ".";

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

/**
 * Fetch's redirect status set, not "any 3xx".
 *
 * `304` and `305` are 3xx but are not redirects and carry no `Location`, so the
 * old range treated a Not Modified as a redirect: it read a `Location` that was
 * not there and threw, and it also skipped body rewriting for it.
 *
 * https://fetch.spec.whatwg.org/#redirect-status
 */
export function isRedirect(response: BareResponse) {
	const status = response.status;

	return (
		status === 301 ||
		status === 302 ||
		status === 303 ||
		status === 307 ||
		status === 308
	);
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
