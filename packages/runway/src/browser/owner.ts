/**
 * Browser process owner.
 *
 * One browser is launched per run and both lanes use it: the same binary, the
 * same launch arguments, the same headless mode. A comparison between lanes is
 * only meaningful when the engine is held constant, so the lanes are not allowed
 * to select their own.
 *
 * Each attempt gets a fresh {@link BrowserContext} — a disposable profile — and
 * contexts are tracked so a cancelled or crashed run still closes them. Tracking
 * is deliberately pessimistic: a context is only forgotten once its `close()` has
 * actually resolved, and a failed close is reported instead of being swallowed. A
 * registry that removed the context first would report zero open profiles while a
 * profile was still alive, which is exactly the state a leak check must catch.
 *
 * The launched binary's identity is hashed and recorded; the recorded provenance
 * says what actually ran, and says plainly when the binary was not one the consumer
 * chose.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chromium } from "playwright";
import type { Browser, BrowserContext } from "playwright";
import { RunwayError } from "../core/errors.ts";
import type { BrowserPlan } from "../core/plan.ts";
import type { BrowserProvenance } from "../core/protocol.ts";

async function hashFile(file: string): Promise<string | null> {
	try {
		const hash = createHash("sha256");
		await new Promise<void>((resolve, reject) => {
			createReadStream(file)
				.on("data", (chunk) => hash.update(chunk))
				.on("error", reject)
				.on("end", () => resolve());
		});
		return hash.digest("hex");
	} catch {
		// A channel install may not expose a hashable file; absence is recorded as
		// null rather than guessed.
		return null;
	}
}

/** What a close report says about one profile that would not close. */
export type ContextCloseFailure = {
	readonly reason: string;
	/**
	 * Whether the underlying `close()` was observed to finish.
	 *
	 * `false` means exactly that and nothing more: the close was issued, it did
	 * not settle within the budget, and the profile is still tracked as open. It
	 * is not a claim that the profile is dead, and not a claim that it is alive.
	 */
	readonly profileReleased: boolean;
};

/** How long a caller is willing to wait for one profile to close. */
export const DEFAULT_DISPOSE_BUDGET_MS = 5_000;

/** Outcome of shutting the browser down. Returned so a caller can record it. */
export type BrowserCloseReport = {
	readonly contextsClosed: number;
	/** Profiles whose `close()` rejected. They are still tracked as open. */
	readonly contextsFailed: readonly ContextCloseFailure[];
	/** Present when the browser process itself would not close. */
	readonly browserFailure: string | null;
	/**
	 * Whether `browser.close()` was observed to finish.
	 *
	 * `false` means the close was issued and either rejected or did not settle
	 * within its budget. It is not a claim that the browser is dead, and not a
	 * claim that it is alive — the two fields below say what could be observed.
	 *
	 * Optional so a caller constructing a report by hand keeps compiling. Absent
	 * means the producer did not say, which is not the same as `false`.
	 */
	readonly browserReleased?: boolean;
	/** `browser.isConnected()` sampled after an unfinished close; `null` if not sampled. */
	readonly browserStillConnected?: boolean | null;
	/** Contexts Playwright still reports, sampled at the same moment. */
	readonly outstandingContexts?: number | null;
};

export type BrowserOwner = {
	readonly provenance: BrowserProvenance;
	/** Opens a disposable profile. Callers must call `dispose` on the handle. */
	readonly openContext: () => Promise<ContextHandle>;
	/** Number of contexts still open. Used to detect leaks in tests. */
	readonly openContextCount: () => number;
	/**
	 * Closes every remaining profile, then the browser, and reports what failed.
	 *
	 * The budget bounds each wait, not the closes themselves. Worst case is
	 * therefore proportional to the number of tracked profiles — about
	 * `openContextCount() * budgetMs` for the sweep, plus one more budget for the
	 * browser — not a single constant. Finite, which is what the run needs; not
	 * instant, and this does not pretend otherwise.
	 */
	readonly close: (budgetMs?: number) => Promise<BrowserCloseReport>;
};

