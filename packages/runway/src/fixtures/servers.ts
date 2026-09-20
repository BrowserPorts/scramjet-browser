/**
 * Local fixture servers.
 *
 * Runway owns three loopback servers: the Scramjet harness origin, the bare
 * (unproxied) harness origin, and the wisp endpoint the candidate's transport
 * dials. Every port is read back from the listening socket, so the recorded
 * origins are the ones that actually served traffic and no port constant exists
 * anywhere in this module.
 *
 * The wisp endpoint doubles as host-side route instrumentation. The harness page
 * asks for its configuration with the current attempt's nonce, the configuration
 * hands back a wisp URL carrying that nonce, and each upgrade is counted against
 * it. A candidate lane can therefore be shown — from the host, not from the page's
 * own claims — to have opened its proxy transport for one specific attempt.
 *
 * The wisp endpoint also owns the lifetime of every upstream socket it opens. An
 * upstream is tracked from the moment wisp constructs its socket wrapper, which is
 * before the destination lookup, so `close` can refuse an attempt that is still
 * only a pending lookup and destroy one whose socket appears afterwards. `close`
 * waits for those attempts under a deadline and reports a cleanup failure instead
 * of returning a clean shutdown it cannot prove.
 */
import { realpathSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AddressInfo, Socket } from "node:net";
import send from "send";
import serveStatic from "serve-static";
import { logging, server as wisp } from "@mercuryworkshop/wisp-js/server";
import { RunwayError } from "../core/errors.ts";
import type { FixtureProvenance } from "../core/protocol.ts";
import type { LocalFixturePlan } from "../core/plan.ts";
import { CAPABILITIES } from "../core/inventory.ts";
import type { LoadedPluginProfile } from "./plugin-profile.ts";
import {
	activeRouteObserver,
	endpointFromSocket,
	installRouteObserver,
	RouteObserver,
	type AttemptWatch,
	type RouteObservation,
} from "./route.ts";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * How long `close` waits for in-flight wisp upstream attempts to settle.
 *
 * The wait is bounded on purpose: wisp exposes no way to abort a DNS lookup, so a
 * resolver that never answers must end in a reported cleanup failure rather than a
 * shutdown that hangs or a shutdown that claims to be clean.
 */
const UPSTREAM_SHUTDOWN_DEADLINE_MS = 5_000;

/** Harness payload roots: `src/harness/**` in a checkout, `dist/harness/**` installed. */
const harnessRoot = path.join(moduleDirectory, "..", "harness");

export const ATTEMPT_QUERY_PARAM = "runway_attempt";

/**
 * Path prefix that carries the attempt nonce on the wisp endpoint.
 *
 * The nonce travels in the path rather than the query because transport clients
 * require the endpoint to end in a slash, and it must stay attributable per attempt.
 */
export const ATTEMPT_PATH_PREFIX = "runway-attempt";

export type AttemptRouteObservation = RouteObservation;

/** The node socket wisp keeps on its own TCP wrapper, as this module uses it. */
type WispNodeSocket = {
	localAddress?: string;
	localPort?: number;
	remoteAddress?: string;
	remotePort?: number;
	on: (event: string, listener: () => void) => void;
	destroy?: (error?: Error) => void;
	destroyed?: boolean;
};

/**
 * Lifecycle stage of one wisp upstream attempt.
 *
 * `lookup` is the window wisp spends resolving the destination inside its stream
 * filter, before it ever calls `connect()` on the socket wrapper. That window is
 * exactly where a shutdown used to lose track of an upstream: the fixture servers
 * could finish closing while a lookup was outstanding, and the socket was then
 * created afterwards.
 */
type UpstreamStage = "lookup" | "connecting" | "connected" | "refused" | "failed";

type UpstreamAttempt = {
	readonly id: number;
	readonly attempt: string;
	readonly destHost: string;
	readonly destPort: number;
	stage: UpstreamStage;
	/** Set when the shutdown claimed this attempt. Late callbacks re-read it. */
	cancelled: boolean;
	/**
	 * wisp tore this stream down while the fixtures were still healthy (a blocked
	 * destination, or a client that closed the stream). Nothing this fixture owns
	 * can still become a live socket, so a shutdown does not wait for it.
	 */
	releasedEarly: boolean;
	settled: boolean;
	/**
	 * wisp's own close reason, once its stream filter has finished for this attempt
	 * and refused the destination. Null means no filter decision has been observed —
	 * which, for an attempt a shutdown is still waiting on, is the whole story.
	 */
	filterRefusal: number | null;
	/** Resolves — never rejects — once this attempt can no longer open a socket. */
	readonly finished: Promise<void>;
	readonly release: () => void;
	/** Destroys whatever socket exists at call time. Safe to call repeatedly. */
	readonly cancel: () => void;
};

function upstreamDetail(upstream: UpstreamAttempt): Readonly<Record<string, unknown>> {
	return {
		attempt: upstream.attempt,
		destHost: upstream.destHost,
		destPort: upstream.destPort,
		stage: upstream.stage,
		filterRefusal: upstream.filterRefusal,
	};
}

/** The parts of wisp's `ServerConnection` this module drives, and nothing more. */
type WispServerConnection = {
	create_stream: (streamId: number, type: number, hostname: string, port: number) => void;
	close_stream: (streamId: number, reason?: number | null, quiet?: boolean) => Promise<void>;
};

/**
 * Filter-refusal callbacks, per wisp connection and stream id.
 *
 * This is the correlation between wisp's stream bookkeeping and this module's, and it
 * is identity all the way down: the connection object wisp created, the stream id
 * wisp assigned, and the attempt this module registered while that exact
 * `create_stream` call was on the stack. Two concurrent attempts to the same
 * destination are two separate entries, and a connection whose sockets came from
 * anywhere else has none. Nothing is keyed by hostname, so nothing can be confused by
 * a second attempt or a shared resolver answer.
 *
 * The map is deliberately not cleared when a stream is torn down for other reasons —
 * see the hook below for why the decision can arrive after that.
 */
const filterRefusalTargets = new WeakMap<
	WispServerConnection,
	Map<number, (reason: number) => void>
>();

/**
 * Weak handles on the connections that currently have a registry.
 *
 * Weak because a registry must never be what keeps a finished connection alive, and
 * a `WeakMap` cannot be enumerated, so the handles are what makes the live registries
 * reachable for the diagnostics below.
 *
 * Its size is bounded by the connections with an outstanding decision *right now*,
 * not by every connection this process has ever served. That bound is maintained
 * deterministically: {@link releaseFilterRegistry} drops a connection's map and its
 * handle the moment the last decision for it retires, and a later stream on the same
 * connection simply creates a fresh map and a fresh handle. An absent map and an
 * empty one are read identically everywhere, so dropping one changes no policy.
 */
