/**
 * Expectations: a comparison input, never part of raw evidence.
 *
 * An expectation must name the lanes and the outcomes it covers. There is no
 * "all lanes / any failure" default: that hid reference-lane and infrastructure
 * failures. Only assertion failures may be expected; timeouts, crashes, missing
 * records, invalid records, cancellation and setup failures always fail the run.
 *
 * Qualification misses still fail the exit code even when the raw outcome is
 * expected.
 */
import { readFile } from "node:fs/promises";
import { RunwayError } from "./errors.ts";
import {
	EMPTY_EXPECTATIONS,
	EXPECTABLE_OUTCOMES,
	type ExpectableOutcome,
	type ExpectationEntry,
	type Expectations,
} from "./compare.ts";
import { laneId } from "./ids.ts";

export type LoadedExpectations = {
	readonly expectations: Expectations;
	readonly source: string | null;
};

export const NO_EXPECTATIONS: LoadedExpectations = Object.freeze({
	expectations: EMPTY_EXPECTATIONS,
	source: null,
});

function invalid(file: string, message: string, details: Record<string, unknown> = {}): never {
	throw new RunwayError("compare/invalid-input", `${file}: ${message}`, {
		details,
		remedy:
			'An expectations file looks like { "version": 1, "expectedFailures": ' +
			'{ "native:<test name>": { "lanes": ["scramjet"], "outcomes": ["assertionFailure"], "reason": "…" } } }.',
	});
}

function parseEntry(file: string, testId: string, raw: unknown): ExpectationEntry {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		invalid(file, `the expectation for ${testId} must be an object`, { testId });
	}
	const entry = raw as Record<string, unknown>;
	if (!Array.isArray(entry.lanes) || entry.lanes.length === 0) {
		invalid(file, `the expectation for ${testId} must name at least one lane`, { testId });
	}
	if (entry.lanes.some((lane) => typeof lane !== "string" || lane.length === 0)) {
		invalid(file, `the expectation for ${testId} has an invalid lanes list`, { testId });
	}
	if (!Array.isArray(entry.outcomes) || entry.outcomes.length === 0) {
		invalid(file, `the expectation for ${testId} must name at least one outcome`, { testId });
	}
	const expectable: ReadonlySet<string> = new Set(EXPECTABLE_OUTCOMES);
	for (const outcome of entry.outcomes) {
		if (!expectable.has(String(outcome))) {
			invalid(
				file,
				`the expectation for ${testId} names ${JSON.stringify(outcome)}, which cannot be expected away`,
				{ testId, outcome, expectable: EXPECTABLE_OUTCOMES }
			);
		}
	}
	if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
		invalid(file, `the expectation for ${testId} needs a non-empty reason`, { testId });
	}
	return {
		lanes: Object.freeze(entry.lanes.map((lane) => laneId(String(lane)))),
		outcomes: Object.freeze(entry.outcomes as ExpectableOutcome[]),
		reason: entry.reason,
	};
}

export async function loadExpectations(file: string): Promise<LoadedExpectations> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8"));
	} catch (cause) {
		throw new RunwayError(
			"compare/invalid-input",
			`the expectations file ${file} could not be read as JSON`,
			{ cause }
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		invalid(file, "the file must contain a JSON object");
	}
	const document = parsed as Record<string, unknown>;

	if (document.version === undefined && Array.isArray(document.tests)) {
		throw new RunwayError(
			"compare/invalid-input",
			`${file} is a pre-v2 expectations list; this build does not read it`,
			{
				details: { entries: document.tests.length },
				remedy:
					'Write a v2 file with required lanes and outcomes: { "version": 1, "expectedFailures": ' +
					'{ "native:<name>": { "lanes": ["scramjet"], "outcomes": ["assertionFailure"], "reason": "…" } } }.',
			}
		);
	}
	if (document.version !== 1) {
		invalid(file, `unsupported expectations version ${String(document.version)}`, {
			version: document.version,
		});
	}
	const rawFailures = document.expectedFailures;
	if (
		rawFailures !== undefined &&
		(!rawFailures || typeof rawFailures !== "object" || Array.isArray(rawFailures))
	) {
		invalid(file, "expectedFailures must be an object keyed by test id");
	}
	const expectedFailures: Record<string, ExpectationEntry> = {};
	for (const [testId, raw] of Object.entries((rawFailures ?? {}) as Record<string, unknown>)) {
		expectedFailures[testId] = parseEntry(file, testId, raw);
	}
	return Object.freeze({
		expectations: Object.freeze({ version: 1 as const, expectedFailures }),
		source: file,
	});
}