export type ContextHandle = {
	readonly context: BrowserContext;
	/**
	 * Closes this profile, within a budget.
	 *
	 * One disposal, one settlement: concurrent and repeated calls join the same
	 * close, so a second caller cannot return early while the first close is still
	 * running. A close that fails rejects with `browser/cleanup-failed` and the
	 * profile stays tracked, because it may still be alive.
	 *
	 * The budget bounds the *wait*, never the close itself. `close()` is a promise
	 * the browser library owns and it is not always settled by anything this code
	 * does; waiting on it without a bound is how a cancelled attempt stopped
	 * answering at all. When the budget expires this rejects with
	 * `profileReleased: false`, the close stays running, and the profile stays in
	 * the registry so a later `closeAll` joins the same settlement rather than
	 * starting a second one.
	 */
	readonly dispose: (budgetMs?: number) => Promise<void>;
};

/** The part of a browser context this registry needs to own its lifetime. */
export type CloseableContext = Pick<BrowserContext, "close">;

export type TrackedContext<C extends CloseableContext> = {
	readonly context: C;
	readonly dispose: (budgetMs?: number) => Promise<void>;
};

export type ContextRegistry<C extends CloseableContext> = {
	readonly track: (context: C) => TrackedContext<C>;
	readonly openCount: () => number;
	/** Closes everything still tracked. Never throws; reports what would not close. */
	readonly closeAll: (budgetMs?: number) => Promise<{
		readonly closed: number;
		readonly failures: readonly ContextCloseFailure[];
	}>;
};

/**
 * Tracks disposable profiles and their single disposal settlement.
 *
 * Separated from {@link launchBrowser} so the cleanup contract can be exercised
 * against a context whose `close()` really fails, which a launched browser will not
 * do on demand.
 */
export function createContextRegistry<C extends CloseableContext>(): ContextRegistry<C> {
	const open = new Map<C, (budgetMs?: number) => Promise<void>>();

	const track = (context: C): TrackedContext<C> => {
		let settlement: Promise<void> | null = null;
		// The close itself, started at most once and never abandoned. Separate from
		// the *wait* below: a caller may stop waiting, but nothing stops the close,
		// and a later caller joins this same promise rather than issuing a second
		// `close()` against a context that is already closing.
		const beginClose = (): Promise<void> => {
			settlement ??= (async () => {
				try {
					await context.close();
				} catch (cause) {
					throw new RunwayError(
						"browser/cleanup-failed",
						`a disposable browser profile did not close: ${cause instanceof Error ? cause.message : String(cause)}`,
						{
							details: { openProfiles: open.size, profileReleased: false },
							remedy:
								"The profile may still be alive; the run's browser close report lists it as open.",
							cause,
						}
					);
				}
				// Forgotten only now: before this point the profile is still open.
				open.delete(context);
			})();
			return settlement;
		};
		const dispose = async (budgetMs: number = DEFAULT_DISPOSE_BUDGET_MS): Promise<void> => {
			const closing = beginClose();
			// Observed whoever ends up waiting on it, so a close that rejects after
			// its caller gave up cannot surface as an unhandled rejection.
			closing.catch(() => undefined);
			if (budgetMs <= 0) return closing;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const expired = new Promise<"budget">((resolve) => {
				timer = setTimeout(() => resolve("budget"), budgetMs);
			});
			try {
				const outcome = await Promise.race([closing.then(() => "closed" as const), expired]);
				if (outcome === "closed") return;
			} finally {
				// The budget timer is always cleared: a profile that closed promptly
				// must not leave a pending timer holding the process open.
				if (timer) clearTimeout(timer);
			}
			throw new RunwayError(
				"browser/cleanup-failed",
				`a disposable browser profile did not close within ${budgetMs}ms`,
				{
					details: {
						openProfiles: open.size,
						profileReleased: false,
						budgetMs,
						closeStillRunning: true,
					},
					remedy:
						"The close is still running and the profile is still tracked as open; the " +
						"run's browser close report lists it, and a later close joins the same settlement.",
				}
			);
		};
		open.set(context, dispose);
		return Object.freeze({ context, dispose });
	};

	return Object.freeze({
		track,
		openCount: () => open.size,
		closeAll: async (budgetMs: number = DEFAULT_DISPOSE_BUDGET_MS) => {
			const failures: ContextCloseFailure[] = [];
			let closed = 0;
			for (const [context, dispose] of [...open]) {
				try {
					await dispose(budgetMs);
					closed += 1;
				} catch (cause) {
					// Reaping continues: one profile that will not close must not leave
					// the rest of them open, and one that will not close *in time* must
					// not stop the reaping either.
					failures.push({
						reason: cause instanceof Error ? cause.message : String(cause),
						// Always false here, and deliberately so: reaching this branch
						// means the close rejected or outran its budget, and neither
						// outcome proves the profile was released.
						profileReleased: false,
					});
					// The registry keeps it, because nothing proved it closed.
					void context;
				}
			}
			return { closed, failures };
		},
	});
}

