/**
 * Target lane contract.
 *
 * A lane owns navigation, attachment and the host-side evidence that ties a page
 * result to one attempt. It deliberately models no browser semantics: it does not
 * know what a test asserts, and it never substitutes another lane for itself. A
 * lane that cannot initialise reports an infrastructure error and the run fails
 * for that lane.
 */
import type { Frame, FrameLocator, Page } from "playwright";
import type { LaneId, Nonce, TestId } from "../core/ids.ts";
import type {
	ArtifactRef,
	LaneEvidence,
	LaneProvenance,
	OwnerSignal,
	TruncationNote,
} from "../core/protocol.ts";

/** What the page reported, before any expectation or qualification is applied. */
export type PageResult = {
	readonly kind: "pass" | "fail";
	readonly message: string | null;
	readonly details: unknown;
	/** True when the payload carried this attempt's nonce. */
	readonly attributed: boolean;
};

/** Mapping that lets a fixture pretend to be a real hostname over loopback. */
export type CleartextMapping = {
	readonly hosts: readonly string[];
	readonly site: { readonly roots: readonly string[]; readonly httpPort: number } | null;
	/**
	 * Whether the cleartext wrapper may rewrite at all. Defaults to true.
	 *
	 * `false` disables it for the whole attempt, including subresources. Clearing
	 * `hosts` and `site` is *not* equivalent: with an empty host list the wrapper
	 * still downgrades `https://localhost`, `https://127.0.0.1` and `https://[::1]`
	 * by its loopback fallback, which is exactly where a local fixture server lives.
	 */
	readonly enabled?: boolean;
};

/** One configured plugin assertion that rejected. Never a raw thrown value. */
export type PluginAssertionFailure = {
	/** Plugin module the profile configured, when the harness identified one. */
	readonly module: string | null;
	readonly message: string;
	/** The harness's original entry, kept so nothing is lost in translation. */
	readonly details?: unknown;
};

/**
 * What the host expects a lane's plugin verifiers to be, fixed at initialization.
 *
 * The expectation is established *before* the test navigates anywhere: the host
 * knows which modules the profile it served configured, and the harness's own
 * initialization receipt names which of those modules declared a `verify()`. Both
 * halves are read once and correlated once. Nothing a page does afterwards can
 * widen or narrow this expectation, which is what stops a verifier hook that later
 * disappears or is replaced from being reported as "this profile has no verifiers".
 *
 * - `noProfile`: no plugin profile is loaded on this lane at all (a reference lane).
 * - `noVerifiers`: the configured modules loaded and none of them declared a
 *   verifier. Declaring one is optional, so this is a genuine absence.
 * - `required`: at least one configured module declared a verifier, so the hook
 *   must be present and must invoke exactly those modules.
 * - `uncorrelated`: the harness's receipt did not match the profile the host
 *   served, so what runs in the page is not the profile that was configured.
 * - `unresolved`: the expectation itself could not be established.
 */
export type PluginVerifierExpectation = {
	readonly kind: "noProfile" | "noVerifiers" | "required" | "uncorrelated" | "unresolved";
	/** Profile name the host served, when it could be read. */
	readonly profileName: string | null;
	/** Modules the initialization receipt reported as loaded, in profile order. */
	readonly modules: readonly string[];
	/** Modules that declared a verifier at initialization. */
	readonly verifiers: readonly string[];
	/** Why the expectation is `uncorrelated` or `unresolved`. */
	readonly detail?: string;
};

/**
 * Outcome of the plugin profile's own `verify()` functions for one navigation.
 *
 * Owner proof is a separate capability and is not derivable from this report. A
 * plugin verifying its own behaviour is a self-report: `satisfied` means "the
 * configured verifiers did not object", never "the candidate was verified". Only
 * `violated` and `unavailable` change an attempt's outcome, and only to a failure.
 *
 * - `none`: the expectation established at initialization is that this lane has no
 *   verifier to run — a reference lane, or configured modules that declared none.
 *   A missing hook where one was expected is `unavailable`, never `none`.
 * - `satisfied`: every expected verifier ran and returned without throwing.
 * - `violated`: at least one expected verifier rejected.
 * - `unavailable`: a verifier was expected and could not be evaluated — the hook
 *   was absent, replaced, refused to answer, or the attempt ran out of deadline —
 *   so the attempt is failed closed instead of credited with an unchecked pass.
 */
