/**
 * Identity primitives.
 *
 * Every identifier is branded, so a lane id can never be passed where a test id
 * is expected. Ids are opaque strings with a validated shape: they travel through
 * the append-only record log and must stay stable across a re-run of a saved plan.
 */
import { randomUUID, createHash } from "node:crypto";

declare const brand: unique symbol;

type Branded<Kind extends string> = string & { readonly [brand]: Kind };

/** Identifies one execution of one plan. */
export type RunId = Branded<"RunId">;

/** Identifies an inventoried test, stable across runs. */
export type TestId = Branded<"TestId">;

/** Identifies a target lane, e.g. `bare` or `scramjet`. */
export type LaneId = Branded<"LaneId">;

/** Identifies a suite adapter. */
export type SuiteId = Branded<"SuiteId">;

/** Per test-and-lane secret echoed by in-page code to prove attribution. */
export type Nonce = Branded<"Nonce">;

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@/+-]{0,300}$/;

function assertShape(kind: string, value: string): void {
	if (!ID_PATTERN.test(value)) {
		throw new TypeError(
			`Invalid ${kind}: ${JSON.stringify(value)}. Ids must start with an ` +
				"alphanumeric character and may contain . _ : @ / + - only."
		);
	}
}

export function runId(value: string): RunId {
	assertShape("RunId", value);
	return value as RunId;
}

export function testId(value: string): TestId {
	assertShape("TestId", value);
	return value as TestId;
}

export function laneId(value: string): LaneId {
	assertShape("LaneId", value);
	return value as LaneId;
}

export function suiteId(value: string): SuiteId {
	assertShape("SuiteId", value);
	return value as SuiteId;
}

/** Builds a test id from a suite id and a suite-local name. */
export function composeTestId(suite: SuiteId, localName: string): TestId {
	const encoded = localName.replace(/[^a-zA-Z0-9._:@/+-]/g, "_");
	return testId(`${suite}:${encoded}`);
}

/** Fresh run id: sortable prefix plus random suffix. */
export function createRunId(now: Date = new Date()): RunId {
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	return runId(`run-${stamp}-${randomUUID().slice(0, 8)}`);
}

/** Fresh nonce for one test-and-lane attempt. */
export function createNonce(): Nonce {
	return randomUUID().replace(/-/g, "") as Nonce;
}

/** Stable key for a (test, lane) pair, used for duplicate rejection. */
export function terminalKey(test: TestId, lane: LaneId): string {
	return `${test}\u0000${lane}`;
}

/** Canonical JSON with sorted keys, so hashes are reproducible. */
export function canonicalJson(value: unknown): string {
	const walk = (input: unknown): unknown => {
		if (Array.isArray(input)) return input.map(walk);
		if (input && typeof input === "object") {
			const entries = Object.entries(input as Record<string, unknown>)
				.filter(([, item]) => item !== undefined)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
			return Object.fromEntries(entries.map(([key, item]) => [key, walk(item)]));
		}
		return input;
	};
	return JSON.stringify(walk(value));
}

/** SHA-256 of the canonical JSON encoding of `value`. */
export function contentHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
