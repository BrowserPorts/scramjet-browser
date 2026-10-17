/**
 * Cross-lane consistency broker.
 *
 * Some regression tests report a value from the page and require every lane to
 * observe the same one. The broker pairs those values by label within a single
 * test, and the page's call does not resolve until every participating lane has
 * reported, which is what makes the comparison a real rendezvous rather than a
 * race.
 *
 * A label is a contract, not a hint: exactly one submission per label per lane.
 * A lane that reports the same label twice, reports a label after the rendezvous
 * closed, or reports a label the broker cannot attribute to a participating lane
 * is a defect in the test, so the broker refuses the submission, records the
 * refused observation as an issue, and rejects the caller's promise. Nothing is
 * dropped on the floor: every refusal reaches `finalize`, which is what the
 * executor turns into a terminal outcome.
 *
 * A single-lane run cannot cross-check anything. The broker says so explicitly
 * (`crossChecked: false`) instead of reporting vacuous agreement, but it still
 * reports contract violations, because misuse is misuse in one lane too.
 */
import { isDeepStrictEqual } from "node:util";
import { RunwayError } from "./errors.ts";
import type { LaneId } from "./ids.ts";

export type ConsistencyIssueReason =
	/** Lanes paired on this label and observed different values. */
	| "valuesDiffer"
	/** A participating lane never reported this label. */
	| "incomplete"
	/** One lane reported the same label more than once. */
	| "duplicateSubmission"
	/** A lane reported after the rendezvous was finalized. */
	| "lateSubmission"
	/** A submission arrived from a lane that is not part of this rendezvous. */
	| "unknownLane"
	/** A submission arrived without an explicit, non-empty label. */
	| "invalidLabel";

export type ConsistencyIssue = {
	readonly label: string;
	readonly reason: ConsistencyIssueReason;
	/** Accepted values, keyed by lane id. */
	readonly values: Readonly<Record<string, unknown>>;
	/** The lane a submission-level issue is attributed to. */
	readonly lane?: string;
	/** The observation the broker refused, kept so it is never silently lost. */
	readonly rejected?: unknown;
	/** One sentence naming what went wrong, for the record and the CLI. */
	readonly detail: string;
};

export type ConsistencyBroker = {
	/**
	 * Resolves once every participating lane has reported this label.
	 *
	 * The label is typed `unknown` because that is what it is: it arrives from a
	 * page, over a browser binding, as whatever that page sent. Declaring it
	 * `string` pushed the claim onto the caller, which had to assert a shape
	 * nobody had checked — while the broker validated it again anyway. The
	 * validation lives here, once, and the signature now says so, so a caller
	 * forwards the raw value instead of casting it.
	 *
	 * Rejects with `suite/unsupported-case` when the label is not a non-empty
	 * string, or when the submission breaks the one-per-lane-per-label contract;
	 * the same refusal is also recorded as an issue so the terminal outcome
	 * cannot silently stay green.
	 */
	readonly submit: (lane: LaneId, label: unknown, value: unknown) => Promise<void>;
	/** Waits for outstanding labels, then reports what disagreed or never arrived. */
	readonly finalize: (timeoutMs: number) => Promise<{
		readonly crossChecked: boolean;
		readonly issues: readonly ConsistencyIssue[];
	}>;
};

type Entry = {
	readonly values: Map<LaneId, unknown>;
	readonly waiters: (() => void)[];
	settled: boolean;
};

/** Labels come from the page, so they are described rather than trusted. */
function describeLabel(label: unknown): string {
	if (typeof label === "string") return label;
	try {
		return `<${typeof label}: ${String(label)}>`;
	} catch {
		return `<${typeof label}>`;
	}
}

