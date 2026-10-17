/**
 * Host-side candidate route observer.
 *
 * A wisp CONNECT *request* is not a route. An idle TCP stream is not a route. An
 * HTTP request that arrived on a different socket than the wisp upstream is a
 * bypass, not a candidate route. Qualification requires the fixture's accepted
 * HTTP connection to be the same TCP connection the attempt-owned wisp stream
 * opened: local/remote address+port of the wisp client socket equal the
 * remote/local of the fixture ingress, during that stream's lifetime.
 *
 * Favicon and other ignored paths never prove a route. Handshake upgrades are
 * counted separately and never set `matchedTarget`.
 */


export type SocketEndpoint = {
	readonly address: string;
	readonly port: number;
};

export type AcceptedStream = {
	readonly id: number;
	readonly attempt: string;
	readonly connectedAt: number;
	closedAt: number | null;
	readonly local: SocketEndpoint;
	readonly remote: SocketEndpoint;
	readonly destHost: string;
	readonly destPort: number;
};

export type FixtureHttp = {
	readonly receivedAt: number;
	readonly method: string;
	readonly pathname: string;
	readonly search: string;
	readonly remote: SocketEndpoint;
	readonly local: SocketEndpoint;
	readonly ignored: boolean;
	readonly matchedStreamId: number | null;
};

export type AttemptWatch = {
	readonly listenPort: number;
	/** Original target URL, including query. Matching uses this string's path and search exactly. */
	readonly expectedUrl: string;
	readonly expectedMethod: string;
	readonly mode: "local-http" | "remote-stream";
	readonly remoteHost: string | null;
	readonly remotePort: number | null;
};

export type RouteObservation = {
	readonly handshakeUpgrades: number;
	readonly rejectedUpgrades: number;
	readonly acceptedStreamsToTarget: number;
	readonly httpOnAcceptedStream: number;
	readonly ignoredRequests: number;
	readonly unmatchedHttp: number;
	readonly matchedTarget: boolean;
	readonly mode: "local-http" | "remote-stream";
};

/**
 * Canonicalizes only a genuine equivalence.
 *
 * The IPv4-mapped form collapses to its IPv4 literal. `::1` and `127.0.0.1` are
 * DIFFERENT endpoint spaces and are preserved as distinct - collapsing them would
 * let a v6 loopback observation match a v4 stream. A zone index is part of the
 * interface identity and is kept; callers that cannot disambiguate a zoned address
 * must refuse the join rather than strip it.
 */
export function normalizeAddress(address: string): string {
	const trimmed = address.trim();
	const unbracketed =
		trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
	const lower = unbracketed.toLowerCase();
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(lower);
	if (mapped?.[1] !== undefined) return mapped[1];
	return lower;
}

/** True when an address carries a zone index, which makes a tuple join ambiguous. */
export function hasZoneIndex(address: string): boolean {
	return normalizeAddress(address).includes("%");
}

export function endpointsEqual(a: SocketEndpoint, b: SocketEndpoint): boolean {
	return normalizeAddress(a.address) === normalizeAddress(b.address) && a.port === b.port;
}

/** Same TCP connection viewed from opposite ends. */
export function sameConnection(
	wispLocal: SocketEndpoint,
	wispRemote: SocketEndpoint,
	httpRemote: SocketEndpoint,
	httpLocal: SocketEndpoint
): boolean {
	return endpointsEqual(wispLocal, httpRemote) && endpointsEqual(wispRemote, httpLocal);
}

export function isIgnoredPath(pathname: string): boolean {
	const path = pathname.split("?")[0] ?? pathname;
	return path === "/favicon.ico" || path.endsWith("/favicon.ico");
}

export function endpointFromSocket(
	socket: {
		readonly localAddress?: string;
		readonly localPort?: number;
		readonly remoteAddress?: string;
		readonly remotePort?: number;
	},
	side: "local" | "remote"
): SocketEndpoint | null {
	if (side === "local") {
		if (typeof socket.localAddress !== "string" || typeof socket.localPort !== "number") return null;
		return { address: socket.localAddress, port: socket.localPort };
	}
	if (typeof socket.remoteAddress !== "string" || typeof socket.remotePort !== "number") return null;
	return { address: socket.remoteAddress, port: socket.remotePort };
}

export class RouteObserver {
	#handshakes = new Map<string, number>();
	#rejected = new Map<string, number>();
	#watches = new Map<string, AttemptWatch>();
	#streams: AcceptedStream[] = [];
	#http: FixtureHttp[] = [];
	#nextStreamId = 1;

	watch(attempt: string, watch: AttemptWatch): void {
		this.#watches.set(attempt, watch);
	}


	handshake(attempt: string): void {
		this.#handshakes.set(attempt, (this.#handshakes.get(attempt) ?? 0) + 1);
	}

	rejectHandshake(attempt: string | null): void {
		if (!attempt) return;
		this.#rejected.set(attempt, (this.#rejected.get(attempt) ?? 0) + 1);
	}

