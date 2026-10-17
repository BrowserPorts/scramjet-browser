import { ScramjetContext } from "@/shared";
import { rewriteJs } from "@rewriters/js";
import { QP } from "@/fetch/parse";
import { ScramjetDestination } from "@/types";

import {
	_URL,
	_URLSearchParams,
	String,
	String_startsWith,
	URL_createObjectURL,
} from "../snapshot";

// user: manually triggered navigation
// link: link clicked by the user. still user initiated, but doesn't wipe
// location: location = ...
export type NavigationType = "user" | "link" | "location";

export type RewriteUrlOptions = {
	referrerPolicy?: string;
	isModule?: boolean;
	navigateType?: NavigationType;
	topFrame?: string;
	parentFrame?: string;
	isIframe?: string;
	mode?: string;
	credentials?: string;
	destination?: ScramjetDestination;
	workerName?: string;
	workerCorrelation?: string;
};

export type URLMeta = {
	origin: _URL;
	base: _URL;
	topFrameName?: string;
	parentFrameName?: string;
	referrerPolicy?: string;
};

function tryCanParseURL(url: string, origin?: string | URL): _URL | null {
	try {
		return new _URL(url, origin);
	} catch {
		return null;
	}
}

export function rewriteBlob(
	url: string,
	context: ScramjetContext,
	meta: URLMeta
) {
	const blob = new _URL(url.substring("blob:".length));

	return "blob:" + meta.origin.origin + blob.pathname;
}

export function unrewriteBlob(
	url: string,
	context: ScramjetContext,
	_meta: URLMeta
) {
	const blob = new _URL(url.substring("blob:".length));

	return "blob:" + context.prefix.origin + blob.pathname;
}

export function rewriteUrl(
	url: string | URL,
	context: ScramjetContext,
	meta: URLMeta,
	options?: RewriteUrlOptions
) {
	url = String(url);

	if (String_startsWith(url, "javascript:")) {
		return (
			"javascript:" +
			rewriteJs(
				url.slice("javascript:".length),
				"(javascript: url)",
				context,
				meta
			)
		);
	} else if (String_startsWith(url, "blob:")) {
		return context.prefix.href + url;
	} else if (String_startsWith(url, "data:")) {
		const URL_MAX_LENGTH = 1024 * 1024 * 2;
		const BUFFER = 1024;

		/*
		 * Canonicalized by the URL owner before anything is encoded.
		 *
		 * `_URL` applies the USVString conversion the codec cannot: a lone surrogate
		 * becomes U+FFFD here, where `encodeURIComponent` throws `URIError` and took
		 * the whole rewrite down. It also applies the same preprocessing the browser
		 * would apply to this URL anyway (whitespace, opaque-path resolution), so
		 * what travels is what the page itself would have seen.
		 */
		const normalized = tryCanParseURL(url);
		// Unparseable: passed through unrewritten, the way the ordinary branch below
		// treats a URL it cannot resolve. No fallback to the network is invented.
		if (!normalized) return url;

		/*
		 * The fragment travels OUTSIDE the encoded payload, exactly as the ordinary
		 * branch does, so the browser can see and replace it. Encoded inside the path
		 * it was invisible, and a later `location.hash = "two"` appended rather than
		 * replaced, producing `…#one#two`. A `?` stays inside the payload, because it
		 * belongs to the data URL's own processing.
		 *
		 * Split on the first literal `#` of the SERIALIZED href, which is the
		 * fragment delimiter: the URL serializer leaves a payload `#` percent-encoded
		 * as `%23`, so the first literal one is never part of the data.
		 *
		 * `.hash` cannot be used for this. It answers `""` for both "no fragment" and
		 * "present but empty", so `data:,x#` lost its delimiter into the payload and a
		 * later hash assignment produced `data:,x##two`. Presence is carried by the
		 * index instead, and the delimiter is emitted even when the fragment is empty.
		 */
		const hashIndex = normalized.href.indexOf("#");
		const hasFragment = hashIndex !== -1;
		const payload = hasFragment
			? normalized.href.slice(0, hashIndex)
			: normalized.href;
		const fragmentText = hasFragment
			? normalized.href.slice(hashIndex + 1)
			: "";

		const encodedPayload = context.interface.codecEncode(payload);
		const encodedHash = hasFragment
			? "#" + context.interface.codecEncode(fragmentText)
			: "";

		/*
		 * Measured on the WIRE, not on the input.
		 *
		 * The codec percent-encodes twice, so a comma-heavy payload expands several
		 * times over; checking the raw `url.length` let a 500KB data URL become a
		 * multi-megabyte request URL that the browser refuses. Encoded once here and
		 * reused below, so the large payload is not built twice.
		 */
		if (
			context.prefix.href.length +
				encodedPayload.length +
				encodedHash.length +
				BUFFER >
			URL_MAX_LENGTH
		) {
			// chrome will explode if you make a request to a service worker with a 2MB+ URL
			// there's an okayish workaround which is just Pretending It's a Blob
			//
			/*
			 * This is a CONTROL blob: it carries the normalized data: URL TEXT, not
			 * the payload's decoded bytes.
			 *
			 * Storing decoded bytes forced this side to parse the data URL itself —
			 * split the media type, re-implement base64 — and what came back was a
			 * blob: response, so the request stopped being a data: request: its mime
			 * and its method rules came from here instead of from the platform.
			 * Handing over the text lets the consumer recover the logical URL and
			 * delegate to the native data: fetch, which owns mime and base64 exactly.
			 *
			 * `payload` is already normalized and fragment-stripped, so the recovered
			 * URL carries no stale hash; the fragment travels literally on the wire.
			 * A data: URL that is malformed (no comma) is no longer special-cased
			 * here: it round-trips and the native fetch rejects it, which is the
			 * error the page should see.
			 */
			const objectUrl = URL_createObjectURL(new Blob([payload]));
			/*
			 * The fragment is appended LITERALLY here, not codec-encoded.
			 *
			 * This wire is read back by `unrewriteUrl`'s blob branch, which returns the
			 * raw suffix after the prefix without decoding it. Feeding it a codec-escaped
			 * hash would surface those escapes in the logical URL, so the fake-blob
			 * fragment follows the blob contract rather than the data one.
			 */
			const literalHash = hasFragment ? "#" + fragmentText : "";
			return (
				context.prefix.href +
				rewriteBlob(objectUrl, context, meta) +
				"?" +
				QP.fakeDataURL +
				"=1" +
				literalHash
			);
		}

		/*
		 * Encoded with the same codec ordinary URLs use, not concatenated raw.
		 *
		 * A data: URL is opaque, but appending it to the prefix put it in a PATH
		 * position, where the browser owns the bytes: `data:/../` had its `..`
		 * resolved away, which removed the `data:` segment and left a bare prefix
		 * that could not be decoded at all.
		 *
		 * The codec already produces a path-safe token for every other URL and is
		 * reversible over these bytes, so there is no second wire format here: the
		 * decoder reads it back through the ordinary path and recovers the `data:`
		 * scheme from the decoded value.
		 */
		return context.prefix.href + encodedPayload + encodedHash;
	} else if (
		String_startsWith(url, "mailto:") ||
		String_startsWith(url, "about:")
	) {
		return url;
	} else {
		let base = meta.base.href;

		if (String_startsWith(base, "about:"))
			base = unrewriteUrl(self.location.href, context); // jank!!!!! weird jank!!!
		const realUrl = tryCanParseURL(url, base);
		if (!realUrl) return url;

		if (realUrl.protocol != "http:" && realUrl.protocol != "https:") {
			// custom protocol. best thing to do is pass it through so it can open an app etc
			// there's also extension:// pages we might need to worry about later
			return url;
		}

		const encodedHash = context.interface.codecEncode(realUrl.hash.slice(1));
		const realHash = encodedHash ? "#" + encodedHash : "";
		realUrl.hash = "";

		const paramsInit = new _URLSearchParams();

		const referrerPolicy =
			!options?.isModule && (options?.referrerPolicy ?? meta.referrerPolicy);
		if (referrerPolicy) paramsInit.set(QP.referrerPolicy, referrerPolicy);
		if (options?.isModule) paramsInit.set(QP.isModule, "module");
		if (options?.topFrame) paramsInit.set(QP.topFrame, options.topFrame);
		if (options?.parentFrame)
			paramsInit.set(QP.parentFrame, options.parentFrame);
		if (options?.isIframe) paramsInit.set(QP.isIframe, options.isIframe);
		if (options?.mode) paramsInit.set(QP.mode, options.mode);
		if (options?.credentials)
			paramsInit.set(QP.credentials, options.credentials);
		if (options?.destination)
			paramsInit.set(QP.destination, options.destination);
		if (options?.workerName !== undefined)
			paramsInit.set(QP.workerName, options.workerName);
		if (options?.workerCorrelation !== undefined)
			paramsInit.set(QP.workerCorrelation, options.workerCorrelation);

		// specific tracking for sec-fetch-site
		// don't send for the top level controller calling it in go()
		if (meta.origin.origin !== context.prefix.origin) {
			paramsInit.set(
				QP.initiatorOrigin,
				options?.isModule ? realUrl.origin : meta.origin.origin
			);
		}

		let paramstring = "";
		if (paramsInit.toString()) paramstring = "?" + paramsInit.toString();

		return (
			context.prefix.href +
			context.interface.codecEncode(realUrl.href) +
			paramstring +
			realHash
		);
	}
}