export function createConsistencyBroker(lanes: readonly LaneId[]): ConsistencyBroker {
	const participating = [...new Set(lanes)];
	const crossChecked = participating.length > 1;
	const entries = new Map<string, Entry>();
	const issues: ConsistencyIssue[] = [];
	let closed = false;

	const entryFor = (label: string): Entry => {
		let entry = entries.get(label);
		if (!entry) {
			entry = { values: new Map(), waiters: [], settled: false };
			entries.set(label, entry);
		}
		return entry;
	};

	const release = (entry: Entry): void => {
		entry.settled = true;
		for (const waiter of entry.waiters.splice(0)) waiter();
	};

	const snapshot = (entry: Entry | undefined): Readonly<Record<string, unknown>> =>
		Object.freeze(
			Object.fromEntries([...(entry?.values ?? [])].map(([lane, value]) => [lane, value]))
		);

	/**
	 * Records the refusal and builds the error the caller is rejected with. Both
	 * happen for every refusal, never one without the other.
	 */
	const refusal = (issue: ConsistencyIssue, remedy: string): RunwayError => {
		issues.push(Object.freeze(issue));
		return new RunwayError("suite/unsupported-case", issue.detail, {
			details: {
				label: issue.label,
				reason: issue.reason,
				...(issue.lane === undefined ? {} : { lane: issue.lane }),
				lanes: participating,
			},
			remedy,
		});
	};

	return Object.freeze({
		submit: async (lane, label, value) => {
			if (typeof label !== "string" || label.trim() === "") {
				throw refusal(
					{
						label: describeLabel(label),
						reason: "invalidLabel",
						values: Object.freeze({}),
						lane,
						rejected: value,
						detail:
							"a consistency submission needs an explicit, non-empty label; " +
							`${describeLabel(label)} is not one`,
					},
					"Give each assertConsistent() call in a test a unique label describing what it compares."
				);
			}
			if (!participating.includes(lane)) {
				throw refusal(
					{
						label,
						reason: "unknownLane",
						values: snapshot(entries.get(label)),
						lane,
						rejected: value,
						detail: `the lane ${lane} is not part of this rendezvous, so ${JSON.stringify(label)} cannot be paired`,
					},
					"Submit consistency values only from the lanes the test was planned for."
				);
			}
			if (closed) {
				throw refusal(
					{
						label,
						reason: "lateSubmission",
						values: snapshot(entries.get(label)),
						lane,
						rejected: value,
						detail: `the lane ${lane} reported ${JSON.stringify(label)} after the rendezvous was finalized`,
					},
					"A lane must report its consistency values before its attempt ends."
				);
			}
			const entry = entryFor(label);
			if (entry.values.has(lane)) {
				throw refusal(
					{
						label,
						reason: "duplicateSubmission",
						values: snapshot(entry),
						lane,
						rejected: value,
						detail: `the lane ${lane} reported the label ${JSON.stringify(label)} more than once`,
					},
					"Labels are unique per lane: use a distinct label per comparison instead of reusing one."
				);
			}
			entry.values.set(lane, value);
			if (participating.every((candidate) => entry.values.has(candidate))) {
				const observed = [...entry.values.values()];
				const first = observed[0];
				if (!observed.every((item) => isDeepStrictEqual(item, first))) {
					issues.push(
						Object.freeze({
							label,
							reason: "valuesDiffer" as const,
							values: snapshot(entry),
							detail: `the lanes observed different values for ${JSON.stringify(label)}`,
						})
					);
				}
				release(entry);
				return;
			}
			await new Promise<void>((resolve) => {
				entry.waiters.push(resolve);
			});
		},
		finalize: async (timeoutMs) => {
			if (closed) {
				return Object.freeze({ crossChecked, issues: Object.freeze([...issues]) });
			}
			const pending = [...entries.values()].filter((entry) => !entry.settled);
			if (pending.length > 0) {
				await new Promise<void>((resolve) => {
					let remaining = pending.length;
					const timer = setTimeout(resolve, timeoutMs);
					for (const entry of pending) {
						entry.waiters.push(() => {
							remaining -= 1;
							if (remaining === 0) {
								clearTimeout(timer);
								resolve();
							}
						});
					}
				});
			}
			for (const [label, entry] of entries) {
				if (entry.settled) continue;
				// A lane that never reported is missing evidence, not agreement.
				issues.push(
					Object.freeze({
						label,
						reason: "incomplete" as const,
						values: snapshot(entry),
						detail:
							`${JSON.stringify(label)} was reported by ` +
							`${[...entry.values.keys()].join(", ") || "no lane"}, not by ` +
							`${participating.filter((lane) => !entry.values.has(lane)).join(", ")}`,
					})
				);
				// Releasing after the verdict keeps an abandoned page from hanging; the
				// issue above is already recorded, so this cannot read as agreement.
				release(entry);
			}
			// The rendezvous is over: anything reported from here on is late, and the
			// broker says so rather than accepting an unpairable observation.
			closed = true;
			return Object.freeze({ crossChecked, issues: Object.freeze([...issues]) });
		},
	});
}