const trackedFilterConnections = new Set<WeakRef<WispServerConnection>>();

/** The handle held for a connection, so it can be dropped without a scan. */
const filterConnectionHandles = new WeakMap<
	WispServerConnection,
	WeakRef<WispServerConnection>
>();

/**
 * Backstop for the one case the deterministic release cannot cover: a connection that
 * is discarded while a decision is still outstanding, which is the shape the shutdown
 * deadline reports. The decision can never be reported once wisp's connection is
 * gone, so its handle is dropped when the connection is collected.
 *
 * This is the only garbage-collection-dependent part of the registry, it only ever
 * removes bookkeeping for an abandoned connection, and nothing waits on it — the
 * tests assert the deterministic path instead, because GC timing is not a behaviour
 * anything should depend on.
 */
const collectedFilterConnections = new FinalizationRegistry<WeakRef<WispServerConnection>>(
	(handle) => {
		trackedFilterConnections.delete(handle);
	}
);

/** Drops a connection's registry once nothing is outstanding for it. */
function releaseFilterRegistry(
	connection: WispServerConnection,
	streams: Map<number, (reason: number) => void>
): void {
	if (streams.size > 0) return;
	filterRefusalTargets.delete(connection);
	const handle = filterConnectionHandles.get(connection);
	if (!handle) return;
	filterConnectionHandles.delete(connection);
	trackedFilterConnections.delete(handle);
	collectedFilterConnections.unregister(handle);
}

/**
 * How many wisp filter decisions this process is still waiting on.
 *
 * A diagnostic seam for the tests that assert this registry stays bounded. It sums
 * the live registries themselves rather than a tally kept alongside them, so it
 * cannot agree with a registry that has actually leaked.
 */
export function outstandingFilterDecisions(): number {
	let total = 0;
	for (const handle of [...trackedFilterConnections]) {
		const connection = handle.deref();
		if (!connection) {
			trackedFilterConnections.delete(handle);
			continue;
		}
		total += filterRefusalTargets.get(connection)?.size ?? 0;
	}
	return total;
}

/**
 * How many connections the registry is currently holding a handle for.
 *
 * The companion diagnostic seam: {@link outstandingFilterDecisions} would read zero
 * for a registry that had shed every callback but kept a handle for every connection
 * it had ever seen, which is exactly the growth this bound exists to prevent.
 */
export function trackedFilterConnectionCount(): number {
	return trackedFilterConnections.size;
}

/**
 * The `create_stream` call currently on the stack, for the socket it is constructing.
 *
 * wisp builds the stream's socket synchronously inside `create_stream`
 * (`server/connection.mjs:212-215`), so a value set around that call is observed by
 * this module's socket factory and by nothing else. It is cleared in a `finally`.
 */
let activeStreamCreation: { connection: WispServerConnection; streamId: number } | null = null;

/**
 * Observes wisp's stream filter finishing with a refusal, at its source.
 *
 * wisp resolves and screens each destination once, in `create_stream`'s background
 * task (`server/connection.mjs:218-224`), and reports a refusal by closing the stream
 * with `quiet = true`. That argument is passed at exactly one call site in the
 * package — line 222, the refusal — so it is an unambiguous report that the filter
 * *completed* and denied the destination, carrying wisp's own close reason. Every
 * other `close_stream` (a client's close, the connection cleanup, a failed `setup()`)
 * leaves `quiet` falsy and says nothing about the filter.
 *
 * That distinction is the fix. A refused attempt can never reach `connect()`, so it
 * is over; an attempt whose filter is still running can still be allowed and open a
 * socket, so a shutdown must keep waiting for it. Nothing here infers a decision from
 * a lookup cache and nothing asks the resolver a second question — wisp's filter runs
 * once per attempt and this reads the result of that one run.
 *
 * The lookup is *not* done through `this.streams[streamId]`, because by the time a
 * refusal arrives during a shutdown that entry is usually gone: closing the websocket
 * makes wisp's own `cleanup()` (`connection.mjs:305-308`) delete every stream first,
 * and `close_stream` then returns early. The decision still has to be attributed, so
 * it is attributed to the stream id it was reported against.
 *
 * `ServerConnection` is exported from the package's server entry and `routeRequest`
 * builds its connections from that same class, so this is the integration point the
 * installed version offers. It is installed once per process and never removed: it is
 * inert for any stream this module did not create a socket for, so there is no
 * per-instance global state to restore and concurrent fixtures cannot collide.
 */
let filterRefusalHookInstalled = false;
function installFilterRefusalHook(connectionClass: {
	prototype: WispServerConnection;
}): void {
	if (filterRefusalHookInstalled) return;
	filterRefusalHookInstalled = true;
	const originalCreateStream = connectionClass.prototype.create_stream;
	const originalCloseStream = connectionClass.prototype.close_stream;
	connectionClass.prototype.create_stream = function trackedCreateStream(
		this: WispServerConnection,
		streamId: number,
		type: number,
		hostname: string,
		port: number
	): void {
		// A CONNECT that reuses a stream id whose previous filter decision is still
		// outstanding is refused here, before wisp constructs anything for it.
		//
		// wisp 0.4.1 accepts a repeated CONNECT for a live id without any generation of
		// its own (`connection.mjs:256-265`), and a refusal is reported against nothing
		// but that id. So two outstanding decisions for one id are indistinguishable:
		// the first stream's refusal would be attributed to the second stream, settling
		// an attempt whose own filter is still running and letting a shutdown call
		// itself clean while that filter could still allow a socket. A generation number
		// cannot repair this, because the report carries no token to match one against.
		//
		// Refusing admission is this fixture's own transport policy and is deliberately
		// not expressed as a close of the earlier stream: nothing is fabricated on
		// wisp's behalf, no `quiet` refusal is synthesised, and the pending decision it
		// protects keeps its full lifetime. wisp drops later DATA for an id with no
		// stream (`connection.mjs:250-254`), and ids whose decision has already been
		// retired are admitted normally, so ordinary reuse is untouched.
		if (filterRefusalTargets.get(this)?.has(streamId)) return;
		const previous = activeStreamCreation;
		activeStreamCreation = { connection: this, streamId };
		try {
			originalCreateStream.call(this, streamId, type, hostname, port);
		} finally {
			activeStreamCreation = previous;
		}
	};
	connectionClass.prototype.close_stream = async function trackedCloseStream(
		this: WispServerConnection,
		streamId: number,
		reason: number | null = null,
		quiet = false
	): Promise<void> {
		if (quiet === true && reason) {
			const streams = filterRefusalTargets.get(this);
			const refused = streams?.get(streamId);
			// Retired by reading and removing the same entry, so a decision is consumed
			// exactly once and only the registration that was found is removed.
			if (refused && streams) {
				streams.delete(streamId);
				refused(reason);
				releaseFilterRegistry(this, streams);
			}
		}
		return originalCloseStream.call(this, streamId, reason, quiet);
	};
}

