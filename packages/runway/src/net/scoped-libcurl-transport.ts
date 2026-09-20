/**
 * A transport that reaches the WPT origins over real HTTPS by giving the patched
 * libcurl fork a run-scoped CA, and refuses to run on anything else.
 *
 * WHY THIS EXISTS RATHER THAN CONFIGURING THE INSTALLED TRANSPORT
 * --------------------------------------------------------------
 * `@mercuryworkshop/libcurl-transport@2.0.5` bundles its own libcurl build and
 * its public options are `{wisp, websocket, proxy, transport, connections}`.
 * There is no trust option to set, and its `connect()` uses the module-global
 * `libcurl.WebSocket`, which always carries default trust. So a scoped run needs
 * a transport that constructs the patched sessions itself. This is that, and it
 * is deliberately small: it mirrors 2.0.5's observable contract and adds trust.
 *
 * WHAT IT COPIES AND WHAT IT DOES NOT
 * -----------------------------------
 * The request/connect shapes are taken from the pinned 2.0.5 source, which is
 * authoritative for the contract Scramjet's BareCompatibleClient consumes:
 *
 *   request(remote, method, body, headers, signal) -> {body, headers, status, statusText}
 *   connect(url, protocols, headers, onopen, onmessage, onclose, onerror) -> [send, close]
 *
 * No copyrighted implementation was copied: the bodies here are written against
 * that observable contract. The libcurl fork itself is vendored separately with
 * its own provenance and licence record (`vendor/libcurl.js/`), stays optional,
 * and is loaded by dynamic import.
 *
 * REDIRECTS
 * ---------
 * `redirect: "manual"`, exactly as 2.0.5 does. The 3xx hop is returned to the
 * caller untouched; Scramjet decides policy and issues the next request, which
 * re-enters here and is re-checked against the allowlist before any TLS for that
 * hop. This transport implements no second Fetch policy of its own.
 *
 * TRUST BOUNDARIES
 * ----------------
 * - The CA is run-scoped and per session. It is never installed anywhere ambient
 *   and never becomes page-global.
 * - The allowlist is supplied explicitly by the caller and frozen. Nothing is
 *   derived from a certificate's SANs and no suffix wildcard is implied.
 * - HTTP and WSS both go through sessions constructed with the same explicit
 *   options, so an allowlisted `wss://` handshake is scoped too.
 * - The OUTER Wisp WebSocket to the proxy is established by the browser and
 *   validated against the browser's trust store. Nothing here affects it, by
 *   design.
 * - Raw `TLSSocket` is not part of the transport contract and is not wired. That
 *   is an explicit exclusion, not an unimplemented hook.
 *
 * This file makes no claim about TLS conformance. It is source and contract
 * work; the fork's runtime behaviour is unproven until it is built and gated.
 */

/** Header map as the transport contract delivers it. */
export type RawHeaders = Record<string, string | string[]>;

/** The response shape the contract expects back. */
export type TransferrableResponse = {
	readonly body: ReadableStream<Uint8Array> | null;
	readonly headers: RawHeaders;
	readonly status: number;
	readonly statusText: string;
};

/** Immutable trust configuration for one run. */
export type ScopedTrust = {
	/** PEM bundle for the run-scoped CA. Never empty. */
	readonly caPem: string;
	/**
	 * Exact hostnames that may use it. Supplied by the caller from the live
	 * server configuration; never derived from certificate SANs and never
	 * treated as a suffix pattern.
	 */
	readonly hosts: readonly string[];
};

export type ScopedLibcurlOptions = {
	readonly wisp: string;
	readonly trust: ScopedTrust;
	readonly websocket?: string;
	readonly proxy?: string;
	readonly connections?: readonly number[];
};

/* -------------------------------------------------------------------------- */
/* the fork ABI, as this adapter requires it                                  */
/* -------------------------------------------------------------------------- */

/** One HTTP response as the patched `HTTPSession.fetch` resolves it. */
type ForkResponse = {
	body: ReadableStream<Uint8Array> | null;
	raw_headers: RawHeaders;
	status: number;
	statusText: string;
};

