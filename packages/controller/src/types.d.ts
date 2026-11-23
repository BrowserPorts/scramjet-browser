import type { RawHeaders } from "@mercuryworkshop/proxy-transports";
import type { CONTROLLERFRAME } from "./symbols";
import type { Frame } from ".";
export type BodyType =
	| string
	| ArrayBuffer
	| Blob
	| ReadableStream<Uint8Array<ArrayBufferLike>>;

export type TransferRequest = {
	rawUrl: string;
	rawReferrer: string | null;
	rawReferrerPolicy?: ReferrerPolicy;
	destination: RequestDestination;
	mode: RequestMode;
	referrer: string;
	method: string;
	body: BodyType | null;
	cache: RequestCache;
	forceCrossOriginIsolated: boolean;
	initialHeaders: RawHeaders;
	rawClientUrl?: string;
	clientId?: string;
};

export type TransferResponse = {
	body: BodyType;
	headers: RawHeaders;
	status: number;
	statusText: string;
};

export type Controllerbound = {
	ready: [];
	request: [TransferRequest, TransferResponse];
	initRemoteTransport: [MessagePort];
};

export type SWbound = {
	sendSetCookie: [
		{
			cookies: SerializedCookieSyncEntry[];
			options?: CookieSyncOptions;
		},
	];
};

// the messages a page's transport port carries are the rpc package's, which
// the controller, the injected client and the runtimes share
export type {
	ControllerToTransport,
	SerializedCookieSyncEntry,
	TransportToController,
	WebSocketData,
	WebSocketMessage,
} from "@mercuryworkshop/rpc";
import type { SerializedCookieSyncEntry } from "@mercuryworkshop/rpc";

export type FrameInitHooks = {
	pre: {
		context: {
			window: Window;
			client: ScramjetClient;
			isTopLevel: boolean;
		};
		props: {};
	};
	post: {
		context: {
			window: Window;
			client: ScramjetClient;
			isTopLevel: boolean;
		};
		props: {};
	};
};

export type FrameLifecycleHooks = {
	/** Release a plugin's resources before the controller drops its frame and ports */
	close: {
		context: { frame: Frame };
		props: {};
	};
};

export type FrameErrorHooks = {
	request: {
		context: {
			rawrequest: TransferRequest;
			error: unknown;
		};
		props: {
			setResponse?: TransferResponse;
			suppressError?: boolean;
		};
	};
};

declare global {
	interface HTMLIFrameElement {
		[CONTROLLERFRAME]?: Frame;
	}
}