/** The part of a browser this shutdown needs, so the contract can be tested. */
export type CloseableBrowser = {
	readonly close: () => Promise<void>;
	readonly isConnected: () => boolean;
	readonly contexts: () => readonly unknown[];
};

/** What the browser half of a close report says. */
export type BrowserShutdownOutcome = {
	readonly browserFailure: string | null;
	readonly browserReleased: boolean;
	readonly browserStillConnected: boolean | null;
	readonly outstandingContexts: number | null;
};

/**
 * Closes the browser once, and bounds the wait for it.
 *
 * Separated from {@link launchBrowser} for the same reason the context registry
 * is: the cases worth testing are a `close()` that rejects and a `close()` that
 * never settles, and a launched browser will not do either on demand.
 *
 * The budget bounds the wait, never the close. There is no supported way from a
 * `Browser` handle in this Playwright build to end the process — `process()` is
 * declared on `BrowserServer` and `ElectronApplication`, not on `Browser` — so
 * when the wait expires this reports what can actually be observed through the
 * API that does exist (`isConnected()`, `contexts()`) and says plainly that the
 * browser was not released. Nothing is killed and nothing is claimed to be gone.
 */
export function createBrowserShutdown(browser: CloseableBrowser): {
	readonly close: (budgetMs?: number) => Promise<BrowserShutdownOutcome>;
	/** How many times `close()` was actually dispatched at the browser. */
	readonly dispatches: () => number;
} {
	let shuttingDown: Promise<void> | null = null;
	let dispatches = 0;
	const begin = (): Promise<void> => {
		if (!shuttingDown) {
			dispatches += 1;
			shuttingDown = browser.close();
			// Observed here as well as by the caller, so a rejection landing after a
			// caller stopped waiting cannot surface as an unhandled rejection.
			shuttingDown.catch(() => undefined);
		}
		return shuttingDown;
	};
	const sample = <T>(read: () => T): T | null => {
		try {
			return read();
		} catch {
			return null;
		}
	};

	return Object.freeze({
		dispatches: () => dispatches,
		close: async (
			budgetMs: number = DEFAULT_DISPOSE_BUDGET_MS
		): Promise<BrowserShutdownOutcome> => {
			const shutdown = begin();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const expired = new Promise<"budget">((resolve) => {
				timer = setTimeout(() => resolve("budget"), budgetMs);
			});
			let outcome: "closed" | "budget" | { readonly failed: unknown };
			try {
				outcome = await Promise.race([
					shutdown.then(
						() => "closed" as const,
						(cause: unknown) => ({ failed: cause }) as const
					),
					expired,
				]);
			} finally {
				// Always cleared: a browser that closed promptly must not leave a
				// pending timer holding the process open.
				if (timer) clearTimeout(timer);
			}
			if (outcome === "closed") {
				return Object.freeze({
					browserFailure: null,
					browserReleased: true,
					browserStillConnected: null,
					outstandingContexts: null,
				});
			}
			const failure =
				outcome === "budget"
					? `the browser did not close within ${budgetMs}ms`
					: outcome.failed instanceof Error
						? outcome.failed.message
						: String(outcome.failed);
			return Object.freeze({
				browserFailure: failure,
				browserReleased: false,
				browserStillConnected: sample(() => browser.isConnected()),
				outstandingContexts: sample(() => browser.contexts().length),
			});
		},
	});
}