export function unrewriteUrl(url: string | URL, context: ScramjetContext) {
	url = String(url);
	if (String_startsWith(url, "javascript:")) {
		//TODO
		return url;
	} else if (String_startsWith(url, "blob:")) {
		// realistically this shouldn't happen
		return url;
	} else if (String_startsWith(url, context.prefix.href + "blob:")) {
		return url.substring(context.prefix.href.length);
	} else if (
		String_startsWith(url, "mailto:") ||
		String_startsWith(url, "about:")
	) {
		return url;
	} else if (
		String_startsWith(url, "http:") ||
		String_startsWith(url, "https:")
	) {
		const realUrl = tryCanParseURL(url);
		if (!realUrl) return url;
		if (realUrl.protocol != "http:" && realUrl.protocol != "https:") {
			// custom protocol
			return url;
		}
		if (!String_startsWith(realUrl.href, context.prefix.href)) {
			dbg.error("unrewriteurl: unexpected url", url);
			return url;
		}
		// Presence is read from the physical href, not from `.hash` truthiness: an
		// empty fragment is `""` either way, and dropping it here would turn `…#`
		// back into `…`, losing a delimiter the producer deliberately emitted.
		const hadHash = realUrl.href.indexOf("#") !== -1;
		const decodedHash = context.interface.codecDecode(realUrl.hash.slice(1));
		const realHash = hadHash ? "#" + decodedHash : "";
		realUrl.hash = "";
		realUrl.search = "";

		return (
			context.interface.codecDecode(
				realUrl.href.slice(context.prefix.href.length)
			) + realHash
		);
	} else if (url == "") {
		return url;
	} else {
		dbg.error("unrewriteurl: unexpected url", url);
		return url;
	}
}
