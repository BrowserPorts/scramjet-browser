import {
	BareCompatibleClient,
	type BareRequestInit,
	type BareResponse,
	type ProxyTransport,
} from "@mercuryworkshop/proxy-transports";

import type { URLMeta } from "@rewriters/url";
import type { ScramjetRequestMode } from "./parse";

export { QP } from "./parse";

import type {
	HtmlRewriterHooks,
	ScramjetContext,
	ScriptRewriterHooks,
} from "@/shared";
import type { ScramjetHeaders } from "@/shared/headers";
import { _Map, type _URL } from "@/shared/snapshot";
import { Tap, type TapInstance } from "@/Tap";
import type { ScramjetDestination } from "@/types";
import { doHandleFetch } from "./fetch";

export interface ScramjetFetchRequest {
	rawUrl: URL;
	rawReferrer: string | null;
	// use parsed.destination instead
	rawDestination: ScramjetDestination;
	mode: RequestMode;
	referrer: string;
	method: string;
	body: BodyType | null;
	cache: RequestCache;

	initialHeaders: ScramjetHeaders;

	rawClientUrl?: URL;

	/** The service worker FetchEvent.clientId that originated this request. */
	clientId: string;
	/** Existing client that initiated a navigation, when the platform supplies one. */
	sourceClientId?: string;
	/** Client created by a navigation, before its response document executes. */
	resultingClientId?: string;
}

export interface ScramjetFetchParsed {
	url: _URL;
	clientUrl?: _URL;
	referrerSourceUrl?: _URL | null;
	hadExtraParams: boolean;
	crossSiteRedirect: boolean;

	// track the worst case Sec-Fetch-Site classification through redirects
	fetchSiteState?: "same-origin" | "same-site" | "cross-site";

	// origin of the page that initialized the request
	// specifically for tracking Sec-Fetch-Site, don't use for anything else, it will diverge from clientUrl in some cases
	fetchInitiatorOrigin?: string;

	// was the request made with credentials=include?
	fetchCredentialsInclude?: boolean;

	// tracks RequestInit.mode if set
	fetchMode?: ScramjetRequestMode;

	// was this request made by an iframe? (scramjet's definition of an iframe, not the browser's)
	isIframe?: boolean;

	// request.destination, but is overridden by $dest
	destination: ScramjetDestination;

	meta: URLMeta;
	isModule: boolean;
	isFakeDataURL: boolean;
	referrerPolicy?: string;
	trackedClient?: ScramjetFetchTrackedClient;

}

export interface ScramjetFetchResponse {
	body: BodyType;
	headers: ScramjetHeaders;
	status: number;
	statusText: string;
}

export type CookieSyncEntry = {
	url: URL;
	cookie: string;
};

export type CookieSyncOptions = {
	clear?: boolean;
	destination?: ScramjetDestination;
};

export type FetchHandlerInit = {
	transport: ProxyTransport;
	context: ScramjetContext;
	crossOriginIsolated?: boolean;

	sendSetCookie: (
		cookies: CookieSyncEntry[],
		options?: CookieSyncOptions,
	) => Promise<void>;
	fetchDataUrl(dataUrl: string): Promise<BareResponse>;
	fetchBlobUrl(blobUrl: string): Promise<BareResponse>;
};

export type TrackedHistoryState = {
	url: string;
	referrer: string;
};
export class ScramjetFetchTrackedClient {
	history: TrackedHistoryState[] = [];
	constructor(public clientId: string) {}
}

// eslint-disable-next-line scramjet-core/no-globals
export class ScramjetFetchHandler extends EventTarget {
	public client: BareCompatibleClient;
	public crossOriginIsolated: boolean = false;
	public context: ScramjetContext;

	// annotated because the wrapped type can't be named from the emitted d.ts,
	// which drops this whole module from the public types
	public trackedClients: Map<string, ScramjetFetchTrackedClient> = new _Map<
		string,
		ScramjetFetchTrackedClient
	>();

	public hooks: {
		rewriter: {
			html: TapInstance<HtmlRewriterHooks>;
			script: TapInstance<ScriptRewriterHooks>;
		};
		fetch: TapInstance<FetchHooks>;
	};

	public fetchDataUrl: (dataUrl: string) => Promise<Response>;
	public fetchBlobUrl: (blobUrl: string) => Promise<Response>;
	public sendSetCookie: (
		cookies: CookieSyncEntry[],
		options?: CookieSyncOptions,
	) => Promise<void>;

	constructor(init: FetchHandlerInit) {
		super();
		this.client = new BareCompatibleClient(init.transport);
		this.context = init.context;
		this.crossOriginIsolated = init.crossOriginIsolated || false;
		this.sendSetCookie = init.sendSetCookie;
		this.fetchDataUrl = init.fetchDataUrl;
		this.fetchBlobUrl = init.fetchBlobUrl;
		this.hooks = {
			rewriter: {
				html: Tap.create<HtmlRewriterHooks>(),
				script: Tap.create<ScriptRewriterHooks>(),
			},
			fetch: Tap.create<FetchHooks>(),
		};
		this.context.hooks = {
			rewriter: this.hooks.rewriter,
		};
	}

	async handleFetch(
		request: ScramjetFetchRequest,
	): Promise<ScramjetFetchResponse> {
		return doHandleFetch(this, request);
	}

}
export type FetchHooks = {
	intercept: {
		context: {
			request: ScramjetFetchRequest;
			parsed: ScramjetFetchParsed;
		};
		props: {
			response?: ScramjetFetchResponse;
		};
	};
	request: {
		context: {
			request: ScramjetFetchRequest;
			parsed: ScramjetFetchParsed;
			client: BareCompatibleClient;
		};
		props: {
			init: BareRequestInit;
			url: URL;
			earlyResponse?: BareResponse;
		};
	};
	preresponse: {
		context: {
			request: ScramjetFetchRequest;
			parsed: ScramjetFetchParsed;
		};
		props: {
			response: BareResponse;
		};
	};
	response: {
		context: {
			request: ScramjetFetchRequest;
			parsed: ScramjetFetchParsed;
		};
		props: {
			response: ScramjetFetchResponse;
		};
	};
	/**
	 * Dispatched when the pipeline rejects without producing a response, so an
	 * embedder can report the failed load. The rejection is rethrown after the
	 * hook runs; a tap here never turns a failure into a success.
	 */
	error: {
		context: {
			request: ScramjetFetchRequest;
			parsed: ScramjetFetchParsed;
		};
		props: {
			error: Error;
		};
	};
	/**
	 * Dispatched with the rewritten body of a "worker" or "sharedworker"
	 * destination script before it is returned. `body` is the rewritten worker
	 * script (inject scripts plus the rewritten author source), `source` is the
	 * decoded author source, and `inject` is the inject-script prelude alone. A
	 * tap replaces the body only by setting `replacement`; a tap rejection
	 * rejects the fetch (there is no fall-through to the rewritten body).
	 */
	worker: {
		context: {
			request: ScramjetFetchRequest;
			parsed: ScramjetFetchParsed;
		};
		props: {
			body: string;
			contentType: string;
			inject: string;
			source: string;
			replacement?: string;
		};
	};
};

export type BodyType = string | ArrayBuffer | Blob | ReadableStream<any>;
