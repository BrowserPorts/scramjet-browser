import { Object_entries, Object_keys, _URL, Error } from "@/shared/snapshot";
import { unrewriteUrl, URLMeta } from "@rewriters/url";
import { ScramjetDestination } from "@/types";
import {
	ScramjetFetchHandler,
	ScramjetFetchParsed,
	ScramjetFetchRequest,
	ScramjetFetchTrackedClient,
} from ".";

export const QP = {
	referrerPolicy: "$rfp",
	referrerSource: "$rfs",
	isModule: "$module",
	topFrame: "$tf",
	parentFrame: "$pf",
	isIframe: "$iframe",
	mode: "$mode",
	credentials: "$cred",
	destination: "$dest",
	initiatorOrigin: "$io",
	fetchSite: "$fs",
	crossSiteRedirect: "$csr",
	fakeDataURL: "$fakedataurl",
	workerName: "$wname",
	workerCorrelation: "$wcorr",
} as const;

export type QueryParamKey = keyof typeof QP;

export type QueryParams = Partial<Record<QueryParamKey, string>>;

// The page's intended RequestInit.mode, captured client-side (fetch/Request
// proxies stamp `init.mode ?? "cors"` onto the proxy URL) and read back by
// parseRequest. Besides the standard modes, parseRequest passes through the
// raw `$mode` query value (and `request.mode` for shared workers), so the
// type admits arbitrary strings while keeping literal completions.
export type ScramjetRequestMode = RequestMode | (string & {});

const QP_INVERSE: Record<string, QueryParamKey> = (() => {
	const inv: Record<string, QueryParamKey> = {};
	for (const key of Object_keys(QP) as QueryParamKey[]) {
		inv[QP[key]] = key;
	}
	return inv;
})();

export function parseQueryParams(searchParams: URLSearchParams): {
	params: QueryParams;
	extras: Record<string, string>;
} {
	const params: QueryParams = {};
	const extras: Record<string, string> = {};
	for (const [key, value] of [...searchParams.entries()]) {
		const logical = QP_INVERSE[key];
		if (logical) {
			params[logical] = value;
		} else {
			dbg.warn(
				`extraneous query parameter ${key}=${value}. Assuming <form> element`
			);
			extras[key] = value;
		}
	}
	return { params, extras };
}

export function parseRequest(
	request: ScramjetFetchRequest,
	handler: ScramjetFetchHandler
): ScramjetFetchParsed {
	const strippedUrl = new _URL(request.rawUrl.href);
	const { params, extras } = parseQueryParams(request.rawUrl.searchParams);
	strippedUrl.search = "";

	const hadExtraParams = Object_keys(extras).length > 0;

	let decodedUrl = unrewriteUrl(strippedUrl, handler.context);
	if (
		!_URL.canParse(decodedUrl) &&
		strippedUrl.href.startsWith(handler.context.prefix.href)
	) {
		const rawBase =
			request.rawClientUrl ||
			(request.rawReferrer ? new _URL(request.rawReferrer) : undefined);
		const decodedBase = rawBase
			? unrewriteUrl(rawBase, handler.context)
			: undefined;
		const relativePath = strippedUrl.href.slice(
			handler.context.prefix.href.length
		);
		if (decodedBase && _URL.canParse(relativePath, decodedBase)) {
			decodedUrl = new _URL(relativePath, decodedBase).href;
		}
	}

	if (!_URL.canParse(decodedUrl)) {
		throw new Error(`unable to parse rewritten url: ${strippedUrl.href}`);
	}
	const url = new _URL(decodedUrl);

	if (url.origin === new _URL(request.rawUrl).origin) {
		// uh oh!
		throw new Error(
			"attempted to fetch from same origin - this means the site has obtained a reference to the real origin, aborting"
		);
	}

	for (const [key, value] of Object_entries(extras)) {
		url.searchParams.set(key, value);
	}

	const clientId = request.clientId;
	let trackedClient: ScramjetFetchTrackedClient | undefined;
	if (clientId) {
		trackedClient = handler.trackedClients.get(clientId);
		if (!trackedClient) {
			trackedClient = new ScramjetFetchTrackedClient(clientId);
			handler.trackedClients.set(clientId, trackedClient);
		}
	}

	const referrerSourceUrl =
		params.referrerSource === undefined
			? undefined
			: params.referrerSource
				? new _URL(params.referrerSource)
				: null;

	const fetchSiteState =
		params.fetchSite === "same-origin" ||
		params.fetchSite === "same-site" ||
		params.fetchSite === "cross-site"
			? params.fetchSite
			: undefined;

	const nativeSharedWorker = request.rawDestination === "sharedworker";
	const fetchMode = ["cors", "no-cors", "same-origin", "navigate"].includes(
		params.mode
	)
		? params.mode
		: nativeSharedWorker ? request.mode : undefined;
	const fetchCredentials =
		params.credentials === "include" ||
		params.credentials === "omit" ||
		params.credentials === "same-origin"
			? params.credentials
			: nativeSharedWorker ? request.rawCredentials : undefined;
	const destination =
		(params.destination as ScramjetDestination | undefined) ||
		request.rawDestination;

	const meta: URLMeta = {
		origin: url,
		base: url,
		topFrameName: params.topFrame,
		parentFrameName: params.parentFrame,
		referrerPolicy: params.referrerPolicy,
	};

	const parsed: ScramjetFetchParsed = {
		meta,
		url,
		isModule: params.isModule === "module",
		referrerPolicy: params.referrerPolicy,
		referrerSourceUrl,
		trackedClient,
		hadExtraParams,
		crossSiteRedirect: params.crossSiteRedirect === "1",
		fetchSiteState,
		fetchInitiatorOrigin: params.initiatorOrigin || undefined,
		fetchCredentials,
		fetchCredentialsInclude: fetchCredentials === "include",
		fetchMode,
		destination,
		isIframe: params.isIframe === "1",
		isFakeDataURL: params.fakeDataURL === "1",
		workerName: params.workerName,
		workerCorrelation: params.workerCorrelation,
	};

	if (request.rawClientUrl) {
		parsed.clientUrl = new _URL(
			unrewriteUrl(request.rawClientUrl, handler.context)
		);
	}

	return parsed;
}
