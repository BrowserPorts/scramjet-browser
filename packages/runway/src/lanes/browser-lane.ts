/**
 * Browser lanes: `bare` (direct, reference) and `scramjet` (proxied, candidate).
 *
 * Both lanes drive the same browser build through the same in-page payload; the
 * only difference is which harness origin they attach to and, for the candidate,
 * the host-side transport evidence. Each attempt runs in its own disposable
 * profile so cookies, storage and service-worker registrations cannot leak between
 * tests, and every page result must carry the attempt's nonce before it is
 * attributed to that test.
 *
 * Three properties are load-bearing here and are implemented once, in this file:
 *
 * - The attempt's deadline drives *every* phase. Acquiring a profile, navigating,
 *   waiting for readiness, verifying plugins and collecting artifacts all run
 *   under the caller's signal, and an abort closes the profile so an in-page
 *   promise that never settles cannot outlive the attempt.
 * - The plugin verifier expectation is fixed while the attempt initializes, from
 *   the profile the *host* served and the harness's own initialization receipt. A
 *   hook that later vanishes or answers for different modules is `unavailable`,
 *   never "this profile has no verifiers".
 * - Admission is sealed before the host samples its final observations. After the
 *   seal a page binding is refused with an explicit error and counted; it is never
 *   accepted and then dropped behind a record that has already been written.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, ElementHandle, Frame, Page } from "playwright";
import { CDP_INIT_SCRIPT } from "../cdp-init.ts";
import { RunwayError, serializeError } from "../core/errors.ts";
import type { LaneId, Nonce } from "../core/ids.ts";
import type {
	ArtifactRef,
	LaneEvidence,
	LaneProvenance,
	TruncationNote,
} from "../core/protocol.ts";
import type { BrowserOwner, ContextHandle } from "../browser/owner.ts";
import { ATTEMPT_QUERY_PARAM, type AttemptRouteObservation } from "../fixtures/servers.ts";
import type {
	AttemptRequest,
	CleartextMapping,
	Lane,
	LaneAttempt,
	LaneCapability,
	LaneHostIntegration,
	LaneRouteVerdict,
	LaneTransportCapability,
	LaneUrlAdmission,
	PageResult,
	PluginAssertionFailure,
	PluginAssertionReport,
	PluginVerifierExpectation,
} from "./lane.ts";

/** Bindings the retained in-page payload calls. */
const RESULT_BINDINGS = ["__testPass", "__testFail", "__testOk", "__testConsistent"] as const;

/** Query parameter the in-page payload echoes back with every result. */
export const NONCE_QUERY_PARAM = "runway_token";

/** Path the harness serves the host-authored plugin profile on. */
const PROFILE_PATH = "/runway-plugin-profile.json";

export type BindingPayload = {
	readonly message?: unknown;
	readonly details?: unknown;
	readonly label?: unknown;
	readonly value?: unknown;
	readonly __runwayToken?: unknown;
};

/** Whether a consistency report may reach the cross-lane broker. */
export type ConsistencyAdmission = {
	readonly admitted: boolean;
	/**
	 * The label exactly as the page sent it, including a missing or empty one.
	 *
	 * The lane does not validate labels and never invents one: the broker owns the
	 * label contract, and a value with no explicit label has to reach it verbatim so
	 * it is refused as `invalidLabel` instead of being bucketed under a name the page
	 * never chose — which would pair two unrelated observations across lanes.
	 */
	readonly label: unknown;
	/** Present when the value was refused. */
	readonly reason?: "unattributed" | "sealed";
};

/** Renders an untrusted label for a message without asserting it is one. */
export function describeConsistencyLabel(label: unknown): string {
	if (typeof label === "string") return JSON.stringify(label);
	try {
		return `<${typeof label}: ${String(label)}>`;
	} catch {
		return `<${typeof label}>`;
	}
}

/**
 * Decides admission for one consistency report, before the broker sees it.
 *
 * The broker compares lanes against each other, so an unattributed value is an
 * opportunity for one page to answer for the opposite lane. Attribution is
 * therefore checked *first* and decided here: a value without this attempt's nonce
 * is never submitted, however well-formed its label is.
 */
export function consistencyAdmission(
	payload: BindingPayload,
	nonce: string
): ConsistencyAdmission {
	if (payload.__runwayToken !== nonce) {
		return { admitted: false, label: payload.label, reason: "unattributed" };
	}
	return { admitted: true, label: payload.label };
}

/** One module as named by the harness's initialization receipt. */
export type ReceiptModule = {
	readonly module: string;
	readonly verify: boolean;
};

/** The harness's plugin initialization receipt, as read out of the page. */
export type HarnessPluginReceipt = {
	readonly profile: string | null;
	readonly modules: readonly ReceiptModule[];
};

/** The plugin profile the *host* served to this lane. */
export type ServedProfile = {
	readonly name: string;
	/** Module URLs the profile configured, in profile order. */
	readonly modules: readonly string[];
};

/** A normalized reply from the harness's verifier hook. */
export type PluginVerifyReply = {
	readonly profile: string | null;
	readonly modules: readonly ReceiptModule[];
	readonly invoked: readonly string[];
	readonly failures: readonly unknown[];
	/** The URL the harness says it verified. */
	readonly target: string | null;
};

/** Turns the harness's per-plugin entries into structured failures. */
export function normalizePluginFailures(
	entries: readonly unknown[]
): readonly PluginAssertionFailure[] {
	return entries.map((entry) => {
		if (entry && typeof entry === "object") {
			const record = entry as { module?: unknown; error?: unknown; message?: unknown };
			const message =
				typeof record.error === "string"
					? record.error
					: typeof record.message === "string"
						? record.message
						: JSON.stringify(record);
			return {
				module: typeof record.module === "string" ? record.module : null,
				message,
				details: entry,
			};
		}
		return { module: null, message: String(entry), details: entry };
	});
}

function readReceiptModules(value: unknown): readonly ReceiptModule[] | null {
	if (!Array.isArray(value)) return null;
	const modules: ReceiptModule[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") return null;
		const record = entry as { module?: unknown; verify?: unknown };
		if (typeof record.module !== "string" || typeof record.verify !== "boolean") return null;
		modules.push({ module: record.module, verify: record.verify });
	}
	return modules;
}

/** Reads an initialization receipt out of an untrusted page value. */
export function normalizeReceipt(value: unknown): HarnessPluginReceipt | null {
	if (!value || typeof value !== "object") return null;
	const record = value as { profile?: unknown; modules?: unknown };
	const modules = readReceiptModules(record.modules);
	if (modules === null) return null;
	return {
		profile: typeof record.profile === "string" ? record.profile : null,
		modules,
	};
}

