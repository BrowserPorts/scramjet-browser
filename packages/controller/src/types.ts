import type { RawHeaders } from "@mercuryworkshop/proxy-transports";
import type {
	CookieSyncOptions,
	ScramjetClient,
	ScramjetDestination,
} from "@mercuryworkshop/scramjet";
import type { Frame } from ".";
import type { SerializedCookieSyncEntry } from "@mercuryworkshop/rpc";
export type {
	ControllerToTransport,
	CookieSyncSink,
	CookieSyncUpdate,
	SerializedCookieSyncEntry,
	TransportToController,
	WebSocketData,
	WebSocketMessage,
} from "@mercuryworkshop/rpc";
import type { CONTROLLERFRAME } from "./symbols";
export type BodyType =
	| string
	| ArrayBuffer
	| Blob
	| ReadableStream<Uint8Array<ArrayBufferLike>>;

export type TransferRequest = {
	rawUrl: string;
	rawReferrer: string | null;
	destination: ScramjetDestination;
	mode: RequestMode;
	credentials?: RequestCredentials;
	referrer: string;
	method: string;
	body: BodyType | null;
	cache: RequestCache;
	forceCrossOriginIsolated: boolean;
	initialHeaders: RawHeaders;
	rawClientUrl?: string;
	clientId?: string;
	sourceClientId?: string;
	resultingClientId?: string;
};

export type TransferResponse = {
	body: BodyType;
	headers: RawHeaders;
	status: number;
	statusText: string;
};

export type ControllerDetachRequest = {
	id: string;
};

export type ControllerDetachResponse = {
	id: string;
	detached: boolean;
};

export type ControllerReadyPayload = {
	workerId: string;
	connectionId?: string;
};

export type Controllerbound = {
	ready: [ControllerReadyPayload | undefined];
	request: [TransferRequest, TransferResponse];
	initRemoteTransport: [{ port: MessagePort; prefix: string }];
};

export type SWbound = {
	sendSetCookie: [
		{
			cookies: SerializedCookieSyncEntry[];
			options?: CookieSyncOptions;
		},
	];
};

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

export type FrameLifecycleHooks = {
	/** Release plugin resources before the controller drops its frame and ports */
	close: {
		context: { frame: Frame };
		props: {};
	};
};

declare global {
	interface HTMLIFrameElement {
		[CONTROLLERFRAME]?: Frame;
	}
}