export type PluginAssertionReport = {
	readonly status: "none" | "satisfied" | "violated" | "unavailable";
	readonly failures: readonly PluginAssertionFailure[];
	/** Populated for `unavailable`: why the harness could not be asked. */
	readonly unavailableReason?: string;
	/** The expectation this report was judged against. */
	readonly expectation: PluginVerifierExpectation;
	/** Verifier modules the harness reported it actually invoked. */
	readonly invoked: readonly string[];
	/** Navigation target this report covers; null when nothing was navigated. */
	readonly target: string | null;
};

/**
 * Failures a lane accepted from its page, counted exactly and detailed with a bound.
 *
 * `accepted` and `attributed` are exact counts of what the lane took from the page.
 * `retained` carries the messages, and is bounded so one page cannot make a record
 * unbounded; `dropped` says how many messages that bound cost. A dropped message
 * still counts as an accepted failure, so nothing is ignored by being capped.
 */
export type LaneFailureLedger = {
	/** Total failures accepted, including those whose detail was dropped. */
	readonly accepted: number;
	/** Of those, the ones that carried this attempt's nonce. */
	readonly attributed: number;
	/** Accepted failures whose detail exceeded the retention bound. */
	readonly dropped: number;
	/** The retained failures, in arrival order. */
	readonly retained: readonly PageResult[];
};

/**
 * A capability a lane either genuinely has, or explicitly does not have.
 *
 * There is deliberately no third state and no permissive default. A host that
 * cannot get a capability must be told so in a form it has to handle, because the
 * alternative — a stub that answers plausibly — manufactures exactly the evidence
 * the caller was trying to obtain.
 */
export type LaneCapability<T> =
	| { readonly available: true; readonly value: T }
	| {
			readonly available: false;
			/** Why this lane cannot offer it, in terms the record can carry. */
			readonly reason: string;
			readonly detail?: Readonly<Record<string, unknown>>;
	  };

/**
 * Locates the frame a case will run in, resolved before it is navigated.
 *
 * The identity is fixed by the lane, from the element its own controller created.
 * It is never resolved by matching a frame's URL or name: both are reachable by
 * guest content, and a helper frame sitting at the identical URL would otherwise
 * be indistinguishable from the case.
 */
export type LaneCaseFrameLocator = {
	readonly describe: string;
	readonly locate: (page: Page) => Promise<Frame>;
};

/**
 * Whether an observed document URL is the expected case.
 *
 * `unverified` is the correct answer whenever the lane cannot decide, and it
 * admits nothing. It is not a soft `match`.
 */
export type LaneRouteVerdict = "match" | "mismatch" | "unverified";

/**
 * The lane's logical→physical route mapping.
 *
 * Only the lane that owns rewriting can say what a logical upstream URL becomes on
 * the wire, so this is the lane's to provide and no caller may synthesise one. A
 * reference lane's mapping is the identity; a proxy lane's comes from its own
 * rewriter, including that lane's configured route prefix.
 *
 * `verify` is synchronous on purpose: it is called on the host's attribution path,
 * where reaching back into the page would mean asking guest-reachable state to
 * confirm an observation about itself.
 */
export type LaneRouteMapping = {
	/** The URL the case frame will really be navigated to. */
	readonly toPhysical: (logicalUrl: string) => Promise<string>;
	readonly verify: (input: {
		/** Read from the frame by the host, never reported by the page. */
		readonly observedUrl: string;
		readonly logicalUrl: string;
		readonly physicalUrl: string;
	}) => LaneRouteVerdict;
};