/**
 * Binds this attempt's refusal callback to the stream wisp is building right now.
 *
 * Returns the retirement for *this* registration. It removes the entry only while
 * the entry is still this callback, so a registration can never remove a later one
 * that happens to share its stream id.
 */
function bindFilterRefusal(refused: (reason: number) => void): () => void {
	const creation = activeStreamCreation;
	// Absent only if wisp built this socket outside `create_stream`, in which case
	// there is no stream id to attribute a decision to and `connect()` owns the
	// attempt on its own.
	if (!creation) return () => undefined;
	const existing = filterRefusalTargets.get(creation.connection);
	const streams = existing ?? new Map<number, (reason: number) => void>();
	if (!existing) {
		// First outstanding decision for this connection, whether or not it has had
		// others before: the registry was released when the previous one retired, so a
		// fresh map and a fresh handle are registered here.
		filterRefusalTargets.set(creation.connection, streams);
		const handle = new WeakRef(creation.connection);
		filterConnectionHandles.set(creation.connection, handle);
		trackedFilterConnections.add(handle);
		collectedFilterConnections.register(creation.connection, handle, handle);
	}
	streams.set(creation.streamId, refused);
	return () => {
		if (streams.get(creation.streamId) !== refused) return;
		streams.delete(creation.streamId);
		releaseFilterRegistry(creation.connection, streams);
	};
}

/**
 * Waits for the upstream attempts a shutdown claimed, up to `deadlineMs`.
 *
 * Returns the attempts that were still unsettled when the deadline passed, which
 * the caller reports as a cleanup failure. `finished` never rejects, so nothing
 * here can produce an unhandled rejection.
 */
async function waitForUpstreams(
	claimed: readonly UpstreamAttempt[],
	deadlineMs: number
): Promise<readonly UpstreamAttempt[]> {
	const outstanding = claimed.filter((upstream) => !upstream.settled);
	if (outstanding.length === 0) return [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<"expired">((resolve) => {
		timer = setTimeout(() => resolve("expired"), deadlineMs);
		timer.unref?.();
	});
	try {
		const settled = Promise.all(outstanding.map((upstream) => upstream.finished)).then(
			() => "settled" as const
		);
		if ((await Promise.race([settled, expired])) === "settled") return [];
	} finally {
		if (timer) clearTimeout(timer);
	}
	return outstanding.filter((upstream) => !upstream.settled);
}

export type LocalFixtures = {
	readonly harnessOrigin: string;
	readonly bareOrigin: string;
	readonly wispOrigin: string;
	readonly observer: RouteObserver;
	/** Binds this attempt's expected fixture target for same-connection matching. */
	readonly watchAttempt: (nonce: string, watch: AttemptWatch) => void;
	readonly routeObservation: (nonce: string) => AttemptRouteObservation;
	readonly forgetAttempt: (nonce: string) => void;
	readonly provenance: readonly FixtureProvenance[];
	readonly close: () => Promise<void>;
};

/**
 * One step of the fixture request chain.
 *
 * The chain is deliberately tiny: it decides *which* mount owns a request and
 * nothing else. Everything about actually serving a file — MIME, ranges,
 * conditional requests, ETag/Last-Modified, index files, directory redirects — is
 * `serve-static`/`send`, so this module never re-implements HTTP semantics.
 */
type FixtureHandler = (
	req: MountRequest,
	res: http.ServerResponse,
	next: (error?: unknown) => void
) => void;

/** `parseurl.original`, which `send` uses for redirects, reads `originalUrl`. */
type MountRequest = http.IncomingMessage & { originalUrl?: string };

/**
 * Splits a raw request target without decoding: mount boundaries are byte-exact.
 *
 * This is only the same pathname the static libraries see because
 * {@link unsupportedTargetReason} has already refused every target that would make
 * `parseurl` leave its fast path. See that function for why the two must agree.
 */
function splitTarget(target: string): { readonly rawPath: string; readonly search: string } {
	const queryAt = target.indexOf("?");
	return queryAt === -1
		? { rawPath: target, search: "" }
		: { rawPath: target.slice(0, queryAt), search: target.slice(queryAt) };
}

/**
 * Bytes that make a raw request target unsupported.
 *
 * `serve-static` takes its pathname from `parseurl`, whose fast path is an
 * unrolling of `/^(\/[^?#\s]*)(\?[^#\s]*)?$/`. Any other target falls back to the
 * legacy `url.parse`, which strips a fragment and percent-escapes some bytes, so
 * the library ends up looking at a *different* pathname than a `?`-only split
 * produces. That difference was a real hole: a raw `/scramjet/escape#ignored` made
 * the containment guard resolve a file called `escape#ignored`, find nothing and
 * step aside, while the library went on to serve `/escape` — the symlink out of the
 * asset root the guard exists to refuse.
 *
 * The repair is not a second parser kept bug-compatible with `parseurl`; it is to
 * refuse the targets that can reach `url.parse` at all, which leaves exactly one
 * pathname for the guard and the library to share. These bytes are control
 * characters, space, DEL and everything above US-ASCII — Node's own request parser
 * already rejects all of them, and they are re-checked here so the invariant does
 * not silently depend on that.
 */
const UNSUPPORTED_TARGET_BYTE = /[\u0000-\u0020\u007f-\uffff]/;

/**
 * Why a raw request target cannot be routed, or null when it can.
 *
 * Only the grammar is judged, on the exact bytes the wire carried. Nothing is
 * decoded, normalised or rewritten, so this can never turn one request into a
 * different one: a target either survives unchanged or is refused.
 */
function unsupportedTargetReason(target: string): string | null {
	if (!target.startsWith("/")) {
		// Absolute-form (`http://host/path`), authority-form and `*`. `url.parse`
		// hands the library a pathname lifted out of some other origin while every
		// mount boundary here still sees the whole string, so the two disagree about
		// what was even asked for. Origin servers have no use for these forms.
		return "a request target must be an origin-form path beginning with /";
	}
	if (target.startsWith("//")) {
		// A network-path reference reads as an authority to some parsers and as a
		// path to others, and `serve-static` has to collapse it before it can build
		// a redirect. No fixture asset is addressed this way.
		return "a request target must not begin with //";
	}
	if (target.includes("#")) {
		// RFC 9110 §7.1 excludes a fragment from the request target, so a literal
		// `#` on the wire is already malformed; refusing it is not a lost feature.
		// `%23` is untouched and still names a file with a `#` in it.
		return "a request target must not contain a fragment";
	}
	const offending = UNSUPPORTED_TARGET_BYTE.exec(target);
	if (offending) {
		const byte = offending[0].charCodeAt(0).toString(16).padStart(2, "0");
		return `a request target must not contain the byte 0x${byte}`;
	}
	return null;
}

/**
 * Decodes a request path for the containment check only.
 *
 * Returns null for anything `send` itself will reject (invalid percent-encoding,
 * NUL bytes), so the library keeps ownership of that response rather than this
 * module inventing a different one.
 */
function decodeRequestPath(rawPath: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(rawPath);
	} catch {
		return null;
	}
	return decoded.includes("\0") ? null : decoded;
}

