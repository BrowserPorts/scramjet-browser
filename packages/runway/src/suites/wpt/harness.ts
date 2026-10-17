/**
 * Bridge between upstream's testharness completion protocol and Runway's records.
 *
 * Two halves, deliberately separated.
 *
 * {@link collectorInitScript} is host orchestration that runs in the page *before*
 * the test loads. It registers with upstream's real `add_result_callback` and
 * `add_completion_callback` and does nothing else. It does not define, wrap or
 * replace `test`, `promise_test`, `async_test`, `assert_*`, `setup`, `done` or any
 * other harness function; it does not modify a single byte of any fixture; and it
 * does not ship a testharness of its own. Upstream's own `testharness.js` — the
 * file the fixture includes, loaded from the fixture server — is what runs the
 * test. If that file is absent or broken, no result appears, which is correct: a
 * runner that can still produce results when the harness did not load is a runner
 * producing its own results.
 *
 * {@link convertHarnessCompletion} runs in Node and turns a *validated raw record*
 * into protocol subtests and an outcome. It is written to fail closed. Every
 * rejection below is a case where the alternative would be to record a pass that
 * nobody observed:
 *
 * - The two numeric status spaces are kept apart. `TestsStatus` (the whole file)
 *   is `OK/ERROR/TIMEOUT/PRECONDITION_FAILED` = `0/1/2/3`; `Test` (one subtest) is
 *   `PASS/FAIL/TIMEOUT/NOTRUN/PRECONDITION_FAILED` = `0/1/2/3/4`. They overlap
 *   numerically and mean different things — subtest `3` is NOTRUN, harness `3` is
 *   PRECONDITION_FAILED — so a converter that used one table for both would report
 *   a skipped subtest as a precondition failure and vice versa.
 * - An unknown numeric status is a diagnostic, never coerced to the nearest known
 *   one.
 * - A completion with no subtests and a harness status of OK is refused. Upstream
 *   cannot produce that: `Tests.prototype.all_done()` requires
 *   `this.tests.length > 0 || this.remotes.length > 0` before completion is
 *   reached at all, and a `single_test` file creates its one subtest up front in
 *   `set_file_is_test()`. A zero-subtest completion is therefore only legitimate
 *   when the harness itself failed — a setup exception or a timeout — and those
 *   arrive with a non-OK harness status.
 * - A setup failure produces no synthetic subtests. The record says the harness
 *   errored and lists whatever subtests really reported.
 * - A duplicate, late or out-of-order completion is refused rather than merged.
 *
 * Nothing here is a browser runner. The collector is an adapter: the parent's
 * owned run installs the script, owns the binding, and feeds what the binding
 * received to {@link readRawHarnessRecord}.
 */
import { RunwayError } from "../../core/errors.ts";
import type { SubtestRecord } from "../../core/protocol.ts";
import type { TerminalOutcome } from "../../core/outcome.ts";
import {
	arrayAt,
	booleanAt,
	integerAt,
	nullableTextAt,
	plainObject,
	stringAt,
	type SchemaFail,
} from "../../core/schema.ts";

/**
 * Harness-level status numbers, from upstream `TestsStatus.statuses`.
 *
 * `resources/testharness.js` at the checkout these were read from:
 * `{ OK: 0, ERROR: 1, TIMEOUT: 2, PRECONDITION_FAILED: 3 }`.
 */
export const HARNESS_STATUS = Object.freeze({
	OK: 0,
	ERROR: 1,
	TIMEOUT: 2,
	PRECONDITION_FAILED: 3,
});

/**
 * Subtest status numbers, from upstream `Test.statuses`.
 *
 * `{ PASS: 0, FAIL: 1, TIMEOUT: 2, NOTRUN: 3, PRECONDITION_FAILED: 4 }`. Note that
 * these are *not* the harness numbers above.
 */
export const SUBTEST_STATUS = Object.freeze({
	PASS: 0,
	FAIL: 1,
	TIMEOUT: 2,
	NOTRUN: 3,
	PRECONDITION_FAILED: 4,
});

const HARNESS_STATUS_NAMES: ReadonlyMap<number, string> = new Map(
	Object.entries(HARNESS_STATUS).map(([name, value]) => [value, name])
);

const SUBTEST_STATUS_NAMES: ReadonlyMap<number, string> = new Map(
	Object.entries(SUBTEST_STATUS).map(([name, value]) => [value, name])
);

/** Global the collector publishes its state on. Also the binding's payload key. */
export const COLLECTOR_GLOBAL = "__runwayWptHarness";

/** Binding the parent exposes so the page can hand the completion to the host. */
export const COLLECTOR_BINDING = "__runwayWptCompletion";