/**
 * What this lane's transport can actually carry.
 *
 * Exposed so a caller can refuse a scope this lane would otherwise appear to
 * satisfy. The cleartext-HTTPS wrapper is the case that matters: it executes
 * `https:` over a loopback `http:` connection, which is useful for fixture work and
 * is *not* TLS. A suite whose meaning depends on real TLS has to be able to see
 * that difference rather than receive a result that silently downgraded.
 */
export type LaneTransportCapability = {
	/** Transport the harness installed, as read from the harness itself. */
	readonly engine: "direct" | "libcurl" | "unknown";
	/** True when `https:`/`wss:` are executed as cleartext `http:` to loopback. */
	readonly cleartextHttpsActive: boolean;
	/** Roots the cleartext mapping covers, when it is active. */
	readonly cleartextHttpsRoots: readonly string[];
	/**
	 * True only when this lane can carry real TLS to an upstream origin.
	 *
	 * False does not mean `https:` URLs fail; it means they are not TLS, which is
	 * the distinction a caller must not lose.
	 */
	readonly realTls: boolean;
};

/** Whether a lane may carry one logical URL without misrepresenting it. */
export type LaneUrlAdmission =
	| { readonly admitted: true }
	| { readonly admitted: false; readonly reason: string };

/**
 * The lane-side integration a page-driving host needs, and nothing more.
 *
 * This is an integration seam, not evidence. In particular **nothing here is route
 * proof**: the mapping says where a URL was meant to go, which is a different claim
 * from where the bytes actually went. Ownership of a request stays with whatever
 * observes the ingress, and remains absent — and therefore fails closed — until
 * such a receipt exists. Nothing in this type may be used to satisfy it.
 */
export type LaneHostIntegration = {
	/** The page the lane really opened. Not a substitute or a double. */
	readonly page: Page;
	readonly caseFrame: LaneCaseFrameLocator;
	readonly routeMapping: LaneRouteMapping;
	readonly transport: LaneTransportCapability;
	/**
	 * Whether this lane can carry a logical URL truthfully.
	 *
	 * Refuses rather than downgrades: an `https:` case on a lane whose only route to
	 * it is the cleartext wrapper is not admitted, because running it would produce
	 * a result that reads as TLS and is not.
	 */
	readonly admitsLogicalUrl: (logicalUrl: string) => LaneUrlAdmission;
};

