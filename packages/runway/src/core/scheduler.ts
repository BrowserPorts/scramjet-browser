/**
 * Scheduling with deadlines, serial groups, cancellation and cleanup.
 *
 * The scheduler owns lifetime, not semantics. Every item reaches exactly one
 * conclusion — completed, timed out, cancelled or failed — and every started item
 * gets its cleanup callback run, including when the whole run is aborted. Orphans
 * (items whose work resolves after their deadline) are reported so the caller can
 * record them instead of leaking them.
 *
 * Accounting happens in two steps, because closing an account and writing it down
 * have different timing requirements:
 *
 *   * `onConclude` is synchronous and runs at the deadline/cancellation boundary,
 *     *before* the item's signal is aborted. Aborting runs the work's own listeners
 *     in that same turn, so this is the last instant at which the caller can refuse
 *     further outcomes from work that has just lost its claim to them.
 *   * `onResult` is awaited and runs at the item's conclusion, once. This is where
 *     the caller writes what it now owes.
 *
 * Splitting them is what makes a late success impossible to accept: the refusal
 * cannot be delayed, and the writing does not need to be instant.
 */
import { RunwayError, toRunwayError } from "./errors.ts";

export type ScheduleItem<T> = {
	readonly key: string;
	/** Items sharing a group never overlap, whatever the concurrency is. */
	readonly serialGroup?: string;
	readonly deadlineMs?: number;
	readonly payload: T;
};

export type ItemConclusion = "completed" | "timedOut" | "cancelled" | "failed";

export type ItemResult<T> = {
	readonly item: ScheduleItem<T>;
	readonly conclusion: ItemConclusion;
	readonly durationMs: number;
	readonly error?: RunwayError;
	/** True when the work settled after its deadline had already been reported. */
	readonly orphanSettled?: boolean;
};

export type ScheduleOptions<T> = {
	readonly items: readonly ScheduleItem<T>[];
	readonly concurrency: number;
	readonly defaultDeadlineMs: number;
	readonly signal?: AbortSignal;
	/**
	 * Executes one item. It receives a per-item signal that aborts on deadline or
	 * run abort, and must return promptly once that signal fires.
	 */
	readonly execute: (item: ScheduleItem<T>, signal: AbortSignal) => Promise<void>;
	/** Always invoked for a started item, after `execute` settles or times out. */
	readonly cleanup?: (item: ScheduleItem<T>, conclusion: ItemConclusion) => Promise<void>;
	/**
	 * Closes the item's admissions, synchronously, at the instant its deadline or
	 * the run's cancellation takes it away from it.
	 *
	 * This exists because of an ordering that cannot be fixed anywhere else.
	 * Aborting a signal runs its listeners *synchronously*, inside the
	 * `controller.abort()` call, and `execute` is entitled to register one — that is
	 * how it is told to stop. A listener that reports an outcome therefore runs
	 * before any `await` the scheduler could possibly be sitting on: before the
	 * `Promise.race` settles, before `cleanup`, before {@link onResult}. Anything
	 * the caller does in `onResult` to close the item's account is already too late,
	 * and `cleanup` can push it later still by awaiting whatever it likes.
	 *
	 * So this hook is called *before* the abort, in the same turn, and must be
	 * synchronous. It is the caller's chance to refuse further outcomes for whatever
	 * this item still owes. It is not a second `onResult`: it delivers no result, it
	 * runs only when a boundary took the item (never on a normal completion or
	 * failure), and it does no cleanup.
	 *
	 * It must return nothing, and it must not throw. Both are enforced rather than
	 * trusted, because this runs inside a timer callback and inside an abort
	 * listener, where an exception is uncaught and a rejected promise is unhandled —
	 * either would take the process down instead of failing one item. A hook that
	 * throws, returns a thenable, or exposes a `then` accessor that throws is
	 * reported as `schedule/hook-failed` and *fails the item*: its admissions are in
	 * an unknown state, so nothing it may have reported can be counted.
	 */
	readonly onConclude?: (item: ScheduleItem<T>, reason: "timedOut" | "cancelled") => void;
	/**
	 * Called once per item, at its conclusion, and awaited before the item's slot
	 * is reused.
	 *
	 * Awaited on purpose: the caller uses this to account for the item — to write
	 * the outcomes it still owes — and that accounting has to happen at the
	 * conclusion of *this* item, not after the whole schedule, or a result that
	 * settles late can still be accepted while other items are running. Writing may
	 * await; *refusing* may not, which is what {@link onConclude} is for.
	 */
	readonly onResult?: (result: ItemResult<T>) => void | Promise<void>;
};