/** Reads a verifier reply out of an untrusted page value. */
export function normalizeVerifyReply(value: unknown): PluginVerifyReply | null {
	if (!value || typeof value !== "object") return null;
	const record = value as {
		profile?: unknown;
		modules?: unknown;
		invoked?: unknown;
		failures?: unknown;
		testURL?: unknown;
	};
	const modules = readReceiptModules(record.modules);
	if (modules === null) return null;
	if (!Array.isArray(record.invoked) || !Array.isArray(record.failures)) return null;
	if (!record.invoked.every((entry) => typeof entry === "string")) return null;
	return {
		profile: typeof record.profile === "string" ? record.profile : null,
		modules,
		invoked: record.invoked as readonly string[],
		failures: record.failures as readonly unknown[],
		target: typeof record.testURL === "string" ? record.testURL : null,
	};
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameModules(left: readonly ReceiptModule[], right: readonly ReceiptModule[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(entry, index) =>
				entry.module === right[index]?.module && entry.verify === right[index]?.verify
		)
	);
}

/**
 * Fixes what this lane's verifiers are expected to be, once, at initialization.
 *
 * The two inputs are deliberately of different provenance: `profile` is what the
 * host served, and `receipt` is what the harness says it loaded. Correlating them
 * is the only way the host can tell "this profile declared no verifier" (which is
 * allowed) from "the verifier that was declared is no longer there" (which fails
 * the attempt closed). A guest can still lie about its own behaviour — that is why
 * a satisfied verifier is never owner proof — but it cannot make a configured
 * verifier disappear from the expectation by deleting a global.
 */
export function correlateVerifierExpectation(input: {
	readonly adapter: "bare" | "scramjet";
	readonly profile: ServedProfile | null;
	readonly profileError?: string | null;
	readonly receipt: HarnessPluginReceipt | null;
}): PluginVerifierExpectation {
	const { adapter, profile, receipt } = input;
	if (adapter === "bare") {
		// The reference lane never loads the plugin harness. One that answers with a
		// receipt is not the reference lane the comparison assumed.
		if (receipt) {
			return {
				kind: "uncorrelated",
				profileName: receipt.profile,
				modules: receipt.modules.map((entry) => entry.module),
				verifiers: receipt.modules.filter((entry) => entry.verify).map((entry) => entry.module),
				detail:
					"the reference lane exposed a plugin initialization receipt, so it is not running " +
					"the unmodified reference harness",
			};
		}
		return { kind: "noProfile", profileName: null, modules: [], verifiers: [] };
	}
	if (!profile) {
		return {
			kind: "unresolved",
			profileName: null,
			modules: [],
			verifiers: [],
			detail:
				input.profileError ??
				`the host could not read the plugin profile it serves at ${PROFILE_PATH}`,
		};
	}
	if (!receipt) {
		return {
			kind: "unresolved",
			profileName: profile.name,
			modules: [],
			verifiers: [],
			detail:
				`the harness did not publish a plugin initialization receipt for profile ` +
				`${JSON.stringify(profile.name)}`,
		};
	}
	const loaded = receipt.modules.map((entry) => entry.module);
	if (!sameList(loaded, profile.modules)) {
		return {
			kind: "uncorrelated",
			profileName: profile.name,
			modules: loaded,
			verifiers: receipt.modules.filter((entry) => entry.verify).map((entry) => entry.module),
			detail:
				`the harness loaded [${loaded.join(", ")}] but the host served ` +
				`[${profile.modules.join(", ")}]`,
		};
	}
	const verifiers = receipt.modules
		.filter((entry) => entry.verify)
		.map((entry) => entry.module);
	return {
		// A configured module that declares no verifier is an authored choice, and
		// is recorded as such rather than as a missing hook.
		kind: verifiers.length > 0 ? "required" : "noVerifiers",
		profileName: profile.name,
		modules: loaded,
		verifiers,
	};
}

/**
 * Judges one verifier reply against the expectation fixed at initialization.
 *
 * Every path that cannot *prove* the expected verifiers ran over the requested
 * target ends in `unavailable`. A reply is only `satisfied` when the expected
 * modules were the modules invoked, for the URL that was asked about.
 */
export function judgeVerifyReply(input: {
	readonly expectation: PluginVerifierExpectation;
	readonly reply: PluginVerifyReply | null;
	readonly target: string | null;
	/** Why no reply could be obtained, when `reply` is null. */
	readonly unavailableReason?: string;
}): PluginAssertionReport {
	const { expectation, reply, target } = input;
	const base = { expectation, target } as const;
	const unavailable = (reason: string): PluginAssertionReport => ({
		...base,
		status: "unavailable",
		failures: [],
		invoked: reply?.invoked ?? [],
		unavailableReason: reason,
	});

	if (expectation.kind === "uncorrelated" || expectation.kind === "unresolved") {
		return unavailable(
			expectation.detail ??
				`the plugin verifier expectation for this attempt is ${expectation.kind}`
		);
	}
	if (expectation.kind === "noProfile") {
		return { ...base, status: "none", failures: [], invoked: [] };
	}
	if (!reply) {
		if (expectation.kind === "noVerifiers") {
			// Nothing was expected to run, so nothing is missing.
			return { ...base, status: "none", failures: [], invoked: [] };
		}
		return unavailable(
			input.unavailableReason ??
				`the verifier hook for [${expectation.verifiers.join(", ")}] was not available when ` +
					"this attempt asked for it"
		);
	}
	if (!sameModules(reply.modules, expectation.modules.map((module) => ({
		module,
		verify: expectation.verifiers.includes(module),
	})))) {
		return unavailable(
			"the harness reported different plugin modules than it did at initialization: " +
				`[${reply.modules.map((entry) => `${entry.module}:${entry.verify}`).join(", ")}]`
		);
	}
	if (!sameList([...reply.invoked].sort(), [...expectation.verifiers].sort())) {
		return unavailable(
			`the harness invoked [${reply.invoked.join(", ")}] but the modules that declared a ` +
				`verifier at initialization were [${expectation.verifiers.join(", ")}]`
		);
	}
	if (reply.target !== target) {
		return unavailable(
			`the harness verified ${JSON.stringify(reply.target)} but was asked about ` +
				`${JSON.stringify(target)}`
		);
	}
	const failures = normalizePluginFailures(reply.failures);
	if (failures.length > 0) {
		return { ...base, status: "violated", failures, invoked: reply.invoked };
	}
	if (expectation.kind === "noVerifiers") {
		return { ...base, status: "none", failures: [], invoked: reply.invoked };
	}
	return { ...base, status: "satisfied", failures: [], invoked: reply.invoked };
}