type ForkRequestInit = {
	method: string;
	headers: Record<string, string>;
	body: BodyInit | null;
	redirect: "manual";
	signal?: AbortSignal;
};

/** The session surface this adapter uses. `trust_scope` exists only on the fork. */
export type ForkHttpSession = {
	fetch(url: string, init: ForkRequestInit): Promise<ForkResponse>;
	close(): void;
	readonly trust_scope: { readonly hosts: readonly string[] } | null;
};

export type ForkWebSocket = {
	binaryType: string;
	onopen: ((event: unknown) => void) | null;
	onclose: ((event: { code: number; reason: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onmessage: ((event: { data: ArrayBuffer | string | Blob }) => void) | null;
	send(data: ArrayBuffer | string | Blob): void;
	close(code?: number, reason?: string): void;
};

type SessionOptions = {
	cacert: string;
	cacert_hosts: readonly string[];
	proxy?: string;
};

/** The module shape a patched libcurl build must expose. */
export type ForkModule = {
	load_wasm(): Promise<void>;
	set_websocket(url: string): void;
	transport: string;
	HTTPSession: new (options: SessionOptions) => ForkHttpSession;
	WebSocket: new (
		url: string,
		protocols: string[],
		options: SessionOptions & { headers: Record<string, string> }
	) => ForkWebSocket;
};

/** Raised when the loaded module cannot provide scoped trust. */
export class ForkUnavailable extends Error {
	constructor(reason: string) {
		super(
			`scoped libcurl transport unavailable: ${reason}. Refusing to fall back to ` +
				`a default-trust transport, because that would silently test a different ` +
				`thing than the run asked for`
		);
		this.name = "ForkUnavailable";
	}
}

/* -------------------------------------------------------------------------- */
/* validation and the ABI gate                                               */
/* -------------------------------------------------------------------------- */

/**
 * Canonical host form. Mirrors the fork's own normalisation so the allowlist this
 * adapter reports and the one the fork enforces cannot disagree.
 *
 * @param value - Hostname to canonicalise.
 * @returns Canonical lowercase hostname, or null when unusable.
 */
export function canonicalHost(value: string): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	if (value.includes("\0")) return null;
	if (/[/\\?#@\s]/.test(value)) return null;

	// Bare-host syntax is checked BEFORE parsing. `new URL("https://h:8443").hostname`
	// silently discards the port, so accepting a value with one here would let the
	// adapter admit `host:8443` while the fork rejects it.
	if (value.startsWith("[")) {
		if (value.indexOf("]") !== value.length - 1) return null;
		if (value.includes("[", 1)) return null;
	} else if (value.includes(":")) {
		return null;
	}

	try {
		const parsed = new URL(`https://${value}`);
		if (parsed.port !== "" || parsed.username !== "" || parsed.password !== "") return null;
		if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return null;
		const host = parsed.hostname;
		return host.length === 0 ? null : host.toLowerCase().replace(/\.$/, "");
	} catch {
		return null;
	}
}

/**
 * Validates and freezes the run's trust configuration.
 *
 * Every rejection here happens before anything is constructed, so a malformed
 * allowlist cannot leave a session or a registered CA behind.
 *
 * @param trust - Caller-supplied trust configuration.
 * @returns A frozen, canonicalised copy.
 * @throws TypeError on any ambiguity.
 */
export function freezeTrust(trust: ScopedTrust): ScopedTrust {
	if (trust === null || typeof trust !== "object") {
		throw new TypeError("trust must be an object");
	}
	const { caPem, hosts } = trust;
	if (typeof caPem !== "string") throw new TypeError("trust.caPem must be a string");
	if (caPem.length === 0) throw new TypeError("trust.caPem must not be empty");
	if (caPem.includes("\0")) throw new TypeError("trust.caPem must not contain NUL");
	if (!/-----BEGIN CERTIFICATE-----/.test(caPem)) {
		throw new TypeError("trust.caPem must contain a PEM certificate");
	}
	if (!Array.isArray(hosts)) throw new TypeError("trust.hosts must be an array");
	if (hosts.length === 0) throw new TypeError("trust.hosts must not be empty");

	const canonical: string[] = [];
	for (const entry of hosts) {
		const host = canonicalHost(entry as string);
		if (host === null) {
			throw new TypeError(`trust.hosts contains an invalid hostname: ${String(entry)}`);
		}
		if (!canonical.includes(host)) canonical.push(host);
	}
	return Object.freeze({ caPem, hosts: Object.freeze(canonical) });
}

/**
 * Proves the loaded module really is a patched fork before anything depends on
 * it, by constructing a throwaway scoped session and reading back the scope.
 *
 * An unpatched build ignores the options (its classes call `super()` and drop
 * them), so `trust_scope` is absent or null and this fails closed rather than
 * quietly using default trust.
 *
 * @param module_ - The loaded libcurl module.
 * @param trust - The frozen trust configuration to probe with.
 * @returns Nothing; throws when the module is not usable.
 * @throws ForkUnavailable when the scoped-trust ABI is missing or inert.
 */
export function assertForkAbi(module_: ForkModule, trust: ScopedTrust): void {
	if (typeof module_?.HTTPSession !== "function") {
		throw new ForkUnavailable("the module exposes no HTTPSession constructor");
	}
	let probe: ForkHttpSession;
	try {
		probe = new module_.HTTPSession({
			cacert: trust.caPem,
			cacert_hosts: trust.hosts,
		});
	} catch (cause) {
		throw new ForkUnavailable(
			`HTTPSession rejected scoped trust options (${(cause as Error).message})`
		);
	}
	try {
		const scope = probe.trust_scope;
		if (scope === undefined) {
			throw new ForkUnavailable(
				"HTTPSession has no trust_scope: this is an unpatched libcurl build"
			);
		}
		if (scope === null) {
			throw new ForkUnavailable(
				"HTTPSession accepted the options but reports no scope: the trust option " +
					"did not reach the session, which is the unpatched super() behaviour"
			);
		}
		const missing = trust.hosts.filter((h) => !scope.hosts.includes(h));
		if (missing.length > 0) {
			throw new ForkUnavailable(
				`HTTPSession scope is missing hosts: ${missing.join(", ")}`
			);
		}
	} finally {
		probe.close();
	}
}

/* -------------------------------------------------------------------------- */
/* the transport                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Flattens contract headers for the fork's single-valued header option.
 *
 * The pinned 2.0.5 assigns arrays straight onto a plain object, which the C side
 * then skips because it is not a JSON string, so a multi-valued request header is
 * silently dropped. Here they are combined per RFC 9110 field-value rules
 * instead, which is lossy in the same place the underlying option is lossy but
 * never silently drops the header.
 *
 * @param headers - Contract headers.
 * @returns Single-valued header object.
 */
export function flattenHeaders(headers: RawHeaders): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		out[key] = Array.isArray(value) ? value.join(", ") : value;
	}
	return out;
}

/**
 * The transport. One instance owns one scoped HTTP session plus any live
 * websockets, and disposing it cancels them before trust is released.
 */
export class ScopedLibcurlTransport {
	readonly #options: ScopedLibcurlOptions;
	readonly #trust: ScopedTrust;
	readonly #module: ForkModule;
	#session: ForkHttpSession | null = null;
	#sockets = new Set<ForkWebSocket>();
	#closed = false;
	ready = false;

	/**
	 * @param module_ - A loaded patched libcurl module.
	 * @param options - Immutable run options including the scoped trust.
	 */
	constructor(module_: ForkModule, options: ScopedLibcurlOptions) {
		if (!options || typeof options.wisp !== "string" || options.wisp.length === 0) {
			throw new TypeError("options.wisp is required");
		}
		this.#trust = freezeTrust(options.trust);
		this.#options = Object.freeze({ ...options, trust: this.#trust });
		this.#module = module_;
		// Gate before anything else can depend on the module being a fork.
		assertForkAbi(module_, this.#trust);
	}

	/** The frozen allowlist this transport will scope. */
	get trustedHosts(): readonly string[] {
		return this.#trust.hosts;
	}

	/**
	 * Loads the wasm, points the module at the Wisp proxy and opens the scoped
	 * session.
	 *
	 * @returns Resolves once the transport can serve requests.
	 */
	async init(): Promise<void> {
		if (this.#closed) throw new Error("transport already disposed");
		await this.#module.load_wasm();
		this.#module.set_websocket(this.#options.websocket ?? this.#options.wisp);
		this.#session = new this.#module.HTTPSession({
			cacert: this.#trust.caPem,
			cacert_hosts: this.#trust.hosts,
			...(this.#options.proxy === undefined ? {} : { proxy: this.#options.proxy }),
		});
		if (this.#session.trust_scope === null) {
			this.#session.close();
			this.#session = null;
			throw new ForkUnavailable("the session opened without the requested scope");
		}
		this.ready = true;
	}

	/** Present for contract parity with the pinned transport. */
	async meta(): Promise<void> {}

	/**
	 * Performs one hop. 3xx responses are returned as-is.
	 *
	 * @param remote - Absolute target URL.
	 * @param method - HTTP method.
	 * @param body - Request body, or null.
	 * @param headers - Contract headers.
	 * @param signal - Optional cancellation signal.
	 * @returns The response for this hop, redirects included.
	 */
	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		signal: AbortSignal | undefined
	): Promise<TransferrableResponse> {
		const session = this.#session;
		if (session === null || !this.ready) {
			throw new Error("transport is not initialised");
		}
		// Options are rebuilt per request from the frozen config, so scope is
		// re-evaluated by the fork for every hop rather than cached per host.
		const payload = await session.fetch(remote.href, {
			method,
			headers: flattenHeaders(headers),
			body,
			redirect: "manual",
			...(signal === undefined ? {} : { signal }),
		});
		return {
			body: payload.body,
			headers: payload.raw_headers,
			status: payload.status,
			statusText: payload.statusText,
		};
	}

	/**
	 * Opens a websocket through a session carrying the same scoped trust, so an
	 * allowlisted `wss://` handshake is verified against the run CA.
	 *
	 * @param url - Target websocket URL.
	 * @param protocols - Requested subprotocols.
	 * @param requestHeaders - Contract headers for the handshake.
	 * @param onopen - Called with (protocol, extensions).
	 * @param onmessage - Called per message.
	 * @param onclose - Called with (code, reason).
	 * @param onerror - Called with an error string.
	 * @returns A `[send, close]` pair.
	 */
	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: ArrayBuffer | string | Blob) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void
	): [(data: ArrayBuffer | string | Blob) => void, (code: number, reason: string) => void] {
		if (this.#closed) throw new Error("transport already disposed");
		const socket = new this.#module.WebSocket(url.toString(), protocols, {
			headers: flattenHeaders(requestHeaders),
			cacert: this.#trust.caPem,
			cacert_hosts: this.#trust.hosts,
		});
		// Note: the fork sets FOLLOWLOCATION 0 for a scoped handle, but an
		// OUT-OF-SCOPE websocket handshake keeps curl's default. Whether curl
		// follows a redirect during a websocket upgrade at all is a native
		// behaviour question (CONNECT_ONLY handling) that only a built fork can
		// answer, so no claim is made here either way.
		socket.binaryType = "arraybuffer";
		this.#sockets.add(socket);
		socket.onopen = () => onopen("", "");
		socket.onmessage = (event) => onmessage(event.data);
		socket.onclose = (event) => {
			this.#sockets.delete(socket);
			onclose(event.code, event.reason);
		};
		socket.onerror = () => {
			this.#sockets.delete(socket);
			onerror("");
		};
		return [
			(data) => socket.send(data),
			(code, reason) => socket.close(code, reason),
		];
	}

	/**
	 * Cancels live work, then releases trust.
	 *
	 * Ordering matters: the sockets and the session are closed first so no handle
	 * can still be verifying against the CA when the session drops its reference
	 * to it.
	 */
	dispose(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.ready = false;
		for (const socket of [...this.#sockets]) {
			try {
				socket.close(1001, "transport disposed");
			} catch {
				// a socket that is already gone is not an error here
			}
			this.#sockets.delete(socket);
		}
		if (this.#session !== null) {
			this.#session.close();
			this.#session = null;
		}
	}
}