/**
 * Total in-page budget for one completion, before it is serialized.
 *
 * A *total*, never a per-field slice. Slicing individual fields silently corrupted
 * the record: two subtests sharing a long prefix collapsed to the same name, which
 * the converter then refused as a duplicate, and the attempt was reported as a
 * timeout instead of as the collection failure it was.
 *
 * So every field is kept whole. When the whole completion cannot fit, nothing is
 * truncated — the collector reports `collectionOverflow` and the record is refused
 * explicitly. Counted in UTF-16 code units, which is what the page can measure
 * cheaply; the host applies the exact UTF-8 byte bound on arrival.
 */
const MAX_COMPLETION_UNITS = 6 * 1024 * 1024;

/** One subtest, exactly as upstream reported it. Numbers are not translated. */
export type RawSubtest = {
	readonly name: string;
	readonly status: number;
	readonly message: string | null;
	readonly stack: string | null;
};

/** One completion, exactly as upstream reported it. */
export type RawHarnessRecord = {
	/** Document the harness completed in, as the page saw it. */
	readonly location: string;
	/** `TestsStatus.status`. Read against {@link HARNESS_STATUS}. */
	readonly harnessStatus: number;
	readonly harnessMessage: string | null;
	readonly harnessStack: string | null;
	readonly subtests: readonly RawSubtest[];
	/**
	 * Count of `add_result_callback` invocations the collector saw.
	 *
	 * Compared against `subtests.length` by the converter: upstream passes the same
	 * `Test` objects to both callbacks, so a disagreement means the page's view of
	 * the run and its final report are not the same thing.
	 */
	readonly resultCallbacks: number;
	/** True when a second completion arrived. Always fatal. */
	readonly duplicateCompletion: boolean;
	/** True when the collector could not register with the real harness. */
	readonly harnessUnavailable: boolean;
	/** Always false here: an overflow is {@link RawCollectionOverflow}, a separate shape. */
	readonly collectionOverflow: false;
	/** Text units the collector retained, for the diagnostic. */
	readonly retainedUnits: number;
	/** Subtests upstream reported, whether or not they were retained. Diagnostic. */
	readonly reportedSubtests: number;
};

/**
 * The collector could not retain the completion, so it sent this instead.
 *
 * Deliberately tiny and deliberately *not* a `RawHarnessRecord`: there is no
 * harness status to report and inventing one — or casting `null` through a field
 * typed as an integer — would put a fabricated upstream number into the record.
 * It carries no location either: the host attributed the frame before navigating,
 * so this is an operational failure report and never evidence about a document.
 */
export type RawCollectionOverflow = {
	readonly collectionOverflow: true;
	readonly retainedUnits: number;
	readonly reportedSubtests: number;
	readonly resultCallbacks: number;
	readonly duplicateCompletion: boolean;
	readonly harnessUnavailable: boolean;
};

/** What the binding can deliver: upstream's completion, or the collector giving up. */
export type RawCompletion = RawHarnessRecord | RawCollectionOverflow;

/**
 * The init script, as text.
 *
 * Installed with Playwright's `addInitScript`, so it runs before the document's
 * own scripts and therefore before upstream's `testharness.js` defines its
 * registrars. It registers the two callbacks upstream already provides —
 * `add_result_callback` and `add_completion_callback` — and does nothing else. It
 * defines no harness, wraps no test function, and reads nothing from the URL.
 *
 * Attribution is the host's, not the payload's: the binding call's `source.frame`
 * is compared against the frame the host designated before navigating. There is no
 * token in this script for a document to echo, because a same-realm token proves
 * nothing a frame comparison does not already prove.
 */