/** Launches the browser named by the plan. Never falls back to another binary. */
export async function launchBrowser(plan: BrowserPlan): Promise<BrowserOwner> {
	const selection = plan.selection;
	let browser: Browser;
	try {
		browser = await chromium.launch({
			headless: plan.headless,
			args: [...plan.args],
			...(selection.kind === "executable" && selection.selector
				? { executablePath: selection.selector }
				: {}),
			...(selection.kind === "channel" && selection.selector
				? { channel: selection.selector }
				: {}),
			// Runway owns process signals; Playwright must not. With these left at
			// their defaults, Playwright installs its own SIGINT/SIGTERM/SIGHUP
			// handlers, and its SIGINT handler calls `process.exit(130)` once its
			// browsers are closed — racing the CLI's abort, killing the process
			// before the run's diagnostics, records and completion event are
			// flushed, and replacing Runway's own exit code. Disabling all three is
			// deliberate: a SIGTERM that the CLI never sees cannot be honoured or
			// reported, and Runway does not claim SIGHUP cleanup it cannot run.
			//
			// The browser process itself is still reaped: `BrowserOwner.close`
			// closes every tracked profile and then the browser, and the failure to
			// do so is the run's own recorded cleanup error. Disabling the handlers
			// removes only Playwright's decision to exit the *process* on our behalf.
			handleSIGINT: false,
			handleSIGTERM: false,
			handleSIGHUP: false,
		});
	} catch (cause) {
		throw new RunwayError(
			"browser/launch-failed",
			`the selected browser could not be launched: ${cause instanceof Error ? cause.message : String(cause)}`,
			{
				details: {
					selection: selection.kind,
					selector: selection.selector,
					headless: plan.headless,
					args: plan.args,
				},
				remedy:
					selection.kind === "bundled"
						? "Install Playwright's browsers (`npx playwright install chromium`) or pass --browser-executable."
						: "Check the selected browser path or channel.",
				cause,
			}
		);
	}

	const provenance: BrowserProvenance = Object.freeze({
		engine: "chromium",
		version: browser.version(),
		selection: selection.kind,
		selector: selection.selector,
		binarySha256:
			selection.kind === "executable" && selection.selector
				? await hashFile(selection.selector)
				: null,
		explicitlySelected: selection.explicitlySelected,
	});

	const registry = createContextRegistry<BrowserContext>();

	const shutdown = createBrowserShutdown(browser);

	return Object.freeze({
		provenance,
		openContext: async (): Promise<ContextHandle> => {
			let context: BrowserContext;
			try {
				context = await browser.newContext({
					// Certificate handling follows the plan: a diagnostic run says so in
					// its provenance, and a normal run does not silently trust anything.
					ignoreHTTPSErrors: plan.insecureDiagnostics,
				});
			} catch (cause) {
				throw new RunwayError(
					"browser/launch-failed",
					`a disposable browser profile could not be created: ${cause instanceof Error ? cause.message : String(cause)}`,
					{ cause }
				);
			}
			return registry.track(context);
		},
		openContextCount: () => registry.openCount(),
		close: async (budgetMs: number = DEFAULT_DISPOSE_BUDGET_MS): Promise<BrowserCloseReport> => {
			// Reap anything a failing lane forgot before shutting the browser down.
			const reaped = await registry.closeAll(budgetMs);
			const browserOutcome = await shutdown.close(budgetMs);
			return Object.freeze({
				contextsClosed: reaped.closed,
				contextsFailed: reaped.failures,
				...browserOutcome,
			});
		},
	});
}