	/**
	 * Records a wisp upstream TCP socket that has actually connected.
	 * Must be called from the `connect` callback, never from stream construction.
	 */
	acceptedStream(input: {
		readonly attempt: string;
		readonly local: SocketEndpoint;
		readonly remote: SocketEndpoint;
		readonly destHost: string;
		readonly destPort: number;
		readonly onClose: (close: () => void) => void;
	}): AcceptedStream {
		const stream: AcceptedStream = {
			id: this.#nextStreamId++,
			attempt: input.attempt,
			connectedAt: Date.now(),
			closedAt: null,
			local: input.local,
			remote: input.remote,
			destHost: input.destHost,
			destPort: input.destPort,
		};
		this.#streams.push(stream);
		input.onClose(() => {
			if (stream.closedAt === null) stream.closedAt = Date.now();
		});
		return stream;
	}

	http(input: {
		readonly method: string;
		readonly url: string;
		readonly remote: SocketEndpoint;
		readonly local: SocketEndpoint;
	}): FixtureHttp {
		const receivedAt = Date.now();
		const parsed = new URL(input.url, "http://127.0.0.1");
		const ignored = isIgnoredPath(parsed.pathname);
		const matched =
			this.#streams.find((stream) => {
				if (stream.closedAt !== null && stream.closedAt < receivedAt) return false;
				if (stream.connectedAt > receivedAt) return false;
				return sameConnection(stream.local, stream.remote, input.remote, input.local);
			}) ?? null;
		const record: FixtureHttp = {
			receivedAt,
			method: input.method,
			pathname: parsed.pathname,
			search: parsed.search,
			remote: input.remote,
			local: input.local,
			ignored,
			matchedStreamId: matched?.id ?? null,
		};
		this.#http.push(record);
		return record;
	}

	observation(attempt: string): RouteObservation {
		const watch = this.#watches.get(attempt);
		const mode = watch?.mode ?? "local-http";
		const expected = watch ? new URL(watch.expectedUrl) : null;
		const streams = this.#streams.filter((stream) => stream.attempt === attempt);
		const acceptedStreamsToTarget = streams.filter((stream) => {
			if (!watch) return false;
			if (mode === "remote-stream") {
				return (
					stream.destHost === watch.remoteHost &&
					(watch.remotePort === null || stream.destPort === watch.remotePort)
				);
			}
			return stream.destPort === watch.listenPort;
		}).length;
		const streamFor = (entry: FixtureHttp) =>
			entry.matchedStreamId === null
				? undefined
				: this.#streams.find((item) => item.id === entry.matchedStreamId);
		const ignoredRequests = this.#http.filter((entry) => {
			if (!entry.ignored) return false;
			const stream = streamFor(entry);
			if (stream?.attempt === attempt) return true;
			return watch !== undefined && entry.local.port === watch.listenPort;
		}).length;
		const httpOnAcceptedStream = this.#http.filter((entry) => {
			if (entry.ignored) return false;
			if (!watch || !expected) return false;
			if (entry.method !== watch.expectedMethod) return false;
			if (entry.pathname !== expected.pathname) return false;
			if (entry.search !== expected.search) return false;
			if (entry.local.port !== watch.listenPort) return false;
			const stream = streamFor(entry);
			if (!stream || stream.attempt !== attempt) return false;
			if (stream.destPort !== watch.listenPort) return false;
			return true;
		}).length;
		const unmatchedHttp = this.#http.filter((entry) => {
			if (entry.ignored) return false;
			if (watch && entry.local.port !== watch.listenPort) return false;
			const stream = streamFor(entry);
			if (stream?.attempt === attempt && stream.destPort === watch?.listenPort) return false;
			return true;
		}).length;
		// remote-stream is connectivity only and never a proxyRoute proof.
		const matchedTarget = mode === "local-http" && httpOnAcceptedStream > 0;
		return Object.freeze({
			handshakeUpgrades: this.#handshakes.get(attempt) ?? 0,
			rejectedUpgrades: this.#rejected.get(attempt) ?? 0,
			acceptedStreamsToTarget,
			httpOnAcceptedStream,
			ignoredRequests,
			unmatchedHttp,
			matchedTarget,
			mode,
		});
	}

	forget(attempt: string): void {
		this.#watches.delete(attempt);
		this.#handshakes.delete(attempt);
		this.#rejected.delete(attempt);
		this.#streams = this.#streams.filter((stream) => stream.attempt !== attempt);
		this.#http = this.#http.filter((entry) => {
			if (entry.matchedStreamId === null) return true;
			const stream = this.#streams.find((item) => item.id === entry.matchedStreamId);
			return stream !== undefined;
		});
	}
}

let installed: RouteObserver | null = null;

export function installRouteObserver(observer: RouteObserver | null): void {
	installed = observer;
}

export function activeRouteObserver(): RouteObserver | null {
	return installed;
}