export type ScheduleOutcome<T> = {
	readonly results: readonly ItemResult<T>[];
	/** Items never started because the run was aborted first. */
	readonly notStarted: readonly ScheduleItem<T>[];
	readonly aborted: boolean;
};

class Deferred<T> {
	readonly promise: Promise<T>;
	resolve!: (value: T) => void;
	constructor() {
		this.promise = new Promise<T>((resolve) => {
			this.resolve = resolve;
		});
	}
}

/**
 * Runs `items` with bounded concurrency.
 *
 * Deadline handling never cancels the underlying promise (JavaScript cannot), so
 * a late settlement is tracked and surfaced as an orphan rather than ignored.
 */
export async function schedule<T>(
	options: ScheduleOptions<T>
): Promise<ScheduleOutcome<T>> {
	if (options.concurrency < 1) {
		throw new RunwayError("plan/invalid", "concurrency must be at least 1", {
			details: { concurrency: options.concurrency },
		});
	}

	const queue = [...options.items];
	const results: ItemResult<T>[] = [];
	const notStarted: ScheduleItem<T>[] = [];
	const groupLocks = new Map<string, Promise<void>>();
	let aborted = options.signal?.aborted ?? false;

	const onAbort = () => {
		aborted = true;
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	/**
	 * The first failure to *publish* a result, kept rather than thrown on the spot.
	 *
	 * `onResult` is where the caller writes down what an item concluded, so it is
	 * the call that touches storage — a full disk while recording a gap is the way
	 * this actually happens. Thrown from where it occurs, it rejected the worker,
	 * and `Promise.all` then rejected the whole schedule while sibling workers were
	 * still running: their promises went unobserved, the abort listener below was
	 * never removed, and the caller's failure path began accounting for a run whose
	 * live workers were still publishing into it.
	 *
	 * So it is captured here and raised once, after every worker has drained. The
	 * item's own result is already in `results` before publication is attempted, so
	 * the outcome it reached is never lost by the attempt to write it down.
	 */
	let publicationFailure: unknown = null;
	/** Set with {@link publicationFailure}: no further items may be admitted. */
	let stopAdmitting = false;
	/**
	 * Boundary handles for items currently running, so a publication failure can
	 * take them the same way a cancellation does.
	 *
	 * Continuing to produce outcomes for a consumer that has just proved it cannot
	 * accept them only delays the failure and leaves admissions open meanwhile.
	 */
	const inFlight = new Set<(cause: Error) => void>();

	const runItem = async (item: ScheduleItem<T>): Promise<void> => {
		// Re-checked here, not only in the worker loop, because an item can wait an
		// arbitrary time between being taken off the queue and being executed: a
		// serial item waits for its group's lock, and the run can be cancelled while
		// it waits. An item taken by the cancellation never runs its work; it is
		// reported as not started so the caller's accounting still covers it.
		if ((options.signal?.aborted ?? aborted) || stopAdmitting) {
			notStarted.push(item);
			return;
		}

		const controller = new AbortController();
		const deadlineMs = item.deadlineMs ?? options.defaultDeadlineMs;
		const started = Date.now();
		let settled = false;
		let conclusion: ItemConclusion;
		let error: RunwayError | undefined;
		let orphanSettled = false;
		/** Set when a boundary — deadline or cancellation — took the item. */
		let boundary: "timedOut" | "cancelled" | null = null;
		/**
		 * Whether the work had already settled when the boundary fired.
		 *
		 * Read at that instant, not afterwards. An item whose work genuinely finished
		 * before the run was cancelled keeps the outcome it earned; one that was still
		 * in flight was taken by the boundary. Sampling later cannot tell those apart,
		 * because work that settles *from inside* the abort sets `settled` in the same
		 * turn.
		 */
		let settledAtBoundary = false;
		/** Set when `onConclude` broke its contract. Fails the item, with precedence. */
		let hookFault: RunwayError | null = null;

		const hookFailure = (
			reason: "timedOut" | "cancelled",
			detail: string,
			cause?: unknown
		): RunwayError =>
			new RunwayError(
				"schedule/hook-failed",
				`onConclude for ${item.key} ${detail}; it must complete synchronously, because it ` +
					"runs inside the abort that hands the item's work its stop signal",
				{ details: { key: item.key, reason }, ...(cause === undefined ? {} : { cause }) }
			);

		/**
		 * Hands the item's admissions back before aborting it.
		 *
		 * Order is the whole point: the caller's refusal happens first, in this turn,
		 * and `controller.abort()` — which synchronously runs whatever `execute`
		 * registered — happens second. Idempotent, because the deadline and the run's
		 * cancellation can arrive together.
		 *
		 * Nothing in here may throw or leave a rejection unobserved. Its two call
		 * sites are a `setTimeout` callback and an `abort` listener, neither of which
		 * has a caller that could catch anything.
		 */
		/**
		 * Resolved once a boundary has taken this item, so the race can stop waiting.
		 *
		 * JavaScript cannot cancel a promise, so the work keeps running; what this
		 * changes is that the *scheduler* stops pretending it might still matter. It
		 * carries no outcome — only the fact that a boundary fired — because the
		 * outcome of a boundary-taken item is decided by `boundary`, not by whatever
		 * the abandoned work does afterwards.
		 */
		const boundaryTaken = new Deferred<"boundaryTaken">();

		const concludeAt = (reason: "timedOut" | "cancelled", cause: Error): void => {
			if (boundary === null) {
				settledAtBoundary = settled;
				boundary = reason;
				if (options.onConclude) {
					let returned: unknown;
					try {
						returned = options.onConclude(item, reason);
					} catch (thrown) {
						hookFault = hookFailure(reason, "threw", thrown);
					}
					if (!hookFault) {
						// A hostile or lazy `then` is read exactly once here, defensively:
						// a getter that throws is itself a broken contract, not a crash.
						let then: unknown;
						try {
							then = (returned as { then?: unknown } | null | undefined)?.then;
						} catch (thrown) {
							hookFault = hookFailure(reason, "has a `then` accessor that threw when read", thrown);
						}
						if (!hookFault && typeof then === "function") {
							hookFault = hookFailure(reason, "returned a thenable");
							// Not awaited — awaiting it would reopen the gap this hook exists
							// to close — but observed, so a rejection cannot surface as an
							// unhandled rejection and kill the process. `Promise.resolve`
							// re-reads `then` inside its own job, so a getter that throws the
							// second time rejects this promise instead of escaping.
							try {
								void Promise.resolve(returned as PromiseLike<unknown>).then(
									() => undefined,
									() => undefined
								);
							} catch {
								// A thenable so broken that adopting it threw synchronously.
								// Already reported as a hook failure; there is nothing to observe.
							}
						}
					}
				}
			}
			controller.abort(cause);
			// Last, and deliberately after the abort: whatever `execute` registered on
			// the signal runs inside `controller.abort`, in this turn, so work that
			// settles from inside its own abort listener has already done so by the
			// time the race is released. Releasing first would decide the race before
			// that work had its chance to be seen as settled-at-the-boundary.
			boundaryTaken.resolve("boundaryTaken");
		};

		const abortItem = () => concludeAt("cancelled", new Error("run aborted"));
		options.signal?.addEventListener("abort", abortItem, { once: true });
		// Visible to a publication failure raised by a sibling item, which takes
		// everything still running rather than letting it finish into a consumer
		// that cannot record it.
		// Registered as "take this item, with this reason" rather than as the abort
		// listener itself: an item taken because the result consumer failed was not
		// aborted by an operator, and the error it carries should not say it was.
		inFlight.add((cause: Error) => concludeAt("cancelled", cause));
		// `addEventListener` on an already-aborted signal never fires, so an abort
		// that landed between the gate at the top of this function and this line
		// would otherwise be missed entirely and the item would run to completion as
		// if the run were still live. It was already admitted by the time we got
		// here, so it is taken by the boundary — which hands its admissions back —
		// rather than reported as never started.
		if (options.signal?.aborted) abortItem();

		const timeout = new Deferred<"timedOut">();
		const timer = setTimeout(() => {
			// The race arm is resolved before the abort, so that work which resolves
			// *from inside* the abort listener cannot win a race its deadline has
			// already taken.
			timeout.resolve("timedOut");
			concludeAt("timedOut", new Error(`deadline of ${deadlineMs}ms exceeded`));
		}, deadlineMs);

		const work = options
			.execute(item, controller.signal)
			.then(() => {
				settled = true;
				return "completed" as const;
			})
			.catch((cause: unknown) => {
				settled = true;
				error =
					cause instanceof RunwayError
						? cause
						: new RunwayError(
								"internal/unexpected",
								cause instanceof Error ? cause.message : String(cause),
								{ cause }
							);
				return "failed" as const;
			});

		// Three arms, not two. Without the boundary arm a cancelled item went on
		// waiting for work that had already been told to stop — and if that work did
		// not settle in response, the item waited out its full deadline before
		// concluding. A CLI interrupted mid-item therefore sat for the whole item
		// deadline after printing that it was cancelling, writing nothing and
		// holding its fixture servers open, which is indistinguishable from a hang.
		//
		// The work is not stopped by this and is not pretended to be: it stays
		// tracked as an orphan below, its late settlement is observed, and this
		// item's teardown, accounting and result are produced exactly as before.
		// What changes is only that the scheduler stops *waiting* on work whose
		// outcome it has already decided not to use.
		const raced = await Promise.race([work, timeout.promise, boundaryTaken.promise]);
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abortItem);
		inFlight.delete(abortItem);
		// The boundary arm reports that a boundary fired, never what the work did. An
		// item whose work had already settled at that instant keeps the outcome it
		// earned — see `settledAtBoundary` — so its real value is read here rather
		// than discarded in favour of a sentinel. The work is already settled in that
		// case, so this does not wait.
		const outcome =
			raced === "boundaryTaken" && settledAtBoundary ? await work : raced;
		if (boundary !== null && !settledAtBoundary) {
			// Work that settles from *inside* its own abort listener — an attempt that
			// reports why it was torn down — has, at this instant, only queued its
			// continuations: `controller.abort` ran them synchronously, but the
			// handlers that record what it said are microtasks. Draining to the next
			// macrotask lets those run, so what the abandoned work reported is still
			// available to be kept as the cause below.
			//
			// This cannot reintroduce the wait it replaces: the drain ends this turn
			// whatever the work does, so work that never settles costs one turn rather
			// than a full deadline.
			await Promise.race([work, new Promise((resolve) => setImmediate(resolve))]);
		}

		// A boundary that fired first is final, whichever boundary it was. Work that
		// settles afterwards — including work that settles from *inside* the abort
		// listener, in the same turn, whether it resolves or rejects — is an orphan,
		// not a result: this item's admissions were handed back at the boundary and
		// finishing late does not reclaim them.
		//
		// Both reasons are read here, not just the deadline. A cancelled item whose
		// work resolved inside the abort used to be reported as `completed`, and one
		// whose work rejected there as `failed`, so pairs already sealed by the
		// cancellation were written up as infrastructure faults — a cancelled run
		// accusing itself of breaking. Reading `boundary` rather than trusting the
		// race is deliberate: the race's answer depends on microtask ordering, and
		// the seal already happened either way.
		//
		// `settledAtBoundary` is the one exception, and it protects the opposite
		// mistake: an item whose work had *already* finished when the run was
		// cancelled is not retroactively reclassified as cancelled.
		if (boundary !== null && !settledAtBoundary) {
			conclusion = boundary;
			// The boundary is the reason, so it is the error. Anything the abandoned
			// work reported afterwards is kept as the cause rather than promoted over
			// it: a cancelled item that then rejected with "aborted" was cancelled.
			error = new RunwayError(
				boundary === "cancelled" ? "schedule/cancelled" : "schedule/deadline-exceeded",
				boundary === "cancelled"
					? `item ${item.key} was cancelled while it was running`
					: `item ${item.key} exceeded its ${deadlineMs}ms deadline`,
				{ details: { key: item.key, deadlineMs }, ...(error ? { cause: error } : {}) }
			);
			// Track a late settlement so the caller can see the orphan. Both arms:
			// work that rejects late is just as abandoned as work that resolves late.
			void work.then(
				() => {
					orphanSettled = true;
				},
				() => {
					orphanSettled = true;
				}
			);
		} else if (outcome === "timedOut") {
			// Defensive: the deadline arm can only win if the timer fired, which calls
			// `concludeAt`. Kept so a future change cannot silently produce a timeout
			// with no conclusion.
			conclusion = "timedOut";
			error =
				error ??
				new RunwayError(
					"schedule/deadline-exceeded",
					`item ${item.key} exceeded its ${deadlineMs}ms deadline`,
					{ details: { key: item.key, deadlineMs } }
				);
		} else if (outcome === "failed") {
			conclusion = "failed";
		} else {
			conclusion = "completed";
		}

		// A hook that broke its contract leaves this item's admissions in an unknown
		// state, so the item fails and says so — with precedence over the boundary
		// that called the hook. Reporting it as a cancellation or a timeout would file
		// an infrastructure defect under a plausible, blameless outcome, and would let
		// whatever the work reported before the failed seal be counted.
		if (hookFault) {
			conclusion = "failed";
			error = hookFault;
		}

		if (options.cleanup) {
			try {
				await options.cleanup(item, conclusion);
			} catch (cause) {
				// Cleanup failures are infrastructure problems; do not hide them.
				const cleanupError = new RunwayError(
					"internal/unexpected",
					`cleanup for ${item.key} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
					{ cause }
				);
				error = error ?? cleanupError;
				if (conclusion === "completed") conclusion = "failed";
			}
		}

		const result: ItemResult<T> = {
			item,
			conclusion,
			durationMs: Date.now() - started,
			...(error ? { error } : {}),
			...(orphanSettled ? { orphanSettled } : {}),
		};
		// Recorded before it is published, so the conclusion this item reached
		// survives a consumer that cannot write it down.
		results.push(result);
		if (options.onResult) {
			try {
				await options.onResult(result);
			} catch (cause) {
				if (publicationFailure === null) {
					publicationFailure = cause;
					// One failure is enough to know the consumer is broken. New items
					// are refused from here on, and the ones already running are taken
					// at their boundary — which hands their admissions back through the
					// same `onConclude` path a cancellation uses.
					stopAdmitting = true;
					for (const abandon of [...inFlight]) {
						abandon(
							new Error(
								"the run's result consumer failed, so items still running were taken at their boundary"
							)
						);
					}
				}
			}
		}
	};

	const worker = async (): Promise<void> => {
		for (;;) {
			const item = queue.shift();
			if (!item) return;
			if (aborted || stopAdmitting) {
				notStarted.push(item);
				continue;
			}
			if (item.serialGroup) {
				const previous = groupLocks.get(item.serialGroup) ?? Promise.resolve();
				// The gate above was checked before this item queued behind its group's
				// lock, and waiting for that lock can take as long as the item ahead of
				// it takes. `runItem` re-checks on the far side of the wait, so an item
				// whose run was cancelled while it waited does not then start.
				const release = previous.then(() => runItem(item));
				groupLocks.set(
					item.serialGroup,
					release.catch(() => undefined)
				);
				await release;
			} else {
				await runItem(item);
			}
		}
	};

	const workerCount = Math.min(options.concurrency, Math.max(queue.length, 1));
	// `allSettled`, not `all`: every worker is observed and drained before this
	// function returns, however any one of them ended. With `all`, the first
	// rejection returned while siblings were still running — leaving their
	// promises unobserved, and handing the caller a failure to account for while
	// items were still publishing results into that same accounting.
	let settled: PromiseSettledResult<void>[];
	try {
		settled = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
	} finally {
		// In a `finally` because a listener that outlives its schedule keeps a
		// reference to this run's state and fires into it on the next abort.
		options.signal?.removeEventListener("abort", onAbort);
	}

	// A publication failure is the run's failure: the outcomes exist but could not
	// be written down, and a schedule that returned normally here would report a
	// run whose records are incomplete as though nothing had gone wrong. The item's
	// own result is carried on the error rather than lost, and the original cause
	// is preserved beneath it.
	if (publicationFailure !== null) {
		const failure = toRunwayError(publicationFailure);
		throw new RunwayError(
			failure.code,
			`a result could not be published, so the run's records are incomplete: ${failure.message}`,
			{
				details: {
					...failure.details,
					published: results.length,
					notStarted: notStarted.length,
					abandonedForPublicationFailure: true,
				},
				...(failure.remedy ? { remedy: failure.remedy } : {}),
				cause: publicationFailure,
			}
		);
	}
	// Anything else a worker threw still belongs to the caller, raised only now
	// that every sibling has finished.
	const failedWorker = settled.find((outcome) => outcome.status === "rejected");
	if (failedWorker && failedWorker.status === "rejected") throw failedWorker.reason;

	return Object.freeze({
		results: Object.freeze(results),
		notStarted: Object.freeze(notStarted),
		aborted,
	});
}
