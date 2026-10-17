import type {
	RawHeaders,
	TransferrableResponse,
} from "@mercuryworkshop/proxy-transports";
import type {
	CookieSyncOptions,
	ScramjetClient,
	ScramjetDestination,
	ScramjetStorageMutation,
} from "@mercuryworkshop/scramjet";
import type { Frame } from ".";
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

export type SerializedCookieSyncEntry = {
	url: string;
	cookie: string;
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

export type TransportToController = {
	request: [
		{
			remote: string;
			method: string;
			body: BodyInit | null;
			headers: RawHeaders;
			proxy?: string | null;
			// signal: AbortSignal | undefined
		},
		TransferrableResponse,
	];
	sendSetCookie: [
		{
			cookies: SerializedCookieSyncEntry[];
			options?: CookieSyncOptions;
		},
	];
	sendStorageMutation: [
		{
			mutations: ScramjetStorageMutation[];
		},
	];
	connect: [
		{
			url: string;
			protocols: string[];
			requestHeaders: RawHeaders;
			port: MessagePort;
			proxy?: string | null;
		},
		(
			| {
					result: "success";
					protocol: string;
					extensions: string;
			  }
			| {
					result: "failure";
					error: string;
			  }
		),
	];
};

export type ControllerToTransport = {
	ready: [];
};
export type WebSocketData = string | ArrayBuffer | Blob;
export type WebSocketMessage =
	| {
			type: "data";
			data: WebSocketData;
	  }
	| {
			type: "close";
			code: number;
			reason: string;
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

declare global {
	interface HTMLIFrameElement {
		[CONTROLLERFRAME]?: Frame;
	}
}