export function collectorInitScript(options: { readonly bindingName?: string } = {}): string {
	const binding = options.bindingName ?? COLLECTOR_BINDING;
	return `(() => {
  const BINDING = ${JSON.stringify(binding)};
  const GLOBAL = ${JSON.stringify(COLLECTOR_GLOBAL)};
  /** Bound so one pathological string cannot make the payload unbounded. */
  const MAX_UNITS = ${MAX_COMPLETION_UNITS};

  const state = {
    resultCallbacks: 0,
    completed: false,
    duplicateCompletion: false,
    harnessUnavailable: false,
    record: null,
  };
  Object.defineProperty(globalThis, GLOBAL, { value: state, configurable: false, writable: false });

  // Never truncates. Fields are reported exactly as upstream produced them.
  const text = (value) => (value == null ? null : typeof value === "string" ? value : String(value));

  /*
   * One authoritative completion, built under a running budget.
   *
   * Upstream calls the completion callback once per document with the full test
   * array, so that single call carries everything the record needs. A second
   * completion is recorded as a fault rather than sent again.
   *
   * The array is built incrementally and the budget is checked BEFORE each push, so
   * an oversized completion is never materialised and never serialized: the loop
   * stops at the first entry that would exceed the budget and a small overflow
   * envelope is sent instead. Every retained name/message/stack is whole — nothing
   * is sliced, so two subtests can never collapse onto the same name.
   */
  const deliver = (tests, harnessStatus) => {
    if (state.completed) {
      state.duplicateCompletion = true;
      return;
    }
    state.completed = true;

    const location_ = String(location.href);
    const harnessMessage = text(harnessStatus && harnessStatus.message);
    const harnessStack = text(harnessStatus && harnessStatus.stack);
    // Top-level fields are charged BEFORE the iteration, so the decision accounts
    // for the whole record rather than for the subtests alone.
    let units =
      location_.length + (harnessMessage ? harnessMessage.length : 0) + (harnessStack ? harnessStack.length : 0);

    /*
     * Fixed per-entry overhead.
     *
     * Charged even for an entry whose strings are empty, so a document reporting a
     * huge number of empty subtests is bounded by the same budget instead of
     * counting as nothing. Approximates the JSON skeleton of one entry.
     */
    const ENTRY_OVERHEAD = 64;

    const subtests = [];
    const list = tests || [];
    // Decided BEFORE the loop: a completion with no subtests but a huge harness
    // message or stack is already over budget, and the loop would never notice.
    let overflow = units > MAX_UNITS;
    for (let i = 0; overflow === false && i < list.length; i += 1) {
      const test = list[i];
      const name = text(test && test.name) ?? "";
      const message = text(test && test.message);
      const stack = text(test && test.stack);
      const cost =
        ENTRY_OVERHEAD + name.length + (message ? message.length : 0) + (stack ? stack.length : 0);
      if (units + cost > MAX_UNITS) {
        overflow = true;
        break;
      }
      units += cost;
      subtests.push({
        name,
        // Upstream's own number. Never re-derived, never defaulted: a subtest whose
        // status is not a number is reported as such and refused by the host.
        status: test && typeof test.status === "number" ? test.status : null,
        message,
        stack,
      });
    }

    const send = globalThis[BINDING];
    if (typeof send !== "function") {
      state.harnessUnavailable = true;
      return;
    }

    if (overflow) {
      // Small envelope only: the partial array is dropped rather than sent, so no
      // oversized structure is serialized and no short array can read as upstream's
      // whole result.
      state.collectionOverflow = true;
      try {
        // No location, no harness status, no subtests: the host already attributed
        // the frame, so this envelope is an operational failure report and carries
        // nothing that could be read as upstream's result or as route evidence. The
        // URL is deliberately omitted rather than bounded — it could itself be the
        // oversized field.
        send(
          JSON.stringify({
            collectionOverflow: true,
            retainedUnits: units,
            reportedSubtests: list.length,
            resultCallbacks: state.resultCallbacks,
            duplicateCompletion: state.duplicateCompletion,
            harnessUnavailable: state.harnessUnavailable === true,
          })
        );
      } catch (error) {
        state.deliveryError = String(error);
      }
      return;
    }

    const record = {
      location: location_,
      harnessStatus:
        harnessStatus && typeof harnessStatus.status === "number" ? harnessStatus.status : null,
      harnessMessage,
      harnessStack,
      subtests,
      collectionOverflow: false,
      retainedUnits: units,
      reportedSubtests: list.length,
      resultCallbacks: state.resultCallbacks,
      duplicateCompletion: state.duplicateCompletion,
      // Read from the state, not hard-coded: the two registrars are hooked
      // independently, so the completion hook can succeed while the per-result hook
      // failed. That is a partial view of the run and must be reported as one.
      harnessUnavailable: state.harnessUnavailable === true,
    };
    state.record = record;
    try {
      // A string, always: the host's payload bound applies to bytes it can measure
      // before parsing.
      send(JSON.stringify(record));
    } catch (error) {
      state.deliveryError = String(error);
    }
  };

  // Registration goes through upstream's own registrars. The property is
  // intercepted on its way in, upstream's value is installed unchanged, and our
  // listener is then registered alongside it. Nothing is replaced.
  //
  // Registration cannot happen inside the setter. upstream's testharness.js runs
  // \`expose(add_completion_callback, ...)\` while it is still evaluating, and the
  // module-scope \`tests\` object those registrars push into is constructed further
  // down the same file — so calling the registrar from the setter throws on an
  // undefined \`tests\`. The sync attempt is kept first anyway, in case upstream
  // ever reorders, and a microtask is the fallback.
  //
  // Declared limit, and the shape of it differs by environment. In a Window the
  // harness does not complete until its load gate has fired
  // (\`WindowTestEnvironment\` registers an on-load callback and \`all_done()\`
  // requires \`test_environment.all_loaded\`), so a body in the same script as
  // testharness.js is still fine there. In a shell-like global — upstream's
  // \`ShellTestEnvironment\`, used when there is no \`document\` — \`all_loaded\`
  // is set on the first microtask instead, so a body that runs synchronously in
  // that same script can complete before this registration. The consequence is no
  // completion at all: the attempt reaches its deadline and is recorded as a
  // timeout. It can never be recorded as a pass.
  const hook = (name, register) => {
    let installed;
    let done = false;
    const attempt = () => {
      if (done) return true;
      try {
        register(installed);
        done = true;
        state.registered = (state.registered || 0) + 1;
        return true;
      } catch (error) {
        state.registrationError = String(error);
        return false;
      }
    };
    // Restores the shape upstream's own \`expose()\` would have left behind.
    const restore = (value) => {
      try {
        Object.defineProperty(globalThis, name, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } catch (error) {
        state.restoreError = String(error);
      }
    };
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      get() {
        return installed;
      },
      set(value) {
        installed = value;
        if (typeof value !== "function") return;
        restore(value);
        if (attempt()) return;
        // Promise.resolve(), not queueMicrotask: the latter is not guaranteed to
        // exist in every global the harness runs in.
        Promise.resolve().then(() => {
          if (!attempt()) state.harnessUnavailable = true;
        });
      },
    });
  };

  hook("add_result_callback", (add) => {
    add(() => {
      state.resultCallbacks += 1;
    });
  });
  hook("add_completion_callback", (add) => {
    add((tests, harnessStatus) => {
      deliver(tests, harnessStatus);
    });
  });
})();`;
}