export type BrowserLaneOptions = {
	readonly laneId: LaneId;
	readonly role: "reference" | "candidate";
	readonly adapter: "bare" | "scramjet";
	readonly origin: string;
	readonly owner: BrowserOwner;
	/** Hashes of everything this lane loads, recorded as lane provenance. */
	readonly loaded: Readonly<Record<string, string>>;
	/** Host-side transport observation. Candidate lanes must supply one. */
	readonly routeObservation?: (nonce: string) => AttemptRouteObservation;
	readonly readyTimeoutMs: number;
	/** Records raw V8 JS coverage for each attempt. */
	readonly collectCoverage?: boolean;
	/** Records page console output and uncaught errors for each attempt. */
	readonly traceConsole?: boolean;
};

/** Console transcripts are capped; what is dropped is reported, not hidden. */
const CONSOLE_BUDGET_BYTES = 256 * 1024;

/**
 * How many accepted page failures keep their message and details.
 *
 * A record has to stay a bounded document, and a page in a loop can report failures
 * without limit. Only the *detail* is bounded: the counts of what was accepted and
 * what was dropped are exact, so a dropped failure still fails the attempt.
 */
const FAILURE_RETENTION = 16;

function parsePayload(raw: string): BindingPayload {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as BindingPayload;
		}
		return { message: String(parsed) };
	} catch {
		return { message: raw };
	}
}

function messageOf(payload: BindingPayload): string | null {
	return typeof payload.message === "string" && payload.message.length > 0
		? payload.message
		: null;
}