export type LaneAttempt = {
	readonly page: Page;
	readonly frame: FrameLocator;
	readonly nonce: Nonce;
	/**
	 * The lane-side integration for a host that drives the page itself.
	 *
	 * Optional so every existing implementer keeps compiling; a lane that does not
	 * implement it is a lane without the capability, which callers must treat the
	 * same way as an explicit {@link LaneCapability} absence — fail closed, never
	 * substitute a default. Resolved once per attempt, before navigation, because
	 * the frame identity it fixes is only trustworthy while no case has loaded.
	 */
	readonly hostIntegration?: () => Promise<LaneCapability<LaneHostIntegration>>;
	/** Applies the fixture host mapping before navigation. */
	readonly configureCleartext: (mapping: CleartextMapping) => Promise<void>;
	/** Points the harness at a fixture URL. Returns the URL actually requested. */
	readonly navigate: (url: string) => Promise<string>;
	/**
	 * Every navigation target this attempt actually requested, in order.
	 *
	 * Verification is per navigation, so this is the list of URLs a per-attempt
	 * check has to cover. A test that navigates twice is two tested targets, not
	 * "whatever happened to be last".
	 */
	readonly navigations: () => readonly string[];
	/** Resolves when the page reports a terminal result. */
	readonly waitForResult: () => Promise<PageResult>;
	readonly okCount: () => number;
	/**
	 * Every failure this attempt accepted from the page, not just the one chosen.
	 *
	 * {@link waitForResult} yields a single terminal result, so a failure reported
	 * after it — during plugin verification, artifact collection, or a page error on
	 * the way out — would be accepted from the page and then have nowhere to go. This
	 * ledger is where it goes: it is monotonic while the attempt is open, sampled at
	 * the same sealed boundary as {@link evidence}, and a non-zero `accepted` means
	 * the attempt cannot be recorded as a pass.
	 */
	readonly acceptedFailures: () => LaneFailureLedger;
	/** Number of page results that did not carry this attempt's nonce. */
	readonly unattributedResults: () => number;
	/**
	 * Runs the assertions the loaded plugin profile configured, for one navigation.
	 *
	 * Called once per navigated target with that target's URL, so a test that
	 * navigates more than once is verified for each of them. This is a self-report
	 * and is treated as one: it can only *fail* an attempt. It is deliberately not
	 * the owner receipt and cannot produce one — see {@link PluginAssertionReport}.
	 *
	 * Bounded by the attempt's own deadline: it never outlives the attempt, and a
	 * hook that never settles yields `unavailable` rather than hanging the run.
	 */
	readonly verifyPluginAssertions: (testUrl: string | null) => Promise<PluginAssertionReport>;
	/** The verifier expectation this attempt established while initializing. */
	readonly pluginVerifierExpectation: () => PluginVerifierExpectation;
	/**
	 * Consistency values that arrived without this attempt's nonce.
	 *
	 * They are never submitted to the cross-lane broker, because an unattributed
	 * value is an attempt to speak for the other lane. A non-zero count invalidates
	 * the attempt's record rather than being reported as agreement.
	 */
	readonly unattributedConsistency: () => number;
	/** Pre-fetches the proxied URL, for fixtures that need a warmed route. */
	readonly warmNavigation: (url: string, timeoutMs: number) => Promise<void>;
	/**
	 * Writes this attempt's diagnostic artifacts and returns their references.
	 *
	 * Artifact paths are relative to the run directory, and anything that had to be
	 * cut short is reported as an explicit truncation rather than silently clipped.
	 */
	readonly collectArtifacts: (destination: {
		readonly runDirectory: string;
		readonly directory: string;
	}) => Promise<{
		readonly artifacts: readonly ArtifactRef[];
		readonly truncations: readonly TruncationNote[];
	}>;
	/**
	 * Closes this attempt to further page-originated work.
	 *
	 * After the seal every binding call the page makes is refused with an explicit
	 * error and counted, instead of being accepted and then ignored, and the
	 * attempt's counters stop moving. That is what lets the host sample its final
	 * negative observations knowing nothing can still be added behind the record.
	 */
	readonly sealAdmissions: () => void;
	/**
	 * Waits for callbacks admitted before the seal to settle.
	 *
	 * Bounded by the caller's signal — the attempt's own deadline — and reports how
	 * many were still in flight when it gave up, so an attempt is never recorded as
	 * a pass with work outstanding behind it.
	 */
	readonly drainAdmissions: (signal: AbortSignal) => Promise<{ readonly pending: number }>;
	/** Host-side evidence gathered for this attempt. Sample after sealing. */
	readonly evidence: () => Omit<LaneEvidence, "artifacts" | "truncations">;
	readonly dispose: () => Promise<void>;
};

export type AttemptRequest = {
	readonly testId: TestId;
	readonly nonce: Nonce;
	readonly signal: AbortSignal;
	/**
	 * Called with each consistency value the page reports, once its attribution has
	 * been checked.
	 *
	 * The label is whatever the page sent, verbatim: the lane checks attribution, and
	 * the cross-lane broker owns the label contract. Nothing in between may substitute
	 * a label the page did not choose.
	 */
	readonly onConsistent?: (label: unknown, value: unknown) => Promise<void>;
};

export type Lane = {
	readonly laneId: LaneId;
	readonly role: "reference" | "candidate";
	readonly provenance: LaneProvenance;
	/** Origin of this lane's harness, read back from its listening socket. */
	readonly origin: string;
	readonly openAttempt: (request: AttemptRequest) => Promise<LaneAttempt>;
};

export const OWNER_NOT_REQUIRED: OwnerSignal = "notRequired";
