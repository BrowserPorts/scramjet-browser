/**
 * Append-only run recorder and its reader.
 *
 * Raw evidence is written once, in order, and never rewritten. Expectations are
 * not consulted here: this layer only knows what happened. The log is flushed on
 * every terminal record and on abort, so a killed run still leaves valid
 * evidence for everything that finished.
 *
 * Reading is strict and *bound to a plan*. The caller supplies the run id, plan
 * hash and planned pairs from the saved plan, and every record must match all
 * three. A log that is self-consistent but belongs to another plan is rejected,
 * because "the first event agreed with the rest of the file" is not evidence that
 * these records answer the plan being compared.
 */
import { mkdir, open, readFile, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { RunwayError, serializeError, toRunwayError } from "./errors.ts";
import { terminalKey, type LaneId, type RunId, type TestId } from "./ids.ts";
import type { PlannedPair } from "./inventory.ts";
import {
	PROTOCOL_VERSION,
	validateRunEvent,
	validateTerminalRecord,
	type RunEvent,
	type TerminalRecord,
} from "./protocol.ts";

export const EVENT_LOG_NAME = "events.jsonl";
export const PLAN_NAME = "plan.json";
export const REPORT_NAME = "report.json";
export const ARTIFACTS_DIRECTORY = "artifacts";

/**
 * Files a comparison may never write over: the run's own raw evidence, its plan
 * (which carries the denominator), its original summary, and the artifact tree.
 */
export const PROTECTED_RUN_ENTRIES: readonly string[] = Object.freeze([
	EVENT_LOG_NAME,
	PLAN_NAME,
	REPORT_NAME,
	ARTIFACTS_DIRECTORY,
]);

export type TerminalRecordInput = Omit<
	TerminalRecord,
	"protocolVersion" | "runId" | "planHash" | "sequence"
>;

/**
 * The part of a `FileHandle` a run log actually uses.
 *
 * Named so the log can be opened through a seam: the ordering guarantee is about
 * how many writes are in flight at once, which is observable from here and from
 * nowhere else. `FileHandle` satisfies this structurally.
 */
export type RunLogHandle = {
	write(data: string): Promise<unknown>;
	datasync(): Promise<void>;
	close(): Promise<void>;
};

export type RecorderOptions = {
	readonly runId: RunId;
	readonly planHash: string;
	readonly directory: string;
	readonly knownTests: ReadonlySet<TestId>;
	readonly knownLanes: ReadonlySet<LaneId>;
	readonly clock?: () => Date;
	/**
	 * Opens the log. Defaults to an exclusive-create append handle on disk.
	 *
	 * A seam, in the same shape as `RunOptions.openRecorder`: production passes
	 * nothing and gets the real file. A test can wrap the real handle to observe
	 * write concurrency, which is the one property the queue exists to control and
	 * the one property a finished file cannot be asked about afterwards.
	 */
	readonly openLog?: (file: string) => Promise<RunLogHandle>;
};

export class RunRecorder {
	#handle: RunLogHandle;
	readonly #options: RecorderOptions;
	readonly #seen = new Map<string, number>();
	/** Pairs closed by a gap terminal. A later record for one is stale, not a duplicate. */
	readonly #sealed = new Set<string>();
	#sequence = 0;
	#closed = false;
	/**
	 * The ordering spine. Every admitted write links onto it, so bytes reach the
	 * file in the order the writes were admitted.
	 *
	 * Without this, `#reserve` handed out sequence numbers synchronously while the
	 * writes themselves raced in the libuv threadpool: two concurrent
	 * `recordTerminal` calls could reserve 1 then 2 and land 2 then 1. `O_APPEND`
	 * makes each write atomic, not ordered — and {@link loadRun} rejects a record
	 * whose sequence does not follow the last one, so a lost race is a dropped
	 * record in the report, not a cosmetic reordering.
	 *
	 * The spine never rejects. A rejected spine would strand every later write
	 * behind a failure that was not theirs; instead each write's own promise
	 * carries its own failure to its own caller, and the spine remembers the first
	 * one in {@link #writeFailure} so {@link finish} can act on it.
	 */
	#tail: Promise<void> = Promise.resolve();
	/**
	 * The first failure among admitted writes, kept so `finish` can observe it.
	 *
	 * A log whose body is incomplete has not earned a completion marker, and the
	 * failure that made it incomplete is the one worth reporting.
	 */
	#writeFailure: unknown = null;

	private constructor(handle: RunLogHandle, options: RecorderOptions) {
		this.#handle = handle;
		this.#options = options;
	}

	static async open(options: RecorderOptions): Promise<RunRecorder> {
		await mkdir(options.directory, { recursive: true });
		const file = path.join(options.directory, EVENT_LOG_NAME);
		const handle = await (options.openLog ??
			// Exclusive create: a run directory is written once.
			((target: string) => open(target, "ax")))(file);
		return new RunRecorder(handle, options);
	}

	get directory(): string {
		return this.#options.directory;
	}

	get terminalCount(): number {
		return this.#seen.size;
	}

	/** True when this pair already has its one terminal record. */
	hasTerminal(testId: TestId, laneId: LaneId): boolean {
		return this.#seen.has(terminalKey(testId, laneId));
	}

	#now(): string {
		return (this.#options.clock?.() ?? new Date()).toISOString();
	}

	/**
	 * Admits one event to the log, or refuses it.
	 *
	 * Admission is decided and recorded synchronously — before this function's
	 * first `await` — so a caller that reserved a sequence number and then called
	 * `#append` in the same turn cannot be overtaken by a caller that reserved a
	 * later one. That is the whole ordering guarantee: reserve order is admission
	 * order is byte order.
	 */
	async #append(event: RunEvent): Promise<void> {
		if (this.#closed) {
			// The closure is claimed synchronously by `finish`, so this refusal also
			// covers the window between that claim and the marker actually being
			// written. A late admission — an orphaned executor still reporting after
			// the scheduler returned — is refused rather than landing after the
			// run's own ending.
			throw new RunwayError("recorder/closed", "the recorder is closed", {
				details: { event: event.type },
			});
		}
		await this.#admit(event);
	}

	/**
	 * Links one write onto the ordering spine and returns *that write's* promise.
	 *
	 * The event is serialized now, at admission, rather than when the write reaches
	 * the head of the queue: the bytes belong to the state the caller admitted,
	 * which is the state its sequence number describes.
	 */
	#admit(event: RunEvent): Promise<void> {
		const line = `${JSON.stringify(event)}\n`;
		const admitted = this.#tail.then(() => this.#handle.write(line).then(() => undefined));
		// Two promises, deliberately. `admitted` goes to the caller and carries the
		// caller's own failure. The spine takes a settled-either-way continuation so
		// the queue keeps draining, and remembers the first failure rather than
		// swallowing it. Both have handlers, so neither can surface as an unhandled
		// rejection.
		this.#tail = admitted.then(
			() => undefined,
			(cause: unknown) => {
				if (this.#writeFailure === null) this.#writeFailure = cause;
			}
		);
		return admitted;
	}

	/**
	 * Forces the log to disk. Called after terminals and on abort.
	 *
	 * Joins the write queue first. `datasync` only promises that what has already
	 * reached the descriptor is durable, so syncing while admitted writes are still
	 * queued would report a durability the file does not have.
	 */
	async flush(): Promise<void> {
		if (this.#closed) return;
		await this.#tail;
		if (this.#closed) return;
		await this.#handle.datasync();
	}

	async runStarted(plannedPairs: number): Promise<void> {
		await this.#append({
			type: "runStarted",
			protocolVersion: PROTOCOL_VERSION,
			runId: this.#options.runId,
			planHash: this.#options.planHash,
			at: this.#now(),
			plannedPairs,
		});
		await this.flush();
	}

	async diagnostic(
		level: "info" | "warning" | "error",
		message: string,
		extra: {
			readonly testId?: TestId;
			readonly laneId?: LaneId;
			readonly details?: Readonly<Record<string, unknown>>;
		} = {}
	): Promise<void> {
		await this.#append({
			type: "diagnostic",
			runId: this.#options.runId,
			at: this.#now(),
			level,
			message,
			...extra,
		});
	}

	/**
	 * Reserves this pair's single terminal slot, synchronously.
	 *
	 * The check and the reservation happen in one turn, before any `await`, so two
	 * concurrent producers can never both believe they own the pair.
	 */
	#reserve(input: TerminalRecordInput, options: { readonly gap: boolean }): TerminalRecord {
		if (!this.#options.knownTests.has(input.testId)) {
			throw new RunwayError(
				"record/unknown-test",
				`test ${input.testId} is not in this run's inventory`,
				{ details: { testId: input.testId } }
			);
		}
		if (!this.#options.knownLanes.has(input.laneId)) {
			throw new RunwayError(
				"record/unknown-lane",
				`lane ${input.laneId} is not in this run's plan`,
				{ details: { laneId: input.laneId } }
			);
		}
		const key = terminalKey(input.testId, input.laneId);
		// A gap record is the sealer's own answer for a pair it just closed, so it
		// is the one writer allowed to fill a sealed slot.
		if (!options.gap && this.#sealed.has(key)) {
			throw new RunwayError(
				"record/stale-terminal",
				`${input.testId} on ${input.laneId} was already closed by a scheduler terminal; ` +
					"this late result arrived after the pair was accounted for",
				{
					details: {
						testId: input.testId,
						laneId: input.laneId,
						sequence: this.#seen.get(key) ?? null,
					},
					remedy:
						"The work settled after its deadline or after cancellation. It is reported " +
						"as an orphan, never as a second outcome for the pair.",
				}
			);
		}
		const existing = this.#seen.get(key);
		if (existing !== undefined) {
			throw new RunwayError(
				"record/duplicate-terminal",
				`a terminal record already exists for ${input.testId} on ${input.laneId}`,
				{
					details: { testId: input.testId, laneId: input.laneId, sequence: existing },
					remedy:
						"Each planned pair produces exactly one terminal record; report " +
						"additional information as diagnostics or artifacts.",
				}
			);
		}
		const record = validateTerminalRecord({
			...input,
			protocolVersion: PROTOCOL_VERSION,
			runId: this.#options.runId,
			planHash: this.#options.planHash,
			sequence: ++this.#sequence,
		});
		this.#seen.set(key, record.sequence);
		return record;
	}

	/**
	 * Records the single terminal outcome for one (test, lane) pair.
	 *
	 * Rejects foreign runs, unknown ids, duplicates and late results for pairs the
	 * scheduler already closed. A rejected record never overwrites an accepted one.
	 */
	async recordTerminal(input: TerminalRecordInput): Promise<TerminalRecord> {
		const record = this.#reserve(input, { gap: false });
		await this.#append({ type: "terminal", record });
		await this.flush();
		return record;
	}

	/**
	 * Closes outstanding pairs, synchronously, in a single turn.
	 *
	 * Called when an item reaches its conclusion — the moment after which nothing
	 * it produces is a result any more. Sealing is separated from writing on
	 * purpose: writing needs `await`, and a late `recordTerminal` that lands during
	 * that await would otherwise be accepted as the pair's one outcome. After this
	 * returns, every pair it names is closed, and the returned pairs are the ones
	 * still owed a gap record.
	 *
	 * A pair that already has a real terminal record is left alone: sealing never
	 * replaces an outcome.
	 */
	sealOutstanding(pairs: readonly PlannedPair[]): readonly PlannedPair[] {
		const owed: PlannedPair[] = [];
		for (const pair of pairs) {
			const key = terminalKey(pair.testId, pair.laneId);
			if (this.#seen.has(key) || this.#sealed.has(key)) continue;
			this.#sealed.add(key);
			owed.push(pair);
		}
		return Object.freeze(owed);
	}

	/** True when this pair has been closed by the sealer. */
	isSealed(testId: TestId, laneId: LaneId): boolean {
		return this.#sealed.has(terminalKey(testId, laneId));
	}

	/**
	 * Records a terminal outcome for a pair the executor never reported.
	 *
	 * Used by the scheduler's gap accounting: a cancelled, timed-out or failed item
	 * still owes every planned pair exactly one outcome. If the pair was recorded
	 * concurrently after all, the existing record stands and this returns `null` —
	 * a gap terminal never competes with a real one.
	 */
	async recordGapTerminal(input: TerminalRecordInput): Promise<TerminalRecord | null> {
		const key = terminalKey(input.testId, input.laneId);
		if (this.#seen.has(key)) return null;
		const record = this.#reserve(input, { gap: true });
		this.#sealed.add(key);
		await this.#append({ type: "terminal", record });
		await this.flush();
		return record;
	}

	/**
	 * Writes the closing event and releases the handle.
	 *
	 * Three guarantees, in the order they matter:
	 *
	 * 1. **At most one completion event, and it is last.** The log is marked closed
	 *    synchronously, before the first `await`, so a second `finish` — a retry, or
	 *    two callers racing — returns without writing a second marker and without
	 *    closing an already-closed handle. The same claim refuses new admissions,
	 *    and the writes already admitted are drained before the marker is written,
	 *    so nothing can land after the run's own ending. A run has exactly one
	 *    ending or none, and it is the last line in the file.
	 * 2. **The handle is always released.** The close runs whatever the write did.
	 *    A write that fails is precisely when the descriptor must not be leaked,
	 *    and a recorder whose write failed is still closed to further events:
	 *    fail-closed, never a log that quietly accepts more after its ending was
	 *    refused.
	 * 3. **Nothing is swallowed.** A failed write is raised with its own code and
	 *    message intact; a close that then also fails rides along as structured
	 *    detail rather than replacing it. When only the close fails, that is the
	 *    failure raised — the marker is on disk, but the descriptor is not accounted
	 *    for, and a caller is entitled to know.
	 *
	 * A durability failure is reported exactly like a write failure, deliberately:
	 * the guarded region covers the write *and* its `datasync`, because a completion
	 * marker that is not durable is not evidence, and a reader cannot tell the two
	 * apart from the file afterwards either.
	 *
	 * A failed `finish` leaves no `runFinished` event, so a later {@link loadRun}
	 * reports the run unfinished. That is deliberate: a completion marker is a claim
	 * about how the run ended, and a run whose ending could not be recorded has not
	 * earned one. The same rule covers a body that is incomplete: if one of the
	 * writes admitted before the claim failed, no marker is written at all and that
	 * failure — not a later, tidier one — is what this raises. A run missing a
	 * record in the middle has not earned an ending either.
	 */
	async finish(reason: "completed" | "aborted" | "failed"): Promise<void> {
		if (this.#closed) return;
		// Claimed before anything can suspend. Everything below runs exactly once,
		// and every `#append` from here on is refused rather than queued.
		this.#closed = true;
		// Everything admitted before the claim is owed a place in the file ahead of
		// the marker. The spine never rejects, so this join cannot throw; a failure
		// among those writes is waiting in `#writeFailure`.
		await this.#tail;
		let writeFailure: unknown = this.#writeFailure;
		// Which write failed changes what the caller should believe about the file,
		// so it is reported rather than left to be inferred from the message.
		const failedPhase = writeFailure === null ? "completionMarker" : "body";
		if (writeFailure === null) {
			try {
				// Straight to the handle: the queue is drained and closed to new work,
				// so this is the only write in flight and it needs no place in line.
				await this.#handle.write(
					`${JSON.stringify({
						type: "runFinished",
						runId: this.#options.runId,
						at: this.#now(),
						reason,
						terminalCount: this.#seen.size,
					})}\n`
				);
				// Not `flush()`: that returns early now that the log is marked closed.
				// The durability of the last event is part of writing it.
				await this.#handle.datasync();
			} catch (cause) {
				writeFailure = cause;
			}
		}
		let closeFailure: unknown = null;
		try {
			await this.#handle.close();
		} catch (cause) {
			closeFailure = cause;
		}
		if (writeFailure !== null) {
			const failure = toRunwayError(writeFailure);
			throw new RunwayError(
				failure.code,
				failedPhase === "body"
					? "the run's log is missing a record that was admitted to it, so no " +
						`completion marker was written: ${failure.message}`
					: `the run's completion marker could not be written: ${failure.message}`,
				{
					details: {
						...failure.details,
						// The operating system's own verdict, kept verbatim. `ENOSPC` and
						// `EBADF` are different problems with different remedies, and
						// both arrive here as an unmapped `internal/unexpected` whose
						// message is the only thing that distinguishes them.
						...systemErrorDetails(writeFailure),
						reason,
						failedPhase,
						// Says plainly whether the descriptor was accounted for, because
						// the answer is not implied by the write having failed.
						handleReleased: closeFailure === null,
						...(closeFailure === null
							? {}
							: { closeError: serializeError(closeFailure) }),
					},
					...(failure.remedy ? { remedy: failure.remedy } : {}),
					cause: writeFailure,
				}
			);
		}
		if (closeFailure !== null) {
			const failure = toRunwayError(closeFailure);
			throw new RunwayError(
				failure.code,
				`the run's completion marker was written but its log handle could not be closed: ${failure.message}`,
				{
					details: {
						...failure.details,
						...systemErrorDetails(closeFailure),
						reason,
						handleReleased: false,
					},
					...(failure.remedy ? { remedy: failure.remedy } : {}),
					cause: closeFailure,
				}
			);
		}
	}
}

/**
 * The operating system's own fields from a Node system error, when there are any.
 *
 * A failed write arrives as an `Error` carrying `code: "ENOSPC"`, an `errno`, the
 * `syscall` and often the `path`. Wrapping it maps it to `internal/unexpected` and
 * keeps only the message, which reads the same for a full disk and a bad
 * descriptor while meaning entirely different things. These fields are what a
 * caller acts on, so they travel as data rather than as prose.
 *
 * Returns an empty object for anything that is not a system error, so a caller can
 * always spread it. `systemCode` is deliberately not called `code`: `code` on a
 * structured error already means the Runway error code, and two different `code`s
 * in one details bag is how the wrong one gets read.
 */
function systemErrorDetails(value: unknown): Record<string, unknown> {
	if (!(value instanceof Error)) return {};
	const system = value as NodeJS.ErrnoException;
	const details: Record<string, unknown> = {};
	if (typeof system.code === "string") details.systemCode = system.code;
	if (typeof system.errno === "number") details.errno = system.errno;
	if (typeof system.syscall === "string") details.syscall = system.syscall;
	if (typeof system.path === "string") details.path = system.path;
	return details;
}

export type RejectedLine = {
	readonly line: number;
	readonly code: string;
	readonly message: string;
};

/** Identity a run log must answer to, taken from the saved plan. */
export type RunBinding = {
	readonly runId: RunId;
	readonly planHash: string;
	readonly pairs: readonly PlannedPair[];
};

export type LoadedRun = {
	readonly runId: RunId;
	readonly planHash: string;
	readonly records: readonly TerminalRecord[];
	readonly events: readonly RunEvent[];
	/** Lines that could not be accepted, with the reason. Never dropped silently. */
	readonly rejected: readonly RejectedLine[];
	readonly finished: boolean;
	readonly finishReason: "completed" | "aborted" | "failed" | null;
	/** `plannedPairs` as the log itself declared it. */
	readonly declaredPlannedPairs: number | null;
	/** `terminalCount` as the completion event declared it. */
	readonly declaredTerminalCount: number | null;
};

/**
 * Reads a run log back for offline comparison.
 *
 * Validation is strict and non-destructive: duplicates, out-of-order sequences,
 * foreign run ids, foreign plan hashes, records for pairs the plan never planned
 * and malformed lines are reported, never repaired. The event sequence itself is
 * checked too — one `runStarted` first, terminals in between, nothing after
 * `runFinished` — because a log with a swapped or spliced body is not evidence.
 */
export async function loadRun(directory: string, binding: RunBinding): Promise<LoadedRun> {
	const file = path.join(directory, EVENT_LOG_NAME);
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (cause) {
		throw new RunwayError("record/malformed", `the run log ${file} could not be read`, {
			details: { file },
			remedy: "Pass the directory that contains plan.json and events.jsonl.",
			cause,
		});
	}

	const plannedKeys = new Set<string>();
	const plannedTests = new Set<string>();
	for (const pair of binding.pairs) {
		plannedKeys.add(terminalKey(pair.testId, pair.laneId));
		plannedTests.add(pair.testId);
	}

	const records: TerminalRecord[] = [];
	const events: RunEvent[] = [];
	const rejected: RejectedLine[] = [];
	const seen = new Map<string, number>();
	let lastSequence = 0;
	let started = false;
	let finished = false;
	let finishReason: LoadedRun["finishReason"] = null;
	let declaredPlannedPairs: number | null = null;
	let declaredTerminalCount: number | null = null;
	let finishLine: number | null = null;

	const reject = (line: number, code: string, message: string): void => {
		rejected.push({ line, code, message });
	};

	const lines = raw.split("\n");
	for (const [index, line] of lines.entries()) {
		if (line.trim() === "") continue;
		const lineNumber = index + 1;
		let event: RunEvent;
		try {
			event = validateRunEvent(JSON.parse(line));
		} catch (error) {
			reject(
				lineNumber,
				error instanceof RunwayError ? error.code : "record/malformed",
				error instanceof Error ? error.message : String(error)
			);
			continue;
		}
		if (finished) {
			// Includes a second `runFinished`: a run ends once, and a log that ends
			// twice cannot say which ending is the run's.
			reject(
				lineNumber,
				"record/event-sequence",
				event.type === "runFinished"
					? `a second completion event (${event.reason}) follows the one on line ${finishLine}`
					: `a ${event.type} event follows the run's completion event`
			);
			continue;
		}
		if (event.type === "runStarted") {
			if (started) {
				reject(lineNumber, "record/event-sequence", "the log has more than one runStarted event");
				continue;
			}
			if (event.runId !== binding.runId || event.planHash !== binding.planHash) {
				throw new RunwayError(
					"record/foreign-run",
					`the run log was produced by run ${event.runId} under plan ${event.planHash}, ` +
						`but it is being compared against run ${binding.runId} under plan ${binding.planHash}`,
					{
						details: {
							file,
							logRunId: event.runId,
							logPlanHash: event.planHash,
							planRunId: binding.runId,
							planHash: binding.planHash,
						},
						remedy:
							"Compare a run directory with its own plan.json. Records are bound to the " +
							"plan hash, which includes the planned inventory.",
					}
				);
			}
			started = true;
			declaredPlannedPairs = event.plannedPairs;
			if (event.plannedPairs !== binding.pairs.length) {
				reject(
					lineNumber,
					"record/event-sequence",
					`the log declares ${event.plannedPairs} planned pair(s) but the plan plans ${binding.pairs.length}`
				);
			}
			events.push(event);
			continue;
		}
		if (!started) {
			reject(
				lineNumber,
				"record/event-sequence",
				`a ${event.type} event appears before the log's runStarted event`
			);
			continue;
		}
		if (event.type === "runFinished") {
			if (event.runId !== binding.runId) {
				reject(
					lineNumber,
					"record/foreign-run",
					`the completion event belongs to run ${event.runId}, not ${binding.runId}`
				);
				continue;
			}
			finished = true;
			finishReason = event.reason;
			finishLine = lineNumber;
			declaredTerminalCount = event.terminalCount;
			events.push(event);
			continue;
		}
		if (event.type === "diagnostic") {
			// A diagnostic is bound to the same run as every other event. This is not
			// throat-clearing: diagnostics carry the admission-integrity report that
			// withdraws qualification, so a diagnostic spliced in from another run
			// could silently disqualify pairs of this one — or, after a copy, quietly
			// ride along with no binding at all. Foreign diagnostics are rejected in
			// the same vocabulary as foreign terminals.
			if (event.runId !== binding.runId) {
				reject(
					lineNumber,
					"record/foreign-run",
					`a diagnostic event belongs to run ${event.runId}, not ${binding.runId}`
				);
				continue;
			}
			events.push(event);
			continue;
		}

		const record = event.record;
		if (record.runId !== binding.runId) {
			reject(
				lineNumber,
				"record/foreign-run",
				`record for ${record.testId} on ${record.laneId} belongs to run ${record.runId}, not ${binding.runId}`
			);
			continue;
		}
		if (record.planHash !== binding.planHash) {
			reject(
				lineNumber,
				"record/foreign-plan",
				`record for ${record.testId} on ${record.laneId} was produced under plan ` +
					`${record.planHash}, not ${binding.planHash}`
			);
			continue;
		}
		const key = terminalKey(record.testId, record.laneId);
		if (!plannedKeys.has(key)) {
			reject(
				lineNumber,
				plannedTests.has(record.testId) ? "record/unknown-lane" : "record/unknown-test",
				plannedTests.has(record.testId)
					? `record claims lane ${record.laneId} for ${record.testId}, which the plan did not plan`
					: `record claims test ${record.testId}, which this plan's inventory does not contain`
			);
			continue;
		}
		if (record.sequence <= lastSequence) {
			reject(
				lineNumber,
				"record/out-of-order",
				`sequence ${record.sequence} does not follow ${lastSequence}`
			);
			continue;
		}
		if (seen.has(key)) {
			reject(
				lineNumber,
				"record/duplicate-terminal",
				`duplicate terminal record for ${record.testId} on ${record.laneId}`
			);
			continue;
		}
		seen.set(key, record.sequence);
		lastSequence = record.sequence;
		records.push(record);
		events.push(event);
	}

	if (!started) {
		throw new RunwayError(
			"record/event-sequence",
			`the run log ${file} has no runStarted event, so nothing binds its records to a run`,
			{
				details: { file, lines: lines.length },
				remedy: "Compare a directory written by `runway run`; a log body alone is not a run.",
			}
		);
	}

	// The completion event makes a counted claim about the body above it. It is
	// checked against what the body actually contains, because "the run says it
	// wrote 1400 terminals" is not evidence that 1400 terminals are there — and a
	// run that claims to have *completed* owes the plan one terminal per planned
	// pair, not a partial set with a green marker on the end.
	if (finished && declaredTerminalCount !== null) {
		if (declaredTerminalCount !== records.length) {
			reject(
				finishLine ?? lines.length,
				"record/event-sequence",
				`the completion event declares ${declaredTerminalCount} terminal record(s) but the ` +
					`log contains ${records.length} acceptable one(s)`
			);
		}
		if (finishReason === "completed" && records.length < binding.pairs.length) {
			reject(
				finishLine ?? lines.length,
				"record/event-sequence",
				`the run claims it completed, but ${binding.pairs.length - records.length} of ` +
					`${binding.pairs.length} planned pair(s) have no terminal record`
			);
		}
	}

	return Object.freeze({
		runId: binding.runId,
		planHash: binding.planHash,
		records: Object.freeze(records),
		events: Object.freeze(events),
		rejected: Object.freeze(rejected),
		finished,
		finishReason,
		declaredPlannedPairs,
		declaredTerminalCount,
	});
}

/**
 * Writes a derived JSON document without ever replacing one.
 *
 * The name is created exclusively (`wx`): if it exists, the write fails rather
 * than clobbering evidence or an earlier report.
 */
async function writeExclusive(file: string, value: unknown): Promise<void> {
	const handle = await open(file, "wx");
	try {
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await handle.datasync();
	} finally {
		await handle.close();
	}
}

/**
 * Writes the run's own report. Reports are derived, not evidence.
 *
 * A run directory is created once, so this refuses to overwrite an existing
 * report: a second summary for the same run would make the directory ambiguous.
 */
export async function writeReport(
	directory: string,
	name: string,
	value: unknown
): Promise<string> {
	const file = path.join(directory, name);
	try {
		await writeExclusive(file, value);
	} catch (cause) {
		if ((cause as { code?: string }).code === "EEXIST") {
			throw new RunwayError(
				"report/write-refused",
				`${file} already exists; a recorded run's report is written once`,
				{
					details: { file },
					remedy: "Use `runway compare` to recompute a verdict; it writes a new derived report.",
				}
			);
		}
		throw cause;
	}
	return file;
}

/**
 * Writes a new derived report inside a recorded run, under a name that is not in
 * use.
 *
 * Two comparisons in the same second must not collide, so the name is claimed by
 * exclusive creation and a counter is appended until one succeeds. Nothing that
 * already exists is touched.
 */
export async function writeDerivedReport(
	directory: string,
	prefix: string,
	value: unknown,
	now: Date = new Date()
): Promise<string> {
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	for (let attempt = 0; attempt < 1000; attempt += 1) {
		const name = attempt === 0 ? `${prefix}-${stamp}.json` : `${prefix}-${stamp}-${attempt + 1}.json`;
		if (PROTECTED_RUN_ENTRIES.includes(name)) continue;
		const file = path.join(directory, name);
		try {
			await writeExclusive(file, value);
			return file;
		} catch (cause) {
			if ((cause as { code?: string }).code === "EEXIST") continue;
			throw cause;
		}
	}
	throw new RunwayError(
		"report/write-refused",
		`could not find an unused ${prefix} report name in ${directory}`,
		{ details: { directory, prefix } }
	);
}

/**
 * Resolves a path that does not exist yet to where it would actually land.
 *
 * `path.resolve` is lexical: it reports `run/alias/new.json` as being under
 * `run/alias`, even when `alias` is a symbolic link into `run/artifacts`. So the
 * deepest ancestor that does exist is resolved with `realpath` and the components
 * that do not exist yet are re-appended to it. The result is the location the
 * filesystem would use, which is the only location worth checking.
 */
async function resolveIntendedPath(target: string): Promise<string> {
	const pending: string[] = [];
	let current = path.resolve(target);
	for (;;) {
		try {
			const real = await realpath(current);
			return pending.length === 0 ? real : path.join(real, ...pending);
		} catch (cause) {
			const code = (cause as { code?: string }).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
			const parent = path.dirname(current);
			// Reached the filesystem root without finding anything that exists.
			if (parent === current) return path.resolve(target);
			pending.unshift(path.basename(current));
			current = parent;
		}
	}
}

/**
 * Refuses a write that would land inside a recorded run's evidence.
 *
 * Containment is decided on canonical paths, so a symbolic link anywhere in the
 * ancestry cannot be used to reach `events.jsonl`, `plan.json`, `report.json` or
 * the artifact tree. Exclusive creation alone is not enough: it stops a file from
 * being replaced, but a *new* file written inside `artifacts/` through an aliased
 * parent would still add to a directory that is read-only by contract.
 *
 * This is containment, not immutability. Runway does not sign a run directory and
 * cannot stop a process with write access from editing one; what it guarantees is
 * that Runway itself never writes there after the run.
 */
async function assertOutsideProtectedEvidence(
	canonicalTarget: string,
	protectedRoot: string
): Promise<void> {
	const root = await resolveIntendedPath(protectedRoot);
	const relative = path.relative(root, canonicalTarget);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return;
	const firstSegment = relative.split(path.sep)[0]!;
	if (!PROTECTED_RUN_ENTRIES.includes(firstSegment)) return;
	throw new RunwayError(
		"report/write-refused",
		`${canonicalTarget} is part of the recorded run's evidence and is never written by a comparison`,
		{
			details: { target: canonicalTarget, protectedRoot: root, entry: firstSegment },
			remedy:
				"Point --output at a path of your own, or omit it to write a new derived " +
				"report inside the run directory.",
		}
	);
}

/**
 * Writes a derived report to a consumer-named path.
 *
 * The path may not resolve into a run's raw evidence, its plan, its original
 * report or its artifact tree — through a symbolic link or otherwise — and an
 * existing file is never replaced. The containment check runs before any
 * directory is created and again after, because `mkdir -p` can itself traverse a
 * link that appeared in between.
 */
export async function writeReportToPath(
	file: string,
	value: unknown,
	options: { readonly protectedRoot?: string } = {}
): Promise<string> {
	const target = path.resolve(file);
	if (options.protectedRoot) {
		await assertOutsideProtectedEvidence(await resolveIntendedPath(target), options.protectedRoot);
	}
	await mkdir(path.dirname(target), { recursive: true });
	if (options.protectedRoot) {
		await assertOutsideProtectedEvidence(await resolveIntendedPath(target), options.protectedRoot);
	}
	try {
		await writeExclusive(target, value);
	} catch (cause) {
		if ((cause as { code?: string }).code === "EEXIST") {
			throw new RunwayError(
				"report/write-refused",
				`${target} already exists; a comparison never overwrites a file`,
				{
					details: { target },
					remedy: "Choose a new --output path.",
				}
			);
		}
		throw cause;
	}
	return target;
}
