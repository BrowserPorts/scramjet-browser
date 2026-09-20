/**
 * Terminal outcome taxonomy.
 *
 * Exactly one terminal outcome is recorded per planned (test, lane) pair. The
 * taxonomy separates "the test ran and its assertions failed" from every other
 * way a run can end, because collapsing those is how a runner starts reporting
 * infrastructure breakage as conformance data.
 */

export const TERMINAL_OUTCOMES = [
	/** Assertions ran and all of them held. Raw pass, not yet a qualified pass. */
	"pass",
	/** The test executed and an assertion or subtest failed. */
	"assertionFailure",
	/** Inventoried, deliberately not executed (e.g. upstream manual cases). */
	"notRun",
	/** Inventoried, and this runner implements no execution for its form. */
	"unsupported",
	/** Deadline reached before a terminal signal. */
	"timeout",
	/** Renderer or browser process died. */
	"crash",
	/** Harness, server, browser or recorder failure unrelated to the subject. */
	"infrastructureError",
	/** Per-test setup (fixture server, navigation target) failed. */
	"setupError",
	/** The selected plugin/candidate failed to initialise or verify. */
	"pluginError",
	/** Cancelled by the operator or by a run-level abort. */
	"cancelled",
	/** Planned but no terminal record arrived. Filled in by comparison. */
	"missing",
	/** A record existed but violated the protocol. Never a pass. */
	"invalidRecord",
] as const;

export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

const OUTCOME_SET: ReadonlySet<string> = new Set(TERMINAL_OUTCOMES);

export function isTerminalOutcome(value: unknown): value is TerminalOutcome {
	return typeof value === "string" && OUTCOME_SET.has(value);
}

/** The only outcome that can ever become a qualified pass. */
export function isRawPass(outcome: TerminalOutcome): boolean {
	return outcome === "pass";
}

/** True when the subject actually executed, whatever the verdict. */
export function isExecuted(outcome: TerminalOutcome): boolean {
	return outcome === "pass" || outcome === "assertionFailure";
}

/**
 * True when the outcome describes the runner or environment rather than the
 * subject under test. These must never be reported as conformance signal.
 */
export function isInfrastructural(outcome: TerminalOutcome): boolean {
	return (
		outcome === "infrastructureError" ||
		outcome === "setupError" ||
		outcome === "pluginError" ||
		outcome === "crash" ||
		outcome === "invalidRecord"
	);
}

/** True when the case was inventoried but intentionally or knowingly not run. */
export function isNotRun(outcome: TerminalOutcome): boolean {
	return outcome === "notRun" || outcome === "unsupported" || outcome === "missing";
}

/**
 * Whether an outcome should make the process exit non-zero when it is not
 * covered by an expectation entry.
 */
export function isFailureForExit(outcome: TerminalOutcome): boolean {
	return outcome !== "pass" && outcome !== "notRun";
}
