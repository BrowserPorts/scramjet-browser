/**
 * Structured, serializable errors.
 *
 * Every failure a consumer can act on carries a stable `code`, a human message,
 * and JSON-safe `details`. Errors cross the record log and the CLI boundary, so
 * they never rely on class identity or stack shape.
 */

/** Stable error codes. Add codes; never repurpose one. */
export const RUNWAY_ERROR_CODES = [
	"config/invalid-option",
	"config/conflicting-inputs",
	"config/missing-input",
	"config/unknown-flag",
	"browser/selection-invalid",
	"browser/launch-failed",
	"browser/cleanup-failed",
	"browser/not-selected-for-conformance",
	"fixtures/asset-unresolved",
	"fixtures/capability-unavailable",
	"fixtures/server-failed",
	"lane/init-failed",
	"lane/navigation-failed",
	"lane/verification-missing",
	"suite/duplicate-test-id",
	"suite/unsupported-case",
	"suite/discovery-failed",
	"plan/invalid",
	"plan/hash-mismatch",
	/**
	 * A page submitted a cross-lane consistency value the host refused.
	 *
	 * Contract, so the code means one thing wherever it is raised: the submission
	 * reached the host but could not be admitted as *this attempt's* value — it
	 * carried the wrong nonce or none, its label was not a string, the rendezvous
	 * was already sealed, or the same label was submitted twice. It is a failure of
	 * the attempt that submitted it and never of the opposite lane, and it is never
	 * used for a value the broker admitted and then found to disagree: disagreement
	 * is a result, not an invalid submission.
	 */
	"consistency/invalid-submission",
	"record/duplicate-terminal",
	"record/unknown-test",
	"record/unknown-lane",
	"record/foreign-run",
	"record/foreign-plan",
	"record/unplanned-pair",
	"record/event-sequence",
	"record/stale-terminal",
	"record/out-of-order",
	"record/malformed",
	"record/protocol-mismatch",
	"recorder/closed",
	"report/write-refused",
	"artifact/integrity",
	"schedule/deadline-exceeded",
	"schedule/cancelled",
	/**
	 * A scheduler hook the caller supplied broke its contract.
	 *
	 * Contract: the hook threw, or returned something thenable where a synchronous
	 * return was required. It is a defect in the *caller's* code, never the
	 * subject's, and never a user cancellation — so it is deliberately its own code
	 * rather than being folded into `schedule/cancelled`, which would let an
	 * infrastructure fault read as somebody pressing Ctrl-C. An item that hits this
	 * cannot be counted as having produced a result.
	 */
	"schedule/hook-failed",
	"compare/invalid-input",
	"internal/unexpected",
] as const;

export type RunwayErrorCode = (typeof RUNWAY_ERROR_CODES)[number];

export type SerializedRunwayError = {
	readonly name: "RunwayError";
	readonly code: RunwayErrorCode;
	readonly message: string;
	readonly details: Readonly<Record<string, unknown>>;
	readonly remedy?: string;
	readonly cause?: SerializedRunwayError | { readonly message: string };
};

export type RunwayErrorOptions = {
	/** JSON-safe context. Never put functions or class instances here. */
	readonly details?: Readonly<Record<string, unknown>>;
	/** One actionable sentence: the flag, file or command that fixes this. */
	readonly remedy?: string;
	readonly cause?: unknown;
};

export class RunwayError extends Error {
	readonly code: RunwayErrorCode;
	readonly details: Readonly<Record<string, unknown>>;
	readonly remedy?: string;

	constructor(
		code: RunwayErrorCode,
		message: string,
		options: RunwayErrorOptions = {}
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "RunwayError";
		this.code = code;
		this.details = Object.freeze({ ...(options.details ?? {}) });
		this.remedy = options.remedy;
	}

	toJSON(): SerializedRunwayError {
		const cause = this.cause;
		return {
			name: "RunwayError",
			code: this.code,
			message: this.message,
			details: this.details,
			...(this.remedy === undefined ? {} : { remedy: this.remedy }),
			...(cause === undefined
				? {}
				: {
						cause:
							cause instanceof RunwayError
								? cause.toJSON()
								: { message: cause instanceof Error ? cause.message : String(cause) },
					}),
		};
	}

	/** Single-line rendering for the CLI. */
	format(): string {
		return [
			`${this.code}: ${this.message}`,
			this.remedy ? `  → ${this.remedy}` : null,
		]
			.filter((line): line is string => line !== null)
			.join("\n");
	}
}

/** Wraps an unknown thrown value without inventing a code. */
export function toRunwayError(
	value: unknown,
	fallbackCode: RunwayErrorCode = "internal/unexpected"
): RunwayError {
	if (value instanceof RunwayError) return value;
	const message = value instanceof Error ? value.message : String(value);
	return new RunwayError(fallbackCode, message, {
		details: value instanceof Error && value.stack ? { stack: value.stack } : {},
		cause: value,
	});
}

/** JSON-safe serialization for any thrown value. */
export function serializeError(
	value: unknown
): SerializedRunwayError | { readonly message: string; readonly stack?: string } {
	if (value instanceof RunwayError) return value.toJSON();
	if (value instanceof Error) {
		return { message: value.message, ...(value.stack ? { stack: value.stack } : {}) };
	}
	return { message: String(value) };
}