function withinRoot(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * Ends a response that has already begun, as a failure.
 *
 * Once a status line and headers are on the wire there is no status left to send,
 * and `res.end()` would frame the truncated bytes as a complete, successful
 * response — a client would accept a partial file as the whole file. Destroying the
 * connection is the only signal HTTP still has at that point: the peer sees the
 * message end early without its declared length, which is exactly what happened.
 */
function abortResponse(res: http.ServerResponse, cause?: unknown): void {
	if (res.destroyed) return;
	// The error is passed on so node's own socket teardown reports a reason rather
	// than a bare close; `send` has already destroyed its read stream through
	// `on-finished`, so no descriptor is left behind by this.
	res.destroy(cause instanceof Error ? cause : undefined);
}

function plainResponse(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	status: number,
	body: string,
	headers: Readonly<Record<string, string>> = {}
): void {
	if (res.headersSent) {
		abortResponse(res);
		return;
	}
	const payload = Buffer.from(body, "utf8");
	res.statusCode = status;
	for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
	res.setHeader("Content-Type", "text/plain; charset=utf-8");
	res.setHeader("Content-Length", String(payload.byteLength));
	res.end(req.method === "HEAD" ? undefined : payload);
}

function errorStatus(error: unknown): number {
	const candidate = error as { statusCode?: unknown; status?: unknown } | null;
	const raw =
		typeof candidate?.statusCode === "number"
			? candidate.statusCode
			: typeof candidate?.status === "number"
				? candidate.status
				: 500;
	return raw >= 400 && raw <= 599 ? raw : 500;
}

/**
 * One failed fixture request, as the *host* is allowed to see it.
 *
 * This is deliberately not what the client is told. `message` and `path` come
 * straight off a filesystem error and routinely name an absolute host path, so they
 * exist for a host-side log or a failure report and never reach a response body.
 * File contents are never included: only the metadata the error itself carried.
 */
export type FixtureRequestFailure = {
	readonly status: number;
	readonly method: string | null;
	/** The raw request target, exactly as received. Never decoded. */
	readonly target: string | null;
	/** Whether the message below was also sent to the client. */
	readonly exposed: boolean;
	readonly code: string | null;
	readonly syscall: string | null;
	/** Absolute host path from a filesystem error. Host-side only. */
	readonly path: string | null;
	readonly message: string | null;
	/** True when the failure arrived too late to be a status code. */
	readonly headersSent: boolean;
};

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Whether an error's own message may be sent to the client.
 *
 * `http-errors` marks that with `expose`, and `send` deliberately builds every
 * error it forwards from a filesystem error with `expose: false` — a 404 for a
 * missing asset carries `ENOENT: ... stat '/abs/path/to/asset'`. Only an explicit
 * `true` opts in, so an error from anywhere else (a plain `Error`, a bug, a future
 * dependency) is quiet by default rather than quiet only if someone remembered.
 *
 * A handler in this module that wants a specific public message either answers with
 * {@link plainResponse} directly or throws an error carrying `expose: true`.
 */
function messageIsExposable(error: unknown): boolean {
	return (
		(error as { expose?: unknown } | null)?.expose === true &&
		error instanceof Error &&
		error.message.length > 0
	);
}

/**
 * Terminal handler for the chain.
 *
 * `serve-static` runs with `fallthrough: false`, so it reports 400/403/404/405/416
 * as forwarded errors. Their status and any headers the library already decided —
 * `Content-Range` on a 416, `Allow` on a 405 — are preserved here rather than
 * replaced with a generic failure. The *message* is not: an unexposable error
 * answers with the registered reason phrase for its status, and the original text
 * goes to the host-side report instead.
 */
function finalizeRequest(
	req: MountRequest,
	res: http.ServerResponse,
	error: unknown,
	report: (failure: FixtureRequestFailure) => void
): void {
	if (error === undefined) {
		// No mount claimed the request. Nothing has been written, unless a handler
		// responded and then still called `next()`, which is a bug rather than a
		// second chance to choose a status.
		if (res.headersSent) abortResponse(res);
		else plainResponse(req, res, 404, "not found\n");
		return;
	}
	const status = errorStatus(error);
	const detail = error as {
		headers?: Readonly<Record<string, string>>;
		code?: unknown;
		syscall?: unknown;
		path?: unknown;
	} | null;
	const exposed = messageIsExposable(error);
	report({
		status,
		method: req.method ?? null,
		target: req.originalUrl ?? req.url ?? null,
		exposed,
		code: optionalString(detail?.code),
		syscall: optionalString(detail?.syscall),
		path: optionalString(detail?.path),
		message: error instanceof Error && error.message.length > 0 ? error.message : null,
		headersSent: res.headersSent,
	});
	if (res.headersSent) {
		abortResponse(res, error);
		return;
	}
	const message = exposed
		? (error as Error).message
		: (http.STATUS_CODES[status] ?? "request failed");
	plainResponse(req, res, status, `${message}\n`, detail?.headers ?? {});
}

/**
 * Runs handlers in order; the first to respond ends the chain.
 *
 * The grammar gate is prepended here rather than listed per server, so no dispatcher
 * can be assembled without it and the pathname every mount and guard reads is the
 * one the static libraries read.
 */
function createDispatcher(
	handlers: readonly FixtureHandler[],
	report: (failure: FixtureRequestFailure) => void
): http.RequestListener {
	const chain = [requestTargetGate, ...handlers];
	return (request, response) => {
		const req = request as MountRequest;
		let index = 0;
		const next = (error?: unknown): void => {
			if (error !== undefined) {
				finalizeRequest(req, response, error, report);
				return;
			}
			const handler = chain[index];
			index += 1;
			if (!handler) {
				finalizeRequest(req, response, undefined, report);
				return;
			}
			try {
				handler(req, response, next);
			} catch (cause) {
				finalizeRequest(req, response, cause, report);
			}
		};
		next();
	};
}

/**
 * Refuses a raw request target this module cannot route unambiguously.
 *
 * It runs before every mount, so the refusal is the same wherever the target would
 * have landed and no later handler has to re-derive a pathname. The message is this
 * module's own and says only what about the grammar was wrong.
 */
const requestTargetGate: FixtureHandler = (req, res, next) => {
	const reason = unsupportedTargetReason(req.url ?? "");
	if (reason === null) {
		next();
		return;
	}
	plainResponse(req, res, 400, `${reason}\n`);
};

function methodNotAllowed(req: MountRequest, res: http.ServerResponse): void {
	plainResponse(req, res, 405, "method not allowed\n", { Allow: "GET, HEAD" });
}

/**
 * Mounts a handler under a URL prefix.
 *
 * The boundary is tested on the raw, still-encoded path, so `/scramjet` never
 * matches `/scramjetfoo` and no percent-decoding can manufacture a match. The
 * remainder and the untouched query are handed to the mounted handler through
 * `req.url`, which is restored once the response settles or the chain moves on —
 * the guest-visible target itself is never rewritten.
 */
function mountAt(prefix: string, handler: FixtureHandler): FixtureHandler {
	const boundary = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
	return (req, res, next) => {
		const target = req.url ?? "/";
		const { rawPath, search } = splitTarget(target);
		if (rawPath !== boundary && !rawPath.startsWith(`${boundary}/`)) {
			next();
			return;
		}
		const remainder = rawPath.slice(boundary.length) || "/";
		req.originalUrl = target;
		req.url = `${remainder}${search}`;
		let restored = false;
		const restore = (): void => {
			if (restored) return;
			restored = true;
			req.url = target;
		};
		// `send` resolves directories asynchronously and reads `originalUrl` when it
		// redirects, so the rewrite outlives this call and is undone on settlement.
		res.once("close", restore);
		handler(req, res, (error?: unknown) => {
			restore();
			next(error);
		});
	};
}

/** Serves an exact path as JSON for GET/HEAD only. */
function jsonRoute(pathname: string, body: (req: MountRequest) => unknown): FixtureHandler {
	return (req, res, next) => {
		if (splitTarget(req.url ?? "/").rawPath !== pathname) {
			next();
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			methodNotAllowed(req, res);
			return;
		}
		const payload = Buffer.from(JSON.stringify(body(req)), "utf8");
		res.statusCode = 200;
		res.setHeader("Content-Type", "application/json; charset=utf-8");
		res.setHeader("Content-Length", String(payload.byteLength));
		// Per-attempt data: a cached copy would describe someone else's attempt.
		res.setHeader("Cache-Control", "no-store");
		res.end(req.method === "HEAD" ? undefined : payload);
	};
}

/**
 * Refuses any request whose target resolves outside the mount root.
 *
 * `serve-static` and `send` contain requests lexically, which a symlink inside the
 * root defeats. Runway's asset roots are consumer-supplied, so containment is
 * re-checked against the real path — including the directory index, so an escaping
 * `index.html` cannot be reached through the directory either.
 *
 * The path checked here is the one the library will use. That is only true because
 * {@link unsupportedTargetReason} has already refused the targets that would give
 * `parseurl` a different answer than a `?`-only split; stepping aside for a path
 * that does not resolve is safe for the same reason, since the library is then
 * looking for the very same missing file rather than some other, existing one.
 */
function containmentGuard(rootReal: string, indexFile: string): FixtureHandler {
	return (req, res, next) => {
		const { rawPath } = splitTarget(req.url ?? "/");
		const decoded = decodeRequestPath(rawPath);
		// Malformed encodings stay the library's answer (400), not this module's.
		if (decoded === null) {
			next();
			return;
		}
		const candidate = path.resolve(rootReal, `.${path.posix.normalize(decoded)}`);
		let resolved: string;
		try {
			resolved = realpathSync(candidate);
		} catch {
			// Nothing there: serve-static owns the 404/403 decision.
			next();
			return;
		}
		if (!withinRoot(rootReal, resolved)) {
			plainResponse(req, res, 403, "path escapes the mount\n");
			return;
		}
		try {
			if (statSync(resolved).isDirectory()) {
				const index = realpathSync(path.join(resolved, indexFile));
				if (!withinRoot(rootReal, index)) {
					plainResponse(req, res, 403, "path escapes the mount\n");
					return;
				}
			}
		} catch {
			// No index to reach; the library answers for the directory itself.
		}
		next();
	};
}

/**
 * Static mount backed by `serve-static`.
 *
 * The root is resolved through `realpath` once at startup, so the library's own
 * lexical containment already applies to the real directory, and dotfiles are
 * denied rather than ignored: a fixture root is a build output, and a request for
 * `.env` or `.git` is never a legitimate fixture asset.
 */
function staticMount(
	root: string,
	setHeaders?: (res: http.ServerResponse, filePath: string) => void
): FixtureHandler {
	const indexFile = "index.html";
	const rootReal = realpathSync(root);
	const serve = serveStatic(rootReal, {
		index: indexFile,
		dotfiles: "deny",
		// The mount owns its 404/405/416 instead of leaking into the next mount.
		fallthrough: false,
		redirect: true,
		acceptRanges: true,
		cacheControl: true,
		etag: true,
		lastModified: true,
		...(setHeaders ? { setHeaders } : {}),
	});
	const guard = containmentGuard(rootReal, indexFile);
	return (req, res, next) => {
		guard(req, res, (error?: unknown) => {
			if (error !== undefined) {
				next(error);
				return;
			}
			serve(req, res, next);
		});
	};
}

/**
 * Single-file mount backed by `send`.
 *
 * The profile named one file and this handler answers one exact URL, so no part of
 * any directory becomes browsable: the path handed to `send` is derived from the
 * resolved entry, never from the request.
 *
 * Authorization and identity are two different questions and are answered in that
 * order. Authorization is containment against the *declared* parent, which is the
 * same directory the profile validated the entry against — a link the profile
 * accepted is accepted here, and nothing else is. Identity is then the canonical
 * file's own parent/basename pair: an accepted entry may be a link into a
 * subdirectory, and pairing its basename with the declared parent would serve a
 * different, same-named file sitting next to the link (or nothing at all) while the
 * profile hashed the real target. A dangling link fails here for the same reason:
 * falling back to a same-named neighbour is exactly the substitution to prevent.
 *
 * This holds whichever path the profile supplies: a declared link or an already
 * canonical file both resolve to the same canonical pair, so the two modules need
 * not agree on which one they store. `send` performs no method check of its own, so
 * GET/HEAD is enforced here.
 */
function fileMount(url: string, declaredFile: string): FixtureHandler {
	const declaredRoot = path.dirname(declaredFile);
	return (req, res, next) => {
		if (splitTarget(req.url ?? "/").rawPath !== url) {
			next();
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			methodNotAllowed(req, res);
			return;
		}
		let canonicalFile: string;
		let canonicalRoot: string;
		try {
			canonicalFile = realpathSync(declaredFile);
			canonicalRoot = realpathSync(declaredRoot);
		} catch {
			// The entry vanished or its link dangles. This mount answers for that one
			// file, so it reports the failure instead of falling through to another
			// mount or another file.
			plainResponse(req, res, 404, "the mounted plugin entry could not be resolved\n");
			return;
		}
		if (!withinRoot(canonicalRoot, canonicalFile)) {
			plainResponse(req, res, 403, "path escapes the mount\n");
			return;
		}
		let servable: boolean;
		try {
			servable = statSync(canonicalFile).isFile();
		} catch {
			servable = false;
		}
		if (!servable) {
			plainResponse(req, res, 404, "the mounted plugin entry is not a regular file\n");
			return;
		}
		send(req, `/${encodeURIComponent(path.basename(canonicalFile))}`, {
			root: path.dirname(canonicalFile),
			index: false,
			// The profile named this exact file; a dotfile it named is still served.
			dotfiles: "allow",
		})
			.on("headers", (response: http.ServerResponse) => {
				// Set before `send` fills in its own caching headers, which it only
				// does when the header is absent.
				response.setHeader("Service-Worker-Allowed", "/");
				response.setHeader("Cache-Control", "no-store");
			})
			.on("error", (cause: unknown) => next(cause))
			.pipe(res);
	};
}

async function listen(server: http.Server, port: number, label: string): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const onError = (error: NodeJS.ErrnoException) => {
			reject(
				new RunwayError(
					"fixtures/server-failed",
					error.code === "EADDRINUSE"
						? `${label} could not bind port ${port}: the port is already in use`
						: `${label} failed to listen on port ${port}: ${error.message}`,
					{
						details: { label, requestedPort: port, code: error.code ?? null },
						remedy:
							port === 0
								? undefined
								: "Omit the port flag to let the operating system allocate a free port.",
						cause: error,
					}
				)
			);
		};
		server.once("error", onError);
		// Loopback only: fixture servers must never be reachable off-host.
		server.listen(port, "127.0.0.1", () => {
			server.removeListener("error", onError);
			resolve((server.address() as AddressInfo).port);
		});
	});
}