function describe(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** Reads the host-served plugin profile for this lane. Host-side, never via the page. */
async function fetchServedProfile(
	origin: string,
	timeoutMs: number
): Promise<{ readonly profile: ServedProfile | null; readonly error: string | null }> {
	const url = new URL(PROFILE_PATH, origin).toString();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 1));
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) {
			return { profile: null, error: `${url} answered ${response.status}` };
		}
		const body: unknown = await response.json();
		if (!body || typeof body !== "object") {
			return { profile: null, error: `${url} did not answer with a profile object` };
		}
		const record = body as { name?: unknown; plugins?: unknown };
		if (typeof record.name !== "string" || !Array.isArray(record.plugins)) {
			return { profile: null, error: `${url} answered without a name and a plugins array` };
		}
		const modules: string[] = [];
		for (const entry of record.plugins) {
			const plugin = entry as { url?: unknown };
			if (!plugin || typeof plugin.url !== "string") {
				return { profile: null, error: `${url} listed a plugin without a module url` };
			}
			modules.push(plugin.url);
		}
		return { profile: { name: record.name, modules }, error: null };
	} catch (cause) {
		return {
			profile: null,
			error: `${url} could not be read by the host: ${describe(cause)}`,
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The iframe both harnesses run the case document in.
 *
 * Neither lane runs a case in the page's main frame: the main frame is the
 * harness/controller document, and the case is a child of it. Designating the main
 * frame would attribute the harness's own activity to the case and reject the real
 * arrivals, and opening a second page to get a "main frame case" would be a page
 * this lane never routed.
 */
const CASE_FRAME_SELECTOR = "#testframe";

/**
 * Canonical form for comparing two document URLs.
 *
 * Path and query are preserved exactly, because a WPT variant *is* its query: a
 * basename or same-origin comparison would make `?include=a` and `?include=b` the
 * same case, which is the specific mistake that makes a mapping useless. The
 * fragment is dropped, and only the fragment: scrolling to an anchor does not make
 * a document a different document.
 *
 * Returns `null` for anything that is not a parseable URL, which the callers turn
 * into `unverified` rather than guessing.
 */
function canonicalDocumentUrl(value: string): string | null {
	try {
		const url = new URL(value);
		url.hash = "";
		return url.href;
	} catch {
		return null;
	}
}

/**
 * Compares an observed document URL against the physical URL the lane produced.
 *
 * The lane's configured route prefix is not compared separately, because the
 * encoder already put it into `physicalUrl`: checking it again would be comparing
 * the same bytes twice and would not catch anything this does not.
 *
 * This holds no expectation of its own. The caller passes the currently expected
 * pair on every call, so a same-frame cross-document relocation is assessed against
 * the mapping in force at that moment, and an unexpected redirect lands on
 * `mismatch` instead of being absorbed into a match it did not earn.
 */
function verifyAgainstPhysical(input: {
	readonly observedUrl: string;
	readonly physicalUrl: string;
}): LaneRouteVerdict {
	// Nothing has been navigated yet, so there is no expectation to test against.
	if (input.physicalUrl === "") return "unverified";
	const observed = canonicalDocumentUrl(input.observedUrl);
	const expected = canonicalDocumentUrl(input.physicalUrl);
	if (observed === null || expected === null) return "unverified";
	return observed === expected ? "match" : "mismatch";
}

/** The controller-side bridge the scramjet harness publishes. */
type CaseFrameBridgeSnapshot = {
	readonly prefix: string;
	readonly cleartextWrapperInstalled: boolean;
	readonly cleartextEnabled: boolean;
	readonly cleartextRoots: readonly string[];
};

/**
 * Builds this attempt's host integration, or says plainly that it has none.
 *
 * Resolved before anything is navigated. That ordering is the point: the case
 * frame's element handle is captured while the only DOM in the page is the
 * harness's own, so the identity cannot be influenced by a document that has not
 * loaded yet. A same-origin guest that later injects a lookalike `#testframe` into
 * the harness document does not change the handle already retained here.
 */
async function buildHostIntegration(input: {
	readonly page: Page;
	readonly adapter: "bare" | "scramjet";
	readonly laneId: LaneId;
}): Promise<LaneCapability<LaneHostIntegration>> {
	const { page, adapter, laneId } = input;

	// Captured now, by identity, and reused for every later designation.
	let element: ElementHandle<SVGElement | HTMLElement> | null = null;
	try {
		element = await page.waitForSelector(CASE_FRAME_SELECTOR, {
			state: "attached",
			timeout: 10_000,
		});
	} catch (cause) {
		return Object.freeze({
			available: false as const,
			reason:
				`the ${laneId} harness published no ${CASE_FRAME_SELECTOR} case frame, so no ` +
				`frame could be designated before navigation: ${describe(cause)}`,
			detail: Object.freeze({ laneId, adapter, selector: CASE_FRAME_SELECTOR }),
		});
	}
	const caseElement = element;

	const caseFrame = Object.freeze({
		describe: `${adapter} lane case frame (${CASE_FRAME_SELECTOR})`,
		locate: async (): Promise<Frame> => {
			// Playwright's own element→frame link, resolved from the handle captured
			// before navigation. Never a lookup by frame URL or frame name: both are
			// reachable by guest content, so a helper frame sitting at the identical
			// URL would be indistinguishable from the case.
			const frame = await caseElement.contentFrame();
			if (frame === null) {
				throw new RunwayError(
					"lane/init-failed",
					`the ${laneId} case frame element has no content frame, so no case frame could be designated`,
					{ details: { laneId, adapter, selector: CASE_FRAME_SELECTOR } }
				);
			}
			return frame;
		},
	});

	if (adapter === "bare") {
		// The reference lane navigates the iframe directly, so the physical URL is the
		// logical one. That is a real mapping, not a permissive one: it still has to
		// match exactly, and a redirect away from the case is a mismatch.
		const transport: LaneTransportCapability = Object.freeze({
			engine: "direct" as const,
			cleartextHttpsActive: false,
			cleartextHttpsRoots: Object.freeze([]) as readonly string[],
			// The browser performs its own TLS on this lane; nothing rewrites the scheme.
			realTls: true,
		});
		return Object.freeze({
			available: true as const,
			value: Object.freeze({
				page,
				caseFrame,
				routeMapping: Object.freeze({
					toPhysical: async (logicalUrl: string) => logicalUrl,
					// The logical URL is deliberately not substituted when no physical
					// URL has been computed yet. On this lane the two are equal, so the
					// substitution would look harmless — but it would answer a question
					// about a navigation that has not happened, turning "nothing is
					// expected yet" into a verdict. Both lanes answer that the same way.
					verify: ({ observedUrl, physicalUrl }) =>
						verifyAgainstPhysical({ observedUrl, physicalUrl }),
				}),
				transport,
				admitsLogicalUrl: (logicalUrl: string) => admitLogicalUrl(logicalUrl, transport),
			}),
		});
	}

	// The proxy lane can only answer through the controller that owns rewriting.
	let snapshot: CaseFrameBridgeSnapshot | null = null;
	try {
		snapshot = await page.evaluate(() => {
			const target = window as unknown as {
				__runwayCaseFrame?: { prefix?: unknown };
				__runwayCleartextHttps?: unknown;
				__runwayCleartextSite?: { roots?: unknown } | null;
				__runwayCleartextHttpsHosts?: unknown;
				RunwayCleartextHttpsTransport?: unknown;
			};
			const bridge = target.__runwayCaseFrame;
			if (!bridge || typeof bridge.prefix !== "string") return null;
			const site = target.__runwayCleartextSite ?? null;
			const roots = Array.isArray(site?.roots) ? site.roots.map(String) : [];
			const hosts = Array.isArray(target.__runwayCleartextHttpsHosts)
				? target.__runwayCleartextHttpsHosts.map(String)
				: [];
			return {
				prefix: bridge.prefix,
				cleartextWrapperInstalled:
					typeof target.RunwayCleartextHttpsTransport === "function",
				cleartextEnabled: target.__runwayCleartextHttps !== false,
				cleartextRoots: [...roots, ...hosts],
			};
		});
	} catch (cause) {
		return Object.freeze({
			available: false as const,
			reason:
				`the ${laneId} controller could not be asked for its route mapping: ${describe(cause)}`,
			detail: Object.freeze({ laneId, adapter }),
		});
	}

	if (snapshot === null) {
		// No stub, no identity fallback. A proxy lane whose controller does not
		// publish the bridge has no mapping, and a mapping is exactly what cannot be
		// invented: an identity mapping here would report the unrewritten URL as the
		// physical one and then "verify" a document that was never routed.
		return Object.freeze({
			available: false as const,
			reason:
				`the ${laneId} controller published no __runwayCaseFrame bridge, so this lane has ` +
				`no authoritative logical/physical route mapping`,
			detail: Object.freeze({
				laneId,
				adapter,
				remedy:
					"The scramjet harness publishes the bridge once its controller frame exists. " +
					"A lane without it must be reported as capability-absent rather than run with " +
					"a substituted mapping.",
			}),
		});
	}

	const bridge = snapshot;
	const transport: LaneTransportCapability = Object.freeze({
		engine: "libcurl" as const,
		cleartextHttpsActive: bridge.cleartextWrapperInstalled && bridge.cleartextEnabled,
		cleartextHttpsRoots: Object.freeze([...bridge.cleartextRoots]) as readonly string[],
		// Reading configuration, not a handshake: this says the lane is not executing
		// https as cleartext. It is not a claim that a TLS stack was exercised.
		realTls: !(bridge.cleartextWrapperInstalled && bridge.cleartextEnabled),
	});

	return Object.freeze({
		available: true as const,
		value: Object.freeze({
			page,
			caseFrame,
			routeMapping: Object.freeze({
				toPhysical: async (logicalUrl: string) => {
					const encoded = await page.evaluate((value: string) => {
						const target = window as unknown as {
							__runwayCaseFrame?: { encode?: (url: string) => string };
						};
						const encode = target.__runwayCaseFrame?.encode;
						if (typeof encode !== "function") return null;
						return encode(value);
					}, logicalUrl);
					if (typeof encoded !== "string" || encoded === "") {
						throw new RunwayError(
							"lane/init-failed",
							`the ${laneId} controller could not encode ${logicalUrl} for its route`,
							{ details: { laneId, adapter, logicalUrl } }
						);
					}
					return encoded;
				},
				verify: ({ observedUrl, physicalUrl }) =>
					verifyAgainstPhysical({ observedUrl, physicalUrl }),
			}),
			transport,
			admitsLogicalUrl: (logicalUrl: string) => admitLogicalUrl(logicalUrl, transport),
		}),
	});
}

/**
 * Whether a lane may carry a logical URL without misrepresenting what it is.
 *
 * Refuses rather than downgrades. An `https:` case carried by the cleartext
 * wrapper travels as loopback `http:`, so a result from it reads as TLS and is not;
 * that is a false pass in the one direction that matters, and it is refused here
 * rather than corrected later.
 */
export function admitLogicalUrl(
	logicalUrl: string,
	transport: LaneTransportCapability
): LaneUrlAdmission {
	let url: URL;
	try {
		url = new URL(logicalUrl);
	} catch {
		return Object.freeze({
			admitted: false as const,
			reason: `${logicalUrl} is not an absolute URL this lane can route`,
		});
	}
	const secure = url.protocol === "https:" || url.protocol === "wss:";
	if (secure && !transport.realTls) {
		return Object.freeze({
			admitted: false as const,
			reason: transport.cleartextHttpsActive
				? `this lane executes ${url.protocol} as cleartext http to loopback, so ${url.href} ` +
					`would report as a secure-context result without ever using TLS`
				: `this lane has no transport that can carry ${url.protocol}`,
		});
	}
	return Object.freeze({ admitted: true as const });
}

export function createBrowserLane(options: BrowserLaneOptions): Lane {
	const provenance: LaneProvenance = Object.freeze({
		laneId: options.laneId,
		role: options.role,
		adapter: options.adapter,
		loaded: Object.freeze({ ...options.loaded }),
	});

	/**
	 * The served profile is immutable for the run, so it is read once per lane; the
	 * receipt it is correlated against is read per attempt.
	 */
	let servedProfile: Promise<{
		readonly profile: ServedProfile | null;
		readonly error: string | null;
	}> | null = null;

	const openAttempt = async (request: AttemptRequest): Promise<LaneAttempt> => {
		const cancelled = (detail: string): RunwayError => {
			// The signal's own reason, when it has one, kept as serializable detail.
			// The scheduler aborts with different reasons for a cancelled run and an
			// item that outran its deadline, and a lane that reports only "cancelled"
			// loses the distinction the caller needs to classify the record.
			const reason: unknown = (request.signal as AbortSignal & { reason?: unknown }).reason;
			return new RunwayError("schedule/cancelled", detail, {
				details: {
					laneId: options.laneId,
					origin: options.origin,
					...(reason === undefined ? {} : { signalReason: serializeError(reason) }),
				},
			});
		};

		/**
		 * Refuses to take the next step once the attempt has been cancelled.
		 *
		 * Called immediately after every await in the startup sequence and before
		 * anything with an effect. Racing the signal ends the *wait*, but the work
		 * that lost the race keeps running: a page that arrives late would otherwise
		 * go on to install listeners, start coverage, launch an HTTP fetch and
		 * publish into the lane-wide profile cache on behalf of an attempt that was
		 * already reported cancelled — contaminating the attempts that follow it.
		 */
		const stopIfCancelled = (): void => {
			if (request.signal.aborted) {
				throw cancelled(
					`the ${options.laneId} attempt was cancelled while its harness was starting`
				);
			}
		};

		// A request that is already cancelled never acquires a profile, and never
		// starts a navigation that would have to be abandoned.
		if (request.signal.aborted) {
			throw cancelled("the attempt was cancelled before a browser profile was acquired");
		}
		const handle: ContextHandle = await options.owner.openContext();
		if (request.signal.aborted) {
			// The profile arrived after the abort: it is disposed here rather than
			// left open for the owner to reap at the end of the run.
			await handle.dispose().catch(() => undefined);
			throw cancelled("the attempt was cancelled while a browser profile was being acquired");
		}
		// Every later phase is bounded by this: closing the profile cancels whatever
		// the page still has in flight, so nothing survives the attempt's deadline.
		const onAbort = (): void => {
			void handle.dispose().catch(() => undefined);
		};
		request.signal.addEventListener("abort", onAbort, { once: true });

		const context: BrowserContext = handle.context;
		let page: Page;
		let okCount = 0;
		let unattributed = 0;
		let unattributedConsistency = 0;
		let consistencyFailures = 0;
		let nonceEchoed = false;
		let resolveResult: ((result: PageResult) => void) | null = null;
		let pendingResult: PageResult | null = null;
		// ---- accepted failure ledger ------------------------------------------
		/** Total accepted, including any whose detail was dropped by the bound. */
		let failuresAccepted = 0;
		/** Of those, the ones that carried this attempt's nonce. */
		let attributedFailures = 0;
		/** Accepted failures whose detail exceeded the retention bound. */
		let failuresDropped = 0;
		const retainedFailures: PageResult[] = [];
		let coverageStarted = false;
		const navigated: string[] = [];
		const transcript: string[] = [];
		let transcriptBytes = 0;
		let transcriptDropped = 0;

		// ---- admission state -------------------------------------------------
		let sealed = false;
		let inFlight = 0;
		let refusedAfterSeal = 0;
		let pendingAtSeal = 0;
		const drainWaiters: (() => void)[] = [];
		const settleAdmission = (): void => {
			inFlight -= 1;
			if (inFlight === 0) for (const waiter of drainWaiters.splice(0)) waiter();
		};
		/** Refuses a page call once the record's observations have been sealed. */
		const refuseIfSealed = (what: string): void => {
			if (!sealed) return;
			refusedAfterSeal += 1;
			throw new Error(
				`runway: ${what} arrived after this attempt was sealed and was refused; ` +
					"a page must report everything it has before its test ends"
			);
		};

		/** Appends one console line, accounting for anything the budget drops. */
		const appendTranscript = (line: string): void => {
			const size = Buffer.byteLength(line) + 1;
			if (transcriptBytes + size > CONSOLE_BUDGET_BYTES) {
				transcriptDropped += size;
				return;
			}
			transcriptBytes += size;
			transcript.push(line);
		};

		/**
		 * Records every failure this attempt accepted, then delivers it.
		 *
		 * The waiter below consumes at most one result, and a test's terminal result is
		 * chosen from the first one that arrives. Everything after that — a `fail()`
		 * during plugin verification or artifact collection, a page error raised while
		 * the attempt is winding down, a consistency value the broker refused — was
		 * still *accepted*: the binding resolved and the page was told its report
		 * landed. Without this ledger those failures were delivered into a slot nobody
		 * reads again, so a page could report a pass, then report a failure, be told
		 * the failure was accepted, and still be recorded as a pass.
		 *
		 * The ledger is monotonic and is never withdrawn. It is bounded in *detail*
		 * only: past {@link FAILURE_RETENTION} the messages stop being kept, and the
		 * count of what was dropped is kept instead, so a capped failure can still not
		 * be ignored.
		 */
		const deliver = (result: PageResult): void => {
			if (result.kind === "fail") {
				failuresAccepted += 1;
				if (result.attributed) attributedFailures += 1;
				if (retainedFailures.length < FAILURE_RETENTION) retainedFailures.push(result);
				else failuresDropped += 1;
			}
			if (resolveResult) {
				const resolve = resolveResult;
				resolveResult = null;
				resolve(result);
			} else if (!pendingResult) {
				pendingResult = result;
			}
		};

		const attributed = (payload: BindingPayload): boolean =>
			payload.__runwayToken === request.nonce;

		let expectation: PluginVerifierExpectation = {
			kind: "unresolved",
			profileName: null,
			modules: [],
			verifiers: [],
			detail: "the attempt did not finish establishing its plugin verifier expectation",
		};

		// Bounded by the attempt's own signal, all the way through acquisition.
		//
		// Everything below awaits a promise the browser library owns: creating the
		// page, installing init scripts, exposing bindings, navigating. Aborting the
		// attempt closes the profile, and closing it *usually* makes those promises
		// reject — but that is the library's behaviour, not a guarantee this code
		// holds. When it does not happen, `openAttempt` keeps awaiting a promise that
		// will never settle: the profile is gone, the deadline has passed, and the
		// attempt neither resolves nor rejects. The caller then waits forever on a
		// cancellation that already happened.
		//
		// Racing the signal makes the cancellation this code's own answer rather than
		// something it hopes the library will deliver. The startup promise keeps a
		// catch, so a page closed underneath it cannot surface as an unhandled
		// rejection, and the listener is removed on every path.
		let onStartupAbort: (() => void) | null = null;
		const startupAborted = new Promise<never>((_resolve, reject) => {
			onStartupAbort = () =>
				reject(cancelled(`the ${options.laneId} attempt was cancelled while its harness was starting`));
			request.signal.addEventListener("abort", onStartupAbort, { once: true });
		});
		startupAborted.catch(() => undefined);
		try {
			const startup = (async () => {
				// The nonce is delivered into this disposable profile, not into the URL, so
				// it survives navigation and proxy rewriting and never changes what the
				// fixture server sees. Every result echoed with it belongs to this attempt.
				await context.addInitScript(
					`globalThis.__runwayAttemptNonce = ${JSON.stringify(request.nonce)};`
				);
				stopIfCancelled();
				await context.addInitScript(CDP_INIT_SCRIPT);
				stopIfCancelled();
				await context.exposeBinding("__runwayControl", async (_source, raw) => {
					refuseIfSealed("a runway control request");
					const parsed = parsePayload(typeof raw === "string" ? raw : JSON.stringify(raw ?? {}));
					const action = (parsed as { action?: unknown }).action;
					if (action !== "clearCookies") {
						throw new RunwayError(
							"lane/init-failed",
							`unknown runway control action ${JSON.stringify(action)}`,
							{ details: { laneId: options.laneId } }
						);
					}
					await context.clearCookies();
					return { ok: true };
				});
				stopIfCancelled();
				for (const name of RESULT_BINDINGS) {
					// Checked each time round: the loop registers several bindings, and a
					// cancellation part-way through must stop at the next one rather than
					// finish installing the rest into a profile that is being closed.
					stopIfCancelled();
					await context.exposeBinding(name, async (_source, raw) => {
						// Refused before anything is counted, so a sealed attempt's counters
						// cannot move behind a record that has already been sampled.
						refuseIfSealed(`a ${name} call`);
						const payload = parsePayload(typeof raw === "string" ? raw : JSON.stringify(raw ?? {}));
						const isAttributed = attributed(payload);
						if (!isAttributed) unattributed += 1;
						switch (name) {
							case "__testPass":
								if (isAttributed) nonceEchoed = true;
								deliver({
									kind: "pass",
									message: messageOf(payload),
									details: payload.details ?? null,
									attributed: isAttributed,
								});
								return;
							case "__testFail":
								if (isAttributed) nonceEchoed = true;
								deliver({
									kind: "fail",
									message: messageOf(payload) ?? "the page reported a failure",
									details: payload.details ?? null,
									attributed: isAttributed,
								});
								return;
							case "__testOk":
								if (isAttributed) okCount += 1;
								return;
							default: {
								// Attribution is decided before the broker is touched, so a page
								// cannot submit a value on the opposite lane's behalf.
								const admission = consistencyAdmission(payload, request.nonce);
								if (!admission.admitted) {
									unattributedConsistency += 1;
									throw new Error(
										"runway: this consistency value did not carry the attempt's nonce and was not recorded"
									);
								}
								inFlight += 1;
								try {
									// The binding returns the broker's promise: a label the broker
									// rejects (absent, duplicate, closed rendezvous, late arrival)
									// must be awaitable by the page and must not be lost here.
									await request.onConsistent?.(admission.label, payload.value ?? null);
								} catch (cause) {
									// A rejected submission is a failure of this attempt, not a
									// page-side detail to swallow.
									consistencyFailures += 1;
									deliver({
										kind: "fail",
										message: `the consistency value ${describeConsistencyLabel(admission.label)} was rejected: ${describe(cause)}`,
										details: cause instanceof RunwayError ? cause.toJSON() : null,
										attributed: true,
									});
									throw cause;
								} finally {
									settleAdmission();
								}
								return;
							}
						}
					});
				}

				// The last gate before an allocation. Every binding above is installed on
				// the context, so a cancellation here leaves nothing dangling: the
				// bindings live and die with the profile, and disposing it is what
				// removes them. Nothing is claimed to have been "cleaned up" separately.
				stopIfCancelled();
				const acquired = await context.newPage();
				// Assigned before the guard: a page that arrived late is still this
				// attempt's to account for, and closing the profile is what closes it.
				// Throwing it away unassigned would leak it past the teardown.
				page = acquired;
				stopIfCancelled();
				if (options.traceConsole) {
					page.on("console", (message) => {
						appendTranscript(`[${message.type()}] ${message.text()}`);
					});
				}
				if (options.collectCoverage) {
					// Raw V8 coverage: the browser's own output, kept as evidence rather
					// than converted into a report the runner cannot re-derive.
					await page.coverage.startJSCoverage({
						resetOnNavigation: false,
						reportAnonymousScripts: true,
					});
					coverageStarted = true;
				}
				page.on("pageerror", (error) => {
					if (options.traceConsole) appendTranscript(`[pageerror] ${error.stack ?? error.message}`);
					deliver({
						kind: "fail",
						message: `uncaught page error: ${error.message}`,
						details: error.stack ?? null,
						// A crash in the page is attributable to the attempt that caused it.
						attributed: true,
					});
				});

				const harnessUrl = new URL(options.origin);
				harnessUrl.searchParams.set(ATTEMPT_QUERY_PARAM, request.nonce);
				// The candidate profile is read from the host's own socket while the page
				// loads; both halves of the expectation are needed before readiness is
				// reported, and neither is asked of the page.
				// Before the cache, not after: `servedProfile` is lane-wide, so a
				// cancelled attempt that got this far would both launch an HTTP request
				// nobody is waiting for and publish its result as the lane's answer for
				// every attempt that follows.
				stopIfCancelled();
				const profilePromise =
					options.adapter === "scramjet"
						? (servedProfile ??= fetchServedProfile(options.origin, options.readyTimeoutMs))
						: Promise.resolve({ profile: null, error: null } as const);
				// An explicit navigation bound. Without it this wait had no end of its own:
				// a harness that sends headers and then holds the body open left the
				// navigation pending indefinitely, and the only thing that could release it
				// was the profile being closed underneath it. Readiness and navigation now
				// share the one budget, so a harness that never finishes sending its
				// document is reported as one that did not become ready.
				await page.goto(harnessUrl.toString(), {
					waitUntil: "domcontentloaded",
					timeout: options.readyTimeoutMs,
				});
				stopIfCancelled();
				await page.waitForFunction(
					() => typeof (window as unknown as { __runwayNavigate?: unknown }).__runwayNavigate === "function",
					undefined,
					{ timeout: options.readyTimeoutMs }
				);
				stopIfCancelled();
				// Read once, while the harness has just initialized and before any test
				// navigates: this is the receipt the rest of the attempt is judged against.
				const receipt = normalizeReceipt(
					await page.evaluate(
						() =>
							(window as unknown as { __runwayPluginInit?: unknown }).__runwayPluginInit ?? null
					)
				);
				const served = await profilePromise;
				// The expectation is lane state the rest of the attempt is judged
				// against; a cancelled attempt does not get to set it.
				stopIfCancelled();
				expectation = correlateVerifierExpectation({
					adapter: options.adapter,
					profile: served.profile,
					profileError: served.error,
					receipt,
				});
				return acquired;
			})();
			startup.catch(() => undefined);
			try {
				// The page is handed back rather than read from the closure, so the
				// assignment below is the one the type checker can see.
				page = await Promise.race([startup, startupAborted]);
			} finally {
				// Removed on both paths. A listener that outlives the race holds this
				// attempt's rejector and fires into it on the next abort, long after
				// the attempt it belonged to has finished.
				if (onStartupAbort) request.signal.removeEventListener("abort", onStartupAbort);
				onStartupAbort = null;
			}
		} catch (cause) {
			request.signal.removeEventListener("abort", onAbort);
			if (onStartupAbort) request.signal.removeEventListener("abort", onStartupAbort);
			await handle.dispose().catch(() => undefined);
			if (request.signal.aborted) {
				// The profile was closed underneath the navigation on purpose. This is a
				// cancelled attempt, not a harness that failed to come up.
				throw cancelled(
					`the ${options.laneId} attempt was cancelled while its harness was starting: ${describe(cause)}`
				);
			}
			throw new RunwayError(
				"lane/init-failed",
				`the ${options.laneId} harness did not become ready: ${describe(cause)}`,
				{
					details: { laneId: options.laneId, origin: options.origin },
					remedy:
						options.adapter === "scramjet"
							? "Check the harness page console: the controller, service worker or transport failed to start."
							: "Check that the bare harness assets were built into the package.",
					cause,
				}
			);
		}

		/**
		 * Runs one page-side step under the attempt's deadline.
		 *
		 * The step's own promise is not abandoned silently: it is left with a catch so
		 * a profile closed by the abort cannot surface as an unhandled rejection, and
		 * the caller learns that the step did not finish.
		 */
		const bounded = async <T>(
			step: () => Promise<T>,
			what: string
		): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }> => {
			if (request.signal.aborted) {
				return { ok: false, reason: `${what} was not attempted: this attempt was cancelled` };
			}
			const running = step();
			let onAborted: (() => void) | null = null;
			const aborted = new Promise<{ readonly ok: false; readonly reason: string }>((resolve) => {
				onAborted = () =>
					resolve({
						ok: false,
						reason: `${what} did not finish before this attempt's deadline expired`,
					});
				request.signal.addEventListener("abort", onAborted, { once: true });
			});
			try {
				return await Promise.race([
					running.then((value) => ({ ok: true as const, value })),
					aborted,
				]);
			} catch (cause) {
				return { ok: false, reason: `${what} failed: ${describe(cause)}` };
			} finally {
				if (onAborted) request.signal.removeEventListener("abort", onAborted);
				// Whichever way the race went, the page promise is accounted for.
				void running.catch(() => undefined);
			}
		};

		/**
		 * Resolved at most once per attempt.
		 *
		 * One attempt has one case-frame identity; resolving twice would hand a second
		 * caller a handle captured after the first caller had already navigated, which
		 * is precisely the "chosen after the fact" designation this exists to avoid.
		 */
		let hostIntegrationOnce: Promise<LaneCapability<LaneHostIntegration>> | null = null;

		const attempt: LaneAttempt = {
			page,
			frame: page.frameLocator(CASE_FRAME_SELECTOR),
			nonce: request.nonce as Nonce,
			hostIntegration: () => {
				hostIntegrationOnce ??= buildHostIntegration({
					page,
					adapter: options.adapter,
					laneId: options.laneId,
				}).catch((cause: unknown) =>
					// A capability that cannot be built is an absence, not an attempt
					// failure: the caller decides whether it can proceed without it, and
					// fails closed if it cannot.
					Object.freeze({
						available: false as const,
						reason: `the ${options.laneId} host integration could not be built: ${describe(cause)}`,
						detail: Object.freeze({ laneId: options.laneId, adapter: options.adapter }),
					})
				);
				return hostIntegrationOnce;
			},
			configureCleartext: async (mapping: CleartextMapping) => {
				await page.evaluate(
					(payload: {
						hosts: readonly string[];
						site: { roots: readonly string[]; httpPort: number } | null;
						enabled: boolean;
					}) => {
						const target = window as unknown as Record<string, unknown>;
						target.__runwayCleartextHttpsHosts = payload.hosts;
						target.__runwayCleartextSite = payload.site;
						// Read by the wrapper before any mapping is consulted, so `false`
						// stops every rewrite including the loopback fallback.
						target.__runwayCleartextHttps = payload.enabled;
					},
					{ hosts: mapping.hosts, site: mapping.site, enabled: mapping.enabled !== false }
				);
			},
			navigate: async (url: string) => {
				await page.evaluate((target: string) => {
					(window as unknown as { __runwayNavigate: (value: string) => void }).__runwayNavigate(
						target
					);
				}, url);
				// Recorded after the request was actually issued, so verification covers
				// the targets this attempt really asked for.
				navigated.push(url);
				return url;
			},
			navigations: () => Object.freeze([...navigated]),
			waitForResult: async () => {
				if (pendingResult) {
					const result = pendingResult;
					pendingResult = null;
					return result;
				}
				return new Promise<PageResult>((resolve, reject) => {
					resolveResult = resolve;
					if (request.signal.aborted) {
						reject(
							new RunwayError("schedule/cancelled", "the attempt was cancelled", {
								details: { laneId: options.laneId },
							})
						);
						return;
					}
					request.signal.addEventListener(
						"abort",
						() => {
							resolveResult = null;
							reject(
								new RunwayError(
									"schedule/cancelled",
									"the attempt was cancelled before the page reported a result",
									{ details: { laneId: options.laneId } }
								)
							);
						},
						{ once: true }
					);
				});
			},
			okCount: () => okCount,
			acceptedFailures: () => ({
				accepted: failuresAccepted,
				attributed: attributedFailures,
				dropped: failuresDropped,
				retained: Object.freeze([...retainedFailures]),
			}),
			unattributedResults: () => unattributed,
			unattributedConsistency: () => unattributedConsistency,
			pluginVerifierExpectation: () => expectation,
			verifyPluginAssertions: async (testUrl): Promise<PluginAssertionReport> => {
				if (expectation.kind === "noProfile") {
					// Nothing is loaded to ask, and the expectation says so; asking the
					// page would only give it an opportunity to answer for a lane that
					// has no plugin harness.
					return judgeVerifyReply({ expectation, reply: null, target: testUrl });
				}
				const evaluated = await bounded(
					() =>
						page.evaluate(async (url: string | null) => {
							const verify = (
								window as unknown as {
									__runwayVerifyPlugins?: (context: {
										testURL?: string;
									}) => Promise<unknown>;
								}
							).__runwayVerifyPlugins;
							if (typeof verify !== "function") return null;
							return (await verify(url === null ? {} : { testURL: url })) ?? null;
						}, testUrl),
					"the configured plugin assertions"
				);
				if (!evaluated.ok) {
					// The verifiers may well have been configured, so an attempt that
					// cannot be asked is failed closed rather than credited.
					return judgeVerifyReply({
						expectation,
						reply: null,
						target: testUrl,
						unavailableReason: evaluated.reason,
					});
				}
				if (evaluated.value === null) {
					return judgeVerifyReply({
						expectation,
						reply: null,
						target: testUrl,
						unavailableReason:
							"the harness exposed no __runwayVerifyPlugins hook when this attempt asked, " +
							`though [${expectation.verifiers.join(", ")}] declared a verifier at initialization`,
					});
				}
				const reply = normalizeVerifyReply(evaluated.value);
				if (!reply) {
					return judgeVerifyReply({
						expectation,
						reply: null,
						target: testUrl,
						unavailableReason:
							"the harness answered the verifier hook with a value the host cannot read: " +
							JSON.stringify(evaluated.value).slice(0, 512),
					});
				}
				return judgeVerifyReply({ expectation, reply, target: testUrl });
			},
			warmNavigation: async (url: string, timeoutMs: number) => {
				const proxied = await page.evaluate((target: string) => {
					const resolve = (window as unknown as { __runwayGetProxiedUrl?: (value: string) => string })
						.__runwayGetProxiedUrl;
					return typeof resolve === "function" ? resolve(target) : "";
				}, url);
				if (!proxied) return;
				await page.evaluate(
					async ({ target, timeout }: { target: string; timeout: number }) => {
						const controller = new AbortController();
						const timer = setTimeout(() => controller.abort(), timeout);
						try {
							const response = await fetch(target, { signal: controller.signal });
							await response.body?.cancel().catch(() => undefined);
						} catch (error) {
							if (error instanceof DOMException && error.name === "AbortError") return;
							throw error;
						} finally {
							clearTimeout(timer);
						}
					},
					{ target: proxied, timeout: timeoutMs }
				);
			},
			collectArtifacts: async ({ runDirectory, directory }) => {
				const artifacts: ArtifactRef[] = [];
				const truncations: TruncationNote[] = [];
				const write = async (name: string, body: string): Promise<void> => {
					await mkdir(directory, { recursive: true });
					const file = path.join(directory, name);
					await writeFile(file, body, "utf8");
					artifacts.push({
						name,
						// Records reference artifacts relative to the run directory, so a
						// run directory stays portable.
						path: path.relative(runDirectory, file),
						sha256: createHash("sha256").update(body).digest("hex"),
						bytes: Buffer.byteLength(body),
						...(name === "console.log" && transcriptDropped > 0 ? { truncated: true } : {}),
					});
				};

				if (coverageStarted) {
					coverageStarted = false;
					const stopped = await bounded(
						() => page.coverage.stopJSCoverage(),
						"raw V8 coverage collection"
					);
					if (stopped.ok) {
						await write("coverage-v8.json", `${JSON.stringify(stopped.value)}\n`);
					} else {
						// Coverage is diagnostic: its absence is recorded, never fatal.
						appendTranscript(`[runway] ${stopped.reason}`);
					}
				}
				if (options.traceConsole) {
					await write("console.log", `${transcript.join("\n")}\n`);
					if (transcriptDropped > 0) {
						truncations.push({
							what: "page console transcript",
							keptBytes: transcriptBytes,
							droppedBytes: transcriptDropped,
						});
					}
				}
				return { artifacts, truncations };
			},
			sealAdmissions: () => {
				if (sealed) return;
				sealed = true;
				pendingAtSeal = inFlight;
			},
			drainAdmissions: async (signal: AbortSignal) => {
				if (inFlight === 0) return { pending: 0 };
				if (signal.aborted) return { pending: inFlight };
				await new Promise<void>((resolve) => {
					const onDrained = () => {
						signal.removeEventListener("abort", onDrained);
						resolve();
					};
					drainWaiters.push(onDrained);
					signal.addEventListener("abort", onDrained, { once: true });
				});
				return { pending: inFlight };
			},
			evidence: (): Omit<LaneEvidence, "artifacts" | "truncations"> => {
				const route = options.routeObservation?.(request.nonce);
				return {
					nonceEcho: nonceEchoed,
					ownerSignal: "notRequired",
					resultChannel: "page",
					hostOwned: false,
					...(route ? { routeInstrumentation: route } : {}),
					selfReported: {
						unattributedResults: unattributed,
						okCount,
						unattributedConsistency,
						rejectedConsistencySubmissions: consistencyFailures,
						admissionsRefusedAfterSeal: refusedAfterSeal,
						admissionsPendingAtSeal: pendingAtSeal,
						pluginVerifierExpectation: {
							kind: expectation.kind,
							profileName: expectation.profileName,
							modules: expectation.modules,
							verifiers: expectation.verifiers,
							...(expectation.detail === undefined ? {} : { detail: expectation.detail }),
						},
					},
				};
			},
			dispose: async () => {
				request.signal.removeEventListener("abort", onAbort);
				await handle.dispose();
			},
		};
		return attempt;
	};

	return Object.freeze({
		laneId: options.laneId,
		role: options.role,
		provenance,
		origin: options.origin,
		openAttempt,
	});
}
