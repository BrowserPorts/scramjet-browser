// The minimal client's public types, kept here so its declarations stand alone without the rest of
// Scramjet or the proxy-transports package

export type RawHeaders = [string, string][];
export type WebSocketDataType = Blob | ArrayBuffer | string;
export type TransferrableResponse = {
	body: ReadableStream | ArrayBuffer | Blob | string | null;
	headers: RawHeaders;
	status: number;
	statusText: string;
};

/** A Wisp transport, such as libcurl-transport or epoxy-transport */
export interface ProxyTransport {
	init: () => Promise<void>;
	ready: boolean;
	connect: (
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: WebSocketDataType) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void
	) => [(data: WebSocketDataType) => void, (code: number, reason: string) => void];
	request: (
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		signal: AbortSignal | undefined
	) => Promise<TransferrableResponse>;
}

/** A socket over the transport, as BareCompatibleClient opens one */
export interface TransportSocket extends EventTarget {
	readyState: number;
	protocol: string;
	extensions: string;
	send(data: WebSocketDataType): Promise<void>;
	close(code: number, reason: string): void;
}

/** What a Proxy handler sees of an intercepted call or construction */
export type ProxyCtx = {
	fn: any;
	this: any;
	args: any[];
	newTarget: any;
	/** Answers the call with this value instead of running the original */
	return: (value: any) => void;
	/** Runs the original now and answers with its result */
	call: () => any;
};

export type ProxyHooks = {
	construct?(ctx: ProxyCtx): any;
	apply?(ctx: ProxyCtx): any;
};

/** What a Trap handler sees of an intercepted property */
export type TrapCtx = {
	this: any;
	get: () => any;
	set: (value: any) => void;
};

export type TrapHooks = {
	enumerable?: boolean;
	configurable?: boolean;
	get?: (ctx: TrapCtx) => any;
	set?: (ctx: TrapCtx, value: any) => void;
};