function closeServer(server: http.Server, owned: Set<Socket>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		for (const socket of [...owned]) {
			try {
				socket.destroy();
			} catch {
				// already closed
			}
		}
		const timer = setTimeout(() => {
			reject(
				new RunwayError(
					"fixtures/server-failed",
					"a fixture server did not close before the cleanup deadline",
					{ details: { remainingConnections: owned.size } }
				)
			);
		}, 5_000);
		server.close((error) => {
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		});
	});
}

/** Starts the harness, bare and wisp servers described by the plan. */
export async function startLocalFixtures(options: {
	readonly plan: LocalFixturePlan;
	readonly profile: LoadedPluginProfile;
	/**
	 * How long `close` waits for in-flight upstream attempts. Defaults to
	 * {@link UPSTREAM_SHUTDOWN_DEADLINE_MS}; a caller only sets it to make the
	 * bounded wait observable.
	 */
	readonly shutdownDeadlineMs?: number;
	/**
	 * Host-side sink for failed fixture requests.
	 *
	 * It receives what the client was *not* told, including absolute host paths from
	 * filesystem errors, so it belongs to the host's own diagnostics. A throwing sink
	 * is ignored: a diagnostic must not decide whether a response is sent.
	 */
	readonly onRequestFailure?: (failure: FixtureRequestFailure) => void;
}): Promise<LocalFixtures> {
	const { plan, profile } = options;
	const onRequestFailure = options.onRequestFailure;
	const reportFailure = (failure: FixtureRequestFailure): void => {
		if (!onRequestFailure) return;
		try {
			onRequestFailure(failure);
		} catch {
			// A diagnostic sink is not part of the response path.
		}
	};
	const shutdownDeadlineMs =
		typeof options.shutdownDeadlineMs === "number" && options.shutdownDeadlineMs > 0
			? options.shutdownDeadlineMs
			: UPSTREAM_SHUTDOWN_DEADLINE_MS;
	const observer = new RouteObserver();
	installRouteObserver(observer);
	const ownedSockets = new Set<Socket>();
	const trackSocket = (socket: Socket): void => {
		ownedSockets.add(socket);
		socket.on("close", () => ownedSockets.delete(socket));
	};

	/**
	 * Shutdown state shared with every wisp callback.
	 *
	 * It is read live rather than captured: a socket wrapper built during an
	 * attempt can have its `connect` invoked long afterwards, possibly after the
	 * fixture servers were already swept.
	 */
	const shutdown = { closing: false };
	const upstreams = new Set<UpstreamAttempt>();
	let nextUpstreamId = 1;
	const destroyUpstreamSocket = (socket: WispNodeSocket | null): void => {
		if (!socket || typeof socket.destroy !== "function") return;
		try {
			// Destroying *with* an error is what makes wisp's own connect promise
			// reject (`net.mjs` only rejects from a close that carried an error); a
			// plain destroy() leaves that promise pending forever, so the shutdown
			// would then be waiting on something that can never settle.
			socket.destroy(new Error("the runway fixtures closed while this upstream was in flight"));
		} catch {
			// already destroyed
		}
	};
	const registerUpstream = (input: {
		readonly attempt: string;
		readonly destHost: string;
		readonly destPort: number;
		readonly cancel: () => void;
	}): UpstreamAttempt => {
		let release: () => void = () => undefined;
		const finished = new Promise<void>((resolve) => {
			release = resolve;
		});
		const upstream: UpstreamAttempt = {
			id: nextUpstreamId++,
			attempt: input.attempt,
			destHost: input.destHost,
			destPort: input.destPort,
			stage: "lookup",
			cancelled: false,
			releasedEarly: false,
			settled: false,
			filterRefusal: null,
			finished,
			release,
			cancel: input.cancel,
		};
		upstreams.add(upstream);
		return upstream;
	};
	const settleUpstream = (upstream: UpstreamAttempt, stage: UpstreamStage): void => {
		if (upstream.settled) return;
		upstream.settled = true;
		upstream.stage = stage;
		upstreams.delete(upstream);
		upstream.release();
	};
	const refuseUpstream = (upstream: UpstreamAttempt): RunwayError =>
		new RunwayError(
			"fixtures/server-failed",
			`the runway fixtures are closing, so the wisp upstream to ${upstream.destHost}:${upstream.destPort} was refused`,
			{ details: upstreamDetail(upstream) }
		);
	const trackServer = (server: http.Server): void => {
		server.on("connection", trackSocket);
	};
	const attemptFromPath = (pathname: string): string | null => {
		const segments = pathname.split("/").filter((segment) => segment !== "");
		if (segments[0] !== ATTEMPT_PATH_PREFIX || segments[1] === undefined) return null;
		return decodeURIComponent(segments[1]);
	};

	/** Filled in once the harness socket reports the port it actually bound. */
	const harnessPortHolder = { port: 0 };

	// ---- wisp -------------------------------------------------------------
	const wispServer = http.createServer((_req, res) => {
		res.writeHead(426, { "Content-Type": "text/plain" });
		res.end("This endpoint only accepts websocket upgrades");
	});
	trackServer(wispServer);
	const previousLoopback = wisp.options.allow_loopback_ips;
	const previousPrivate = wisp.options.allow_private_ips;
	// Fixture origins are loopback. Private/LAN ranges stay refused unless a test
	// declares remoteNetwork (handled by leaving public hostnames on the default
	// allow path; we do not flip allow_private_ips).
	wisp.options.allow_loopback_ips = true;
	wisp.options.allow_private_ips = false;
	logging.set_level(logging.NONE);

	const wispEntry = fileURLToPath(import.meta.resolve("@mercuryworkshop/wisp-js/server"));
	const wispNet = (await import(
		pathToFileURL(path.join(path.dirname(wispEntry), "../server/net.mjs")).href
	)) as {
		NodeTCPSocket: new (
			hostname: string,
			port: number
		) => {
			hostname: string;
			port: number;
			socket: WispNodeSocket | null;
			connect: () => Promise<void>;
			close: () => Promise<void>;
		};
	};
	const { NodeTCPSocket } = wispNet;
	// Correlates wisp's own filter decisions back to this fixture's attempts. No DNS
	// is repeated and no lookup is inferred; see `installFilterRefusalHook`.
	installFilterRefusalHook(
		(wisp as unknown as { ServerConnection: { prototype: WispServerConnection } })
			.ServerConnection
	);

	wispServer.on("upgrade", (req, socket, head) => {
		const attempt = attemptFromPath(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
		if (shutdown.closing) {
			// A closing fixture admits no new transport. The refusal is recorded when
			// the attempt is known, because a dropped upgrade is evidence too.
			observer.rejectHandshake(attempt);
			socket.destroy();
			return;
		}
		if (!attempt) {
			observer.rejectHandshake(null);
			socket.destroy();
			return;
		}
		observer.handshake(attempt);
		trackSocket(socket as Socket);
		const ObservedTCPSocket = function ObservedTCPSocket(hostname: string, port: number) {
			const inner = new NodeTCPSocket(hostname, port);
			const wrapped = inner as typeof inner & {
				connect: () => Promise<void>;
				close: () => Promise<void>;
			};
			const originalConnect = inner.connect.bind(inner);
			const originalClose = inner.close.bind(inner);
			/**
			 * wisp assigns its node socket inside its own connect promise, and drops
			 * that reference again in `close()`. Capturing the assignment keeps a
			 * reference this fixture can still destroy, tracks the socket for the
			 * shutdown sweep from the moment it exists, and destroys a socket that
			 * only appeared after the shutdown began.
			 */
			let node: WispNodeSocket | null = inner.socket;
			Object.defineProperty(inner, "socket", {
				configurable: true,
				enumerable: true,
				get: () => node,
				set: (value: WispNodeSocket | null) => {
					node = value;
					if (!value || typeof value.destroy !== "function") return;
					trackSocket(value as unknown as Socket);
					if (!shutdown.closing && !upstream.cancelled) return;
					// Destroying inside this setter would be undone: wisp calls
					// `connect()` on the same socket in the same synchronous block, and
					// node revives a destroyed socket on connect. One microtask later is
					// still long before the TCP handshake can complete, so no traffic can
					// pass.
					queueMicrotask(() => destroyUpstreamSocket(value));
				},
			});
			// Ownership starts at construction, not at connect: wisp resolves the
			// destination in its stream filter before it calls connect(), so an
			// upstream that is still only a pending lookup already belongs to this
			// fixture's shutdown.
			const upstream = registerUpstream({
				attempt,
				destHost: hostname,
				destPort: port,
				cancel: () => destroyUpstreamSocket(node),
			});
			// Bound to the stream wisp is constructing this socket for, so wisp's filter
			// decision for *this* attempt can be attributed back to it. A refusal means
			// the filter ran to completion and denied the destination, which is the one
			// close this fixture can treat as final: connect() can no longer be reached,
			// so the attempt is over whether or not a shutdown is running.
			const retireFilterDecision = bindFilterRefusal((reason: number) => {
				upstream.filterRefusal = reason;
				settleUpstream(upstream, "refused");
			});
			wrapped.connect = async () => {
				// Reaching connect() *is* wisp's filter having allowed this stream, so the
				// decision is final and its registration is retired here — first thing, so
				// it is retired whether this attempt goes on to connect, to fail, or to be
				// refused by the shutdown below. Only this registration is removed, and a
				// still-pending decision is never retired by a stream closing.
				retireFilterDecision();
				if (shutdown.closing || upstream.cancelled) {
					// No socket exists yet, and none may be created now. wisp turns this
					// into its own NetworkError stream close.
					settleUpstream(upstream, "refused");
					throw refuseUpstream(upstream);
				}
				upstream.stage = "connecting";
				try {
					await originalConnect();
				} catch (cause) {
					settleUpstream(upstream, "failed");
					throw cause;
				}
				if (shutdown.closing || upstream.cancelled) {
					// The handshake outlived the shutdown that was supposed to own it.
					// Destroy it before wisp starts its proxy tasks, then fail the stream
					// through wisp's own error path so nothing is ever forwarded.
					upstream.cancel();
					settleUpstream(upstream, "refused");
					throw refuseUpstream(upstream);
				}
				settleUpstream(upstream, "connected");
				if (!node) return;
				const local = endpointFromSocket(node, "local");
				const remote = endpointFromSocket(node, "remote");
				if (!local || !remote) return;
				const observed = node;
				observer.acceptedStream({
					attempt,
					local,
					remote,
					destHost: hostname,
					destPort: port,
					onClose: (close) => {
						observed.on("close", close);
					},
				});
			};
			wrapped.close = async () => {
				// wisp is done with this stream. While the fixtures are healthy that
				// releases the attempt: nothing this fixture owns can still become a live
				// socket once wisp has torn the stream down.
				//
				// During a shutdown this callback says nothing on its own, and is
				// deliberately not treated as a decision. A filter refusal has already
				// settled this attempt through `installFilterRefusalHook` before wisp gets
				// here,
				// and a close that arrives for any other reason — a client's close, the
				// shutdown's own socket sweep — can still be followed by the filter
				// allowing the stream and calling connect(). Guessing here is what made a
				// still-pending attempt look finished; an attempt with no observed filter
				// decision stays outstanding, and the deadline reports it honestly.
				if (!shutdown.closing && !upstream.settled) upstream.releasedEarly = true;
				await originalClose();
			};
			return wrapped;
		};
		try {
			wisp.routeRequest(req, socket, head, { TCPSocket: ObservedTCPSocket });
		} catch {
			observer.rejectHandshake(attempt);
			socket.destroy();
		}
	});
	const wispPort = await listen(wispServer, plan.requestedWispPort, "The wisp server");
	const wispOrigin = `ws://127.0.0.1:${wispPort}`;

	// ---- scramjet harness -------------------------------------------------
	// Endpoints are data the page reads, never script Runway injects, and the
	// attempt nonce travels with them so wisp upgrades stay attributable.
	const attemptOf = (req: MountRequest): string | null => {
		const { search } = splitTarget(req.url ?? "/");
		if (search === "") return null;
		const values = new URLSearchParams(search).getAll(ATTEMPT_QUERY_PARAM);
		// A repeated parameter is ambiguous and is not an attempt nonce.
		return values.length === 1 ? (values[0] ?? null) : null;
	};
	const pluginMounts: FixtureHandler[] = profile.mounts.map((mount) =>
		mount.kind === "file"
			? fileMount(mount.url, mount.file)
			: mountAt(
					mount.url,
					staticMount(mount.directory, (res) => {
						// Plugin assets are per-run and must not be reused across attempts.
						res.setHeader("Service-Worker-Allowed", "/");
						res.setHeader("Cache-Control", "no-store");
					})
				)
	);
	const harnessServer = http.createServer(
		createDispatcher([
			jsonRoute("/runway-plugin-profile.json", () => profile.profile),
			jsonRoute("/runway-harness-config.json", (req) => {
				const attempt = attemptOf(req);
				return {
					// Transport clients require a trailing slash, so the attempt nonce is
					// a path segment.
					wispUrl: attempt
						? `${wispOrigin}/${ATTEMPT_PATH_PREFIX}/${encodeURIComponent(attempt)}/`
						: `${wispOrigin}/`,
					harnessOrigin: `http://127.0.0.1:${harnessPortHolder.port}`,
					attempt,
				};
			}),
			...pluginMounts,
			mountAt("/scramjet", staticMount(plan.scramjetDist)),
			mountAt(
				"/controller",
				staticMount(plan.controllerDist, (res, filePath) => {
					// Only the native service worker may claim a wider scope.
					if (filePath.endsWith("controller.native-sw.js")) {
						res.setHeader("Service-Worker-Allowed", "/");
					}
				})
			),
			mountAt("/libcurl", staticMount(plan.libcurlDist)),
			staticMount(path.join(harnessRoot, "scramjet", "public")),
		], reportFailure)
	);
	trackServer(harnessServer);
	harnessPortHolder.port = await listen(
		harnessServer,
		plan.requestedHarnessPort,
		"The harness server"
	);
	const harnessOrigin = `http://127.0.0.1:${harnessPortHolder.port}`;

	// ---- bare harness -----------------------------------------------------
	const bareServer = http.createServer(
		createDispatcher([staticMount(path.join(harnessRoot, "bare", "public"))], reportFailure)
	);
	trackServer(bareServer);
	const barePort = await listen(bareServer, plan.requestedBarePort, "The bare server");
	const bareOrigin = `http://127.0.0.1:${barePort}`;

	const provenance: readonly FixtureProvenance[] = Object.freeze([
		Object.freeze({
			kind: "runway-local-harness",
			origin: harnessOrigin,
			identity: Object.freeze({
				scramjetDist: plan.scramjetDist,
				controllerDist: plan.controllerDist,
				libcurlDist: plan.libcurlDist,
				pluginProfile: profile.profile.name,
			}),
			capabilities: Object.freeze([CAPABILITIES.localFixtures, CAPABILITIES.proxyRoute]),
		}),
		Object.freeze({
			kind: "runway-local-bare",
			origin: bareOrigin,
			identity: Object.freeze({}),
			capabilities: Object.freeze([CAPABILITIES.localFixtures]),
		}),
		Object.freeze({
			kind: "runway-local-wisp",
			origin: wispOrigin,
			identity: Object.freeze({}),
			capabilities: Object.freeze([CAPABILITIES.proxyRoute]),
		}),
	]);

	/**
	 * Shutdown, owned by this instance and settled exactly once.
	 *
	 * Repeated calls return the same settlement instead of sweeping again, so a
	 * caller that closes in a `finally` and again on an error path cannot observe
	 * two different outcomes.
	 */
	let closing: Promise<void> | null = null;
	const close = (): Promise<void> => {
		if (closing) return closing;
		closing = (async () => {
			shutdown.closing = true;
			try {
				// Claim every in-flight upstream before the sweep. A socket that only
				// appears afterwards is destroyed by the capture hook; one that exists
				// now is destroyed with an error so wisp's connect promise rejects.
				const claimed = [...upstreams].filter((upstream) => !upstream.releasedEarly);
				for (const upstream of [...upstreams]) {
					upstream.cancelled = true;
					upstream.cancel();
				}
				const serverOutcomes = await Promise.allSettled(
					[harnessServer, bareServer, wispServer].map((server) =>
						closeServer(server, ownedSockets)
					)
				);
				const stillPending = await waitForUpstreams(claimed, shutdownDeadlineMs);
				const serverFailures = serverOutcomes.filter(
					(outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
				);
				if (serverFailures.length === 0 && stillPending.length === 0) return;
				throw new RunwayError(
					"fixtures/server-failed",
					stillPending.length > 0
						? `the fixtures did not shut down cleanly: ${stillPending.length} wisp upstream attempt(s) were still in flight after ${shutdownDeadlineMs}ms`
						: "the fixtures did not shut down cleanly",
					{
						details: {
							shutdownDeadlineMs,
							outstandingUpstreams: stillPending.map(upstreamDetail),
							serverFailures: serverFailures.map((failure) =>
								failure.reason instanceof Error
									? failure.reason.message
									: String(failure.reason)
							),
						},
						...(serverFailures[0] ? { cause: serverFailures[0].reason } : {}),
					}
				);
			} finally {
				// Restored last and unconditionally: the drain above still needs wisp's
				// own filter to behave as it did during the run, and a reported cleanup
				// failure must never leave this process patched. The observer is only
				// uninstalled while it is still the installed one, so a later fixture
				// instance is not clobbered by an earlier instance's shutdown.
				wisp.options.allow_loopback_ips = previousLoopback;
				wisp.options.allow_private_ips = previousPrivate;
				if (activeRouteObserver() === observer) installRouteObserver(null);
			}
		})();
		return closing;
	};

	return Object.freeze({
		harnessOrigin,
		bareOrigin,
		wispOrigin,
		observer,
		watchAttempt: (nonce: string, watch: AttemptWatch) => {
			observer.watch(nonce, watch);
		},
		routeObservation: (nonce: string) => observer.observation(nonce),
		forgetAttempt: (nonce: string) => {
			observer.forget(nonce);
		},
		provenance,
		close,
	});
}