const malformed: SchemaFail = (message, details) => {
	throw new RunwayError("record/malformed", message, {
		details,
		remedy:
			"This payload came from the page's testharness collector. A payload that does not " +
			"have the shape upstream produces is never read as a result.",
	});
};

/** Validates the payload the binding received. Never coerces a status. */
/** Non-negative safe integer, or `0`. Used only for the overflow envelope's counters. */
function counter(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function readRawHarnessRecord(value: unknown): RawCompletion {
	const raw = plainObject(malformed, value, "the testharness completion");
	/*
	 * The overflow envelope is recognised BEFORE the normal schema.
	 *
	 * It has no `harnessStatus`, so running it through the record validator raised
	 * `record/malformed` and the executor discarded it as a malformed arrival — then
	 * kept waiting for a completion the page had already given up on, and reported a
	 * timeout. Checked here, it reaches the executor as what it is.
	 */
	if (raw.collectionOverflow === true) {
		return Object.freeze({
			collectionOverflow: true as const,
			retainedUnits: counter(raw.retainedUnits),
			reportedSubtests: counter(raw.reportedSubtests),
			resultCallbacks: counter(raw.resultCallbacks),
			duplicateCompletion: raw.duplicateCompletion === true,
			harnessUnavailable: raw.harnessUnavailable === true,
		});
	}
	const subtests = arrayAt(malformed, raw, "subtests", "the testharness completion").map(
		(item, index) => {
			const context = `the testharness completion subtests[${index}]`;
			const entry = plainObject(malformed, item, context);
			return Object.freeze({
				name: stringAt(malformed, entry, "name", context),
				status: integerAt(malformed, entry, "status", context, { min: 0 }),
				message: nullableTextAt(malformed, entry, "message", context),
				stack: nullableTextAt(malformed, entry, "stack", context),
			});
		}
	);
	return Object.freeze({
		location: stringAt(malformed, raw, "location", "the testharness completion"),
		harnessStatus: integerAt(malformed, raw, "harnessStatus", "the testharness completion", {
			min: 0,
		}),
		harnessMessage: nullableTextAt(
			malformed,
			raw,
			"harnessMessage",
			"the testharness completion"
		),
		harnessStack: nullableTextAt(malformed, raw, "harnessStack", "the testharness completion"),
		subtests: Object.freeze(subtests),
		resultCallbacks: integerAt(
			malformed,
			raw,
			"resultCallbacks",
			"the testharness completion",
			{ min: 0 }
		),
		duplicateCompletion: booleanAt(
			malformed,
			raw,
			"duplicateCompletion",
			"the testharness completion"
		),
		harnessUnavailable: booleanAt(
			malformed,
			raw,
			"harnessUnavailable",
			"the testharness completion"
		),
		collectionOverflow: false as const,
		retainedUnits:
			typeof raw.retainedUnits === "number" && Number.isSafeInteger(raw.retainedUnits)
				? raw.retainedUnits
				: 0,
		reportedSubtests:
			typeof raw.reportedSubtests === "number" && Number.isSafeInteger(raw.reportedSubtests)
				? raw.reportedSubtests
				: subtests.length,
	});
}

/** Parses the binding's JSON payload and validates it in one step. */
export function parseRawHarnessRecord(payload: string): RawCompletion {
	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch (cause) {
		throw new RunwayError(
			"record/malformed",
			`the testharness completion payload is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ details: { bytes: payload.length }, cause }
		);
	}
	return readRawHarnessRecord(value);
}

/**
 * Host-observed evidence that a completion came from the designated case frame.
 *
 * A payload field cannot carry this on its own. An init script runs in **every** frame,
 * and a Playwright binding is exposed to every frame in the context, so a helper
 * iframe a fixture creates — `with_iframe`, a `.sub.html` helper, a same-URL child —
 * runs the same collector and can complete first. The page's own `location` is no
 * better: it is a value the guest controls, a child frame can hold the identical
 * URL, and under a proxy lane the physical URL is not the logical one. Any
 * `isMainFrame`-style boolean the guest reports is likewise a guest claim.
 *
 * So attribution is a *host* obligation, and this type is how the host discharges
 * it. Every field must be filled in from what the host observed on the binding call
 * — Playwright's `source.frame` / `source.page` identity, compared against the frame
 * the host itself designated as the case frame — never from anything inside the
 * payload.
 *
 * Nothing in this module can synthesize this evidence, and it deliberately has no
 * default: a caller that has not wired real frame identity cannot accidentally get
 * a completion admitted.
 */
export type HarnessAdmissionEvidence = {
	/**
	 * The host designated a specific frame as the case frame before navigating.
	 *
	 * False means the host never established which frame should report, so no
	 * completion from this attempt can be attributed at all.
	 */
	readonly caseFrameDesignated: boolean;
	/**
	 * The binding call the host received originated in that designated frame.
	 *
	 * Host-side comparison of frame identity, not a URL or a guest-reported flag.
	 * A proxied lane may designate a guest frame rather than the main frame, which
	 * is why this is frame identity and not "is main frame".
	 */
	readonly bindingSourceIsCaseFrame: boolean;
	/**
	 * The host's verdict on whether the frame is at the expected case document.
	 *
	 * `match` and `mismatch` are conclusions the host's **route owner** reached by
	 * mapping the expected logical URL to the physical URL actually loaded. This
	 * module does not compare URLs: under a proxy lane the physical URL is rewritten,
	 * and a same-origin or basename comparison here would either reject every proxied
	 * case or accept an unrelated same-origin document. `unverified` means the host
	 * could not establish the mapping, which is not an admission.
	 */
	readonly locationVerdict: "match" | "mismatch" | "unverified";
	/** What the host observed, for the record. Diagnostic only, never compared here. */
	readonly observedLocation: string | null;
	/** Host's identifier for the designated case frame. Diagnostic only. */
	readonly caseFrameId: string | null;
};

export type HarnessConversionContext = {
	/**
	 * Host-observed frame attribution. Required, and the only attribution there is.
	 *
	 * See {@link HarnessAdmissionEvidence}: the binding call's `source.frame` was
	 * compared against the frame the host designated before navigating.
	 */
	readonly admission: HarnessAdmissionEvidence;
	/** True when the attempt was aborted. An arrival afterwards is refused. */
	readonly aborted?: boolean;
	/**
	 * Whether the runner's own deadline expired before a completion arrived.
	 *
	 * Distinct from the harness's timeout, which arrives *as* a completion with
	 * harness status `TIMEOUT` and real subtest statuses. A runner timeout means no
	 * completion arrived at all, and is passed to {@link runnerTimeoutOutcome}.
	 */
	readonly runnerDeadlineMs?: number;
};

export type HarnessConversion = {
	readonly outcome: TerminalOutcome;
	readonly subtests: readonly SubtestRecord[];
	readonly summary: string;
	/**
	 * Raw harness status, kept so a report can quote the number upstream produced.
	 *
	 * `null` only when there was no completion to read one from — see
	 * {@link runnerTimeoutOutcome}. It is never a sentinel number, because a
	 * sentinel would be indistinguishable from a status upstream might add.
	 */
	readonly harnessStatus: number | null;
	readonly harnessStatusName: string;
	/** Diagnostics that did not change the outcome but must not be lost. */
	readonly diagnostics: readonly string[];
};

function conversionFailure(
	message: string,
	details: Readonly<Record<string, unknown>>
): RunwayError {
	return new RunwayError("record/malformed", message, {
		details,
		remedy:
			"A testharness completion that cannot be interpreted is recorded as an invalid " +
			"record, never as a pass.",
	});
}

/**
 * Maps one subtest's upstream number onto the protocol's vocabulary.
 *
 * Total on the known numbers and refusing on the rest. `preconditionFailed` is a
 * real upstream status (`OptionalFeatureUnsupportedError`) and is preserved as
 * itself rather than folded into a pass or a skip.
 */
function subtestStatusOf(
	status: number
): SubtestRecord["status"] | null {
	switch (status) {
		case SUBTEST_STATUS.PASS:
			return "pass";
		case SUBTEST_STATUS.FAIL:
			return "fail";
		case SUBTEST_STATUS.TIMEOUT:
			return "timeout";
		case SUBTEST_STATUS.NOTRUN:
			return "notRun";
		case SUBTEST_STATUS.PRECONDITION_FAILED:
			return "preconditionFailed";
		default:
			return null;
	}
}

/**
 * Converts a validated raw completion into a terminal outcome and subtests.
 *
 * Throws {@link RunwayError} `record/malformed` when the completion cannot be
 * interpreted at all — the caller records `invalidRecord`. It never returns a
 * `pass` it did not read out of the upstream numbers.
 */
export function convertHarnessCompletion(
	raw: RawHarnessRecord,
	context: HarnessConversionContext
): HarnessConversion {
	// Frame attribution is checked before anything in the payload is interpreted: a
	// well-formed completion from the wrong frame is exactly the case no payload
	// field can distinguish.
	const admission = context.admission;
	if (!admission.caseFrameDesignated) {
		throw conversionFailure(
			"the host designated no case frame for this attempt, so no completion can be attributed",
			{ location: raw.location, observedLocation: admission.observedLocation }
		);
	}
	if (!admission.bindingSourceIsCaseFrame) {
		throw conversionFailure(
			"the host observed this completion arriving from a " +
				"frame other than the designated case frame",
			{
				location: raw.location,
				observedLocation: admission.observedLocation,
				caseFrameId: admission.caseFrameId,
				note:
					"the init script and the binding reach every frame, so a helper iframe sees the " +
					"same collector; frame identity is what separates them",
			}
		);
	}
	if (admission.locationVerdict !== "match") {
		throw conversionFailure(
			admission.locationVerdict === "mismatch"
				? "the host's route owner reports the case frame is not at the expected case document"
				: "the host could not verify the case frame is at the expected case document",
			{
				location: raw.location,
				observedLocation: admission.observedLocation,
				locationVerdict: admission.locationVerdict,
				caseFrameId: admission.caseFrameId,
			}
		);
	}
	if (context.aborted === true) {
		throw conversionFailure("the testharness completion arrived after this attempt was aborted", {
			location: raw.location,
		});
	}
	if (raw.duplicateCompletion) {
		throw conversionFailure(
			"the page reported more than one testharness completion for one attempt",
			{ location: raw.location }
		);
	}
	if (raw.harnessUnavailable) {
		throw conversionFailure(
			"the collector could not register with upstream's testharness in this document",
			{ location: raw.location }
		);
	}

	const harnessStatusName = HARNESS_STATUS_NAMES.get(raw.harnessStatus) ?? null;
	if (harnessStatusName === null) {
		throw conversionFailure(
			`the testharness reported the harness status ${raw.harnessStatus}, which this build ` +
				`does not know (known: ${[...HARNESS_STATUS_NAMES.entries()]
					.map(([value, name]) => `${name}=${value}`)
					.join(", ")})`,
			{ harnessStatus: raw.harnessStatus, location: raw.location }
		);
	}

	const diagnostics: string[] = [];
	const subtests: SubtestRecord[] = [];
	let unknownSubtestStatus = 0;
	let failing = 0;

	for (const [index, subtest] of raw.subtests.entries()) {
		const status = subtestStatusOf(subtest.status);
		if (status === null) {
			unknownSubtestStatus += 1;
			diagnostics.push(
				`subtests[${index}] (${JSON.stringify(subtest.name)}) reported the status ` +
					`${subtest.status}, which is not one of ${[...SUBTEST_STATUS_NAMES.entries()]
						.map(([value, name]) => `${name}=${value}`)
						.join(", ")}`
			);
			continue;
		}
		if (status !== "pass") failing += 1;
		subtests.push(
			Object.freeze({
				name: subtest.name,
				status,
				message: subtest.message,
				// The number upstream produced, kept beside the mapped status so the
				// mapping can always be checked against the source.
				upstreamStatus: subtest.status,
			})
		);
	}

	if (unknownSubtestStatus > 0) {
		throw conversionFailure(
			`${unknownSubtestStatus} subtest(s) reported a status this build does not know`,
			{ location: raw.location, diagnostics }
		);
	}

	/*
	 * Result-callback accounting, required only where upstream actually guarantees it.
	 *
	 * On the OK path every subtest has had `Test.done()` called — either by the test
	 * itself or by `Tests.complete()`, which walks the incomplete ones and calls
	 * `done()` on each — and `done()` leads to `Tests.result()` → `notify_result()`,
	 * which fires `add_result_callback`. So under OK the two counts agree exactly,
	 * and a disagreement means the page's per-result view and its final report are
	 * describing different runs.
	 *
	 * On the TIMEOUT and ERROR paths upstream deliberately does *not* fire those
	 * callbacks. `Tests.prototype.timeout()` assigns `test.phase = COMPLETE` to every
	 * test directly, and `Tests.prototype.abort()` does the same for every test still
	 * in the INITIAL phase; `Test.prototype.done()` then early-returns on
	 * `phase >= CLEANING`, so no result callback is ever dispatched for them. A
	 * legitimate timed-out or aborted completion therefore reports *fewer* callbacks
	 * than subtests. Requiring equality there would refuse upstream's own output and
	 * turn a real harness timeout into an invalid record.
	 *
	 * So: equality is required under OK, and under the other statuses the difference
	 * is kept as a diagnostic. The raw subtests are retained in full either way,
	 * including the NOTRUN ones, which are the whole point of a timeout report.
	 */
	if (raw.harnessStatus === HARNESS_STATUS.OK) {
		if (raw.resultCallbacks !== raw.subtests.length) {
			throw conversionFailure(
				`the page reported ${raw.resultCallbacks} subtest result callback(s) but an OK ` +
					`completion listing ${raw.subtests.length} subtest(s); under OK upstream fires one ` +
					"result callback per subtest",
				{
					resultCallbacks: raw.resultCallbacks,
					completionSubtests: raw.subtests.length,
					location: raw.location,
				}
			);
		}
	} else if (raw.resultCallbacks !== raw.subtests.length) {
		diagnostics.push(
			`${raw.resultCallbacks} result callback(s) for ${raw.subtests.length} subtest(s): ` +
				`upstream does not dispatch a result callback for subtests it completes directly on ` +
				`the ${harnessStatusName} path`
		);
	}

	const names = new Set<string>();
	for (const subtest of subtests) {
		if (names.has(subtest.name)) {
			// Upstream reports duplicate subtest names as a harness ERROR, so seeing
			// them alongside an OK status means the report is not upstream's.
			diagnostics.push(`the subtest name ${JSON.stringify(subtest.name)} appears more than once`);
		}
		names.add(subtest.name);
	}

	if (raw.harnessStatus === HARNESS_STATUS.OK) {
		if (subtests.length === 0) {
			// See the module comment: upstream cannot reach a completion with zero
			// subtests and zero remotes, so an OK completion with none is not a pass
			// with nothing to check — it is a report upstream did not produce.
			throw conversionFailure(
				"the testharness reported OK with no subtests. Upstream's Tests.all_done() requires " +
					"at least one test or remote before completion is reached, so an OK completion " +
					"with no subtests is not an upstream observation",
				{ location: raw.location }
			);
		}
		if (names.size !== subtests.length) {
			throw conversionFailure(
				"the testharness reported OK but listed a duplicate subtest name, which upstream " +
					"reports as a harness ERROR",
				{ location: raw.location, diagnostics }
			);
		}
		/*
		 * Map the subtest statuses onto the *aggregate* outcome for this case.
		 *
		 * The distinction that governs this whole block: a **per-subtest** status is
		 * upstream's verdict on one subtest, and it is preserved verbatim on the
		 * subtest record (mapped name plus the raw `upstreamStatus` number). The
		 * **aggregate** outcome is Runway's verdict on the *file*, and it answers a
		 * different question — did this case execute, and did it pass?
		 *
		 * The file executed. upstream loaded it, ran its harness to an OK completion
		 * and reported subtests. So the aggregate outcome has to be one the taxonomy
		 * treats as executed and non-passing, because the downstream contracts in
		 * `core/outcome.ts` are what decide whether this counts:
		 *
		 *   isExecuted()       -> only `pass` and `assertionFailure`
		 *   isFailureForExit() -> everything except `pass` and `notRun`
		 *
		 * Mapping an aggregate NOTRUN to `notRun` therefore did two silent damages:
		 * `isFailureForExit("notRun") === false` made the run exit 0, and
		 * `isExecuted("notRun") === false` made `qualifyRecord` skip its `nonceEcho`
		 * and `hostOwned` requirements — a qualification bypass on a case that really
		 * did execute. `unsupported` is not as bad (it does fail the exit code) but it
		 * still reports `isExecuted === false`, and it means "this runner implements
		 * no execution for this form", which is untrue of a file that just ran.
		 *
		 * Both of those are reserved for *inventory* states — cases that were never
		 * executed at all — and this is not one. So every executed non-pass aggregates
		 * to `assertionFailure`:
		 *
		 *   any FAIL                -> assertionFailure
		 *   else any TIMEOUT        -> timeout   (harness-level semantics, kept)
		 *   else any NOTRUN         -> assertionFailure, reason recorded
		 *   else any PRECONDITION_* -> assertionFailure, reason recorded
		 *   else                    -> pass
		 *
		 * `assertionFailure` here is the *aggregate* statement "this file executed and
		 * did not pass". It is deliberately NOT a claim that an upstream assertion
		 * fired: the diagnostics below say exactly which upstream status produced it,
		 * and the per-subtest records keep upstream's own enum. A PRECONDITION_FAILED
		 * subtest is an executed case whose prerequisite was unsatisfied — which is a
		 * different fact from the runner not supporting the form, and is recorded as
		 * such rather than as `unsupported`.
		 */
		const tally = { fail: 0, timeout: 0, notRun: 0, preconditionFailed: 0 };
		for (const subtest of subtests) {
			if (subtest.status === "pass") continue;
			tally[subtest.status] += 1;
		}
		for (const subtest of subtests) {
			if (subtest.status === "pass") continue;
			diagnostics.push(
				`subtest ${JSON.stringify(subtest.name)} reported ${subtest.status} ` +
					`(upstream status ${subtest.upstreamStatus})`
			);
		}
		if (tally.notRun > 0) {
			diagnostics.push(
				`aggregate: ${tally.notRun} upstream subtest NOTRUN in an executed file; recorded as ` +
					"an executed non-pass, not as an inventory notRun (the file did execute)"
			);
		}
		if (tally.preconditionFailed > 0) {
			diagnostics.push(
				`aggregate: ${tally.preconditionFailed} upstream subtest PRECONDITION_FAILED in an ` +
					"executed file — a prerequisite the browser did not satisfy, which is not the " +
					"runner declining to support this form"
			);
		}
		const okOutcome: TerminalOutcome =
			tally.fail > 0
				? "assertionFailure"
				: tally.timeout > 0
					? "timeout"
					: tally.notRun > 0 || tally.preconditionFailed > 0
						? "assertionFailure"
						: "pass";
		const breakdown = Object.entries(tally)
			.filter(([, count]) => count > 0)
			.map(([name, count]) => `${count} ${name}`)
			.join(", ");
		return Object.freeze({
			outcome: okOutcome,
			subtests: Object.freeze(subtests),
			summary:
				failing === 0
					? `testharness OK: ${subtests.length} subtest(s) passed`
					: `testharness OK: ${failing} of ${subtests.length} subtest(s) did not pass (${breakdown})`,
			harnessStatus: raw.harnessStatus,
			harnessStatusName,
			diagnostics: Object.freeze(diagnostics),
		});
	}

	// Non-OK harness statuses describe the *file*, not an assertion. They are never
	// reported as assertion failures, and no subtest is invented to stand in for
	// them: whatever really reported is kept, and the rest of the story is the
	// harness status and its message.
	const outcome: TerminalOutcome =
		raw.harnessStatus === HARNESS_STATUS.TIMEOUT ? "timeout" : "setupError";
	const detail = raw.harnessMessage === null ? "" : `: ${raw.harnessMessage}`;
	return Object.freeze({
		outcome,
		subtests: Object.freeze(subtests),
		summary:
			`testharness ${harnessStatusName}${detail} ` +
			`(${subtests.length} subtest(s) reported before the harness ended)`,
		harnessStatus: raw.harnessStatus,
		harnessStatusName,
		diagnostics: Object.freeze(diagnostics),
	});
}

/**
 * The outcome when the *runner's* deadline expired with no completion at all.
 *
 * Separate from a harness TIMEOUT on purpose. A harness timeout is an upstream
 * observation, delivered as a completion, with each subtest carrying the status
 * upstream gave it. A runner timeout is the absence of any observation: no
 * subtests are reported, because none were received, and inventing `notRun`
 * entries for the subtests a file is *expected* to have would be fabricating
 * results for a setup that never executed.
 */
export function runnerTimeoutOutcome(options: {
	readonly deadlineMs: number;
	readonly harnessTimeoutMs: number | null;
	readonly location: string | null;
}): HarnessConversion {
	const comparison =
		options.harnessTimeoutMs === null
			? "the upstream harness timeout for this case is unknown"
			: options.deadlineMs > options.harnessTimeoutMs
				? `the upstream harness timeout is ${options.harnessTimeoutMs}ms, so the harness had ` +
					"room to report its own TIMEOUT and did not"
				: `the runner deadline is not longer than the upstream harness timeout of ` +
					`${options.harnessTimeoutMs}ms, so the runner may have cut the harness off before ` +
					"it could report";
	return Object.freeze({
		outcome: "timeout" as const,
		subtests: Object.freeze([]),
		summary:
			`no testharness completion arrived within the runner deadline of ${options.deadlineMs}ms; ` +
			`${comparison}`,
		harnessStatus: null,
		harnessStatusName: "none",
		diagnostics: Object.freeze(
			options.location === null ? [] : [`last known document: ${options.location}`]
		),
	});
}
