/**
 * Reader for the upstream-derived WPT inventory manifest.
 *
 * The manifest is produced by `scripts/generate-wpt.py`, which
 * enumerates cases with WPT's own `tools/manifest` parser. This module therefore
 * contains no test parser, no URL heuristics and no basename rules: every fact
 * about a case — its item type, its generated URL, its variant, whether it is
 * `https`, whether it wants a subdomain, whether it wants testdriver — is read
 * from the manifest field the upstream parser filled in.
 *
 * What it does add is refusal. A manifest is untrusted input: it may have been
 * produced by an older generator, hand-edited, or truncated. Nothing here is
 * coerced, so a field that does not have the shape the producer contract declares
 * is an error rather than a case that quietly runs as something else.
 *
 * Forward compatibility is deliberate and one-directional. The producer contract
 * (`scripts/WPT_INVENTORY.md`, "Manifest schema") says fields are *added* and
 * existing ones keep their meaning, so an unrecognized key is recorded — see
 * {@link WptManifest.unrecognizedFields} — and never silently dropped nor treated
 * as a fatal error. An unrecognized *value* in a field this module interprets is
 * fatal, because interpreting it would be a guess.
 */
import { RunwayError } from "../../core/errors.ts";
import { suiteId, type SuiteId } from "../../core/ids.ts";
import {
	arrayAt,
	booleanAt,
	integerAt,
	isPlainObject,
	nullableStringAt,
	objectAt,
	optionalArrayAt,
	optionalStringAt,
	plainObject,
	stringAt,
	type SchemaFail,
} from "../../core/schema.ts";

/**
 * Producer schema version this reader understands.
 *
 * Recorded by `provenance.schemaVersion`. A manifest without it predates the
 * additive fields (`tests[].source`, `tests[].https`, `tests[].subdomain`,
 * `provenance.identity`, …) that this reader needs in order to avoid inferring
 * anything from a URL, so such a manifest is refused rather than read partially.
 */
export const WPT_MANIFEST_SCHEMA_VERSION = 2 as const;

/**
 * Upstream harness timeouts, read from the official `resources/testharness.js`.
 *
 * `settings.harness_timeout = { normal: 10000, long: 60000 }`. These are the
 * timeouts the *page's own* harness applies: when one expires, upstream produces a
 * real completion whose harness status is `TIMEOUT` and whose subtests carry their
 * own statuses. A runner deadline shorter than this would cut the page off before
 * that happened and turn an upstream-observable TIMEOUT into a runner-side
 * fabrication, so these values exist here to be *exceeded*, never to be guessed.
 *
 * They are duplicated from upstream rather than parsed out of it, so any run that
 * relies on them must also record the harness file's hash — see
 * {@link WptServerHandle} in `server.ts`, which reads the served bytes back.
 */
export const UPSTREAM_HARNESS_TIMEOUT_MS = Object.freeze({
	normal: 10_000,
	long: 60_000,
});

/** Timeout classes upstream's manifest can declare. `null` means "not declared". */
export type WptTimeoutClass = "normal" | "long";

export type WptManifestTest = {
	/** Generated test URL, exactly as upstream produced it. Path, query, fragment. */
	readonly url: string;
	/** Upstream `timeout` extra: `"long"` or absent. Kept verbatim. */
	readonly timeout: string | null;
	/**
	 * Upstream `testdriver` extra.
	 *
	 * Tri-state on purpose. Upstream's `to_json` writes this key only when truthy,
	 * and for *generated* items (`.any.js`, `.window.js`, `.worker.js`) it is never
	 * passed at all — see `tools/manifest/sourcefile.py`, which passes
	 * `testdriver=self.has_testdriver` only for `crashtest` and `print-reftest`.
	 * So `null` means "upstream recorded no flag here", which for a generated item
	 * is not evidence that the test avoids testdriver: that evidence is in
	 * {@link testdriverFeatures} and {@link scriptMetadata}. Collapsing `null` to
	 * `false` is exactly how a testdriver test gets planned as a plain one.
	 */
	readonly testdriver: boolean | null;
	/** Upstream source file this URL was generated from. Never inferred from the URL. */
	readonly source: string;
	readonly https: boolean;
	readonly subdomain: boolean;
	/**
	 * Upstream's `h2` flag: this case must be served over HTTP/2.
	 *
	 * A sibling of `https`/`subdomain` on upstream's `URLManifestItem`, all three
	 * derived from the same `_flags` set (`tools/manifest/item.py`): `h2` is true
	 * when the filename carries a `.h2.` segment or the URL carries `wpt_flags=h2`.
	 *
	 * `null` means the manifest's producer did not record this flag at all — see
	 * {@link WptManifestProvenance.recordedTestFlags}. It does **not** mean false:
	 * an h2 case read from a manifest that never recorded the flag would otherwise
	 * be planned as a plain-HTTP case and served by the wrong listener.
	 */
	readonly h2: boolean | null;
	readonly testdriverFeatures?: readonly string[];
	/** `META:` pairs, as upstream recorded them: `[key, value]` in file order. */
	readonly scriptMetadata?: readonly (readonly [string, string])[];
	readonly pac?: string;
	readonly jsshell?: boolean;
};

export type WptOtherCaseItem = {
	readonly type: string;
	readonly url?: string;
	readonly timeout?: string;
	/** Reftest references, as upstream recorded them: `[url, condition]`. */
	readonly references?: readonly (readonly [string, string])[];
};

export type WptOtherCase = {
	readonly path: string;
	readonly type: string;
	readonly items: readonly WptOtherCaseItem[];
	readonly itemCount: number;
	readonly runnerSupportedType: boolean;
	readonly variants?: readonly string[];
};

export type WptManifestIdentity = {
	readonly wptSourceRevision: string;
	readonly wptSourceAggregateHash: string | null;
	readonly wptSourceAggregateHashComplete: boolean;
};

export type WptManifestProvenance = {
	readonly schemaVersion: number;
	readonly identity: WptManifestIdentity;
	/** `false` in every manifest: the generator observes no execution. */
	readonly executionRecorded: boolean;
	/** Item types the *producer* declares a runner has a defined way to drive. */
	readonly supportedTypeNames: readonly string[];
	/** Count of selected files the generator inventoried but could not parse. */
	readonly unparsableSourceFileCount: number;
	readonly supportFiles: number;
	/**
	 * Per-test flags the producer states it recorded.
	 *
	 * The gate for every optional boolean this reader consumes. A flag that is not
	 * listed here was not recorded, so its absence from a test entry carries no
	 * information and must never be read as `false`.
	 */
	readonly recordedTestFlags: readonly string[];
	/** Whole-repository and selected-path dirtiness, recorded separately upstream. */
	readonly repositoryDirty: boolean;
	readonly selectedPathsDirty: boolean;
	readonly revisionIdentifiesSelectedSources: boolean;
	/**
	 * URLs upstream produced more than once, mapped to the source files that
	 * produced them.
	 *
	 * The generator's own shape (`generate-wpt.py`): the first entry
	 * is the source that *was* kept, and every entry after it is a source whose case
	 * was dropped. So a URL listed with three sources cost two dropped cases, not
	 * one — counting distinct URLs instead of summing would silently under-count the
	 * denominator exactly when a URL collided more than twice.
	 */
	readonly duplicateTestUrls: ReadonlyMap<string, readonly string[]>;
	/** Cases dropped because their URL collided: `sum(sources.length - 1)`. */
	readonly droppedDuplicateCount: number;
	readonly allSelectedFilesParsed: boolean;
};

export type WptManifest = {
	readonly revision: string;
	/** Selection label the generator was given (`--suite`). */
	readonly suite: string;
	readonly paths: readonly string[];
	readonly tests: readonly WptManifestTest[];
	readonly otherCases: readonly WptOtherCase[];
	/** Per-item-type counts, as upstream's parser produced them. */
	readonly counts: Readonly<Record<string, number>>;
	readonly provenance: WptManifestProvenance;
	/**
	 * Keys present in the manifest that this reader does not interpret.
	 *
	 * Additive fields are part of the producer contract, so their presence is
	 * recorded rather than refused; recording them is what makes a producer that
	 * has moved ahead of this reader visible instead of invisible.
	 */
	readonly unrecognizedFields: readonly string[];
	/**
	 * Why this manifest does not describe its whole selection, if it does not.
	 *
	 * Non-empty when the producer recorded unparsable sources or withheld its
	 * "everything parsed" claim. A manifest in that state is a *short* denominator:
	 * accepting it silently is exactly the accounting failure the inventory exists
	 * to prevent, so {@link readWptManifest} refuses it unless the caller opts into
	 * diagnostic mode, and every entry built from it is unqualified.
	 */
	readonly incompleteness: readonly string[];
};

export type ReadManifestOptions = {
	/**
	 * Accept a manifest that does not describe its whole selection.
	 *
	 * Off by default. Turning it on does not make the manifest complete: the reasons
	 * stay in {@link WptManifest.incompleteness} and travel into the inventory
	 * summary, so anything built from it is explicitly unqualified.
	 */
	readonly allowIncomplete?: boolean;
};

function manifestFail(context: string): SchemaFail {
	return (message, details) => {
		throw new RunwayError("suite/discovery-failed", message, {
			details: { manifest: context, ...details },
			remedy:
				"Regenerate the manifest with scripts/generate-wpt.py against the " +
				"upstream checkout you intend to run. A manifest is never hand-edited.",
		});
	};
}

const TEST_KEYS: readonly string[] = [
	"url",
	"timeout",
	"testdriver",
	"source",
	"https",
	"subdomain",
	"h2",
	"testdriverFeatures",
	"scriptMetadata",
	"pac",
	"jsshell",
];

const OTHER_CASE_KEYS: readonly string[] = [
	"path",
	"type",
	"items",
	"itemCount",
	"runnerSupportedType",
	"variants",
];

const MANIFEST_KEYS: readonly string[] = [
	"revision",
	"suite",
	"paths",
	"tests",
	"otherCases",
	"counts",
	"sources",
	"provenance",
];

/** Collects keys the reader does not interpret, prefixed for provenance. */
function unrecognized(
	value: Record<string, unknown>,
	known: readonly string[],
	prefix: string
): string[] {
	return Object.keys(value)
		.filter((key) => !known.includes(key))
		.map((key) => `${prefix}${key}`);
}

const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** A `[key, value]` pair array, as upstream serializes `script_metadata`. */
function stringPairsAt(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string
): readonly (readonly [string, string])[] | undefined {
	const raw = optionalArrayAt(fail, source, key, context);
	if (raw === undefined) return undefined;
	return Object.freeze(
		raw.map((item, index) => {
			const pairContext = `${context}.${key}[${index}]`;
			if (!Array.isArray(item) || item.length !== 2) {
				fail(`${pairContext} must be a two-element [key, value] array`, {
					length: Array.isArray(item) ? item.length : null,
				});
			}
			const [first, second] = item as readonly unknown[];
			if (typeof first !== "string" || typeof second !== "string") {
				fail(`${pairContext} must be a pair of strings`, {
					kinds: [typeof first, typeof second],
				});
			}
			return Object.freeze([first, second]) as readonly [string, string];
		})
	);
}

function readTest(
	fail: SchemaFail,
	value: unknown,
	index: number,
	unknownKeys: Set<string>,
	recordedFlags: ReadonlySet<string>
): WptManifestTest {
	const context = `tests[${index}]`;
	const entry = plainObject(fail, value, context);
	for (const key of unrecognized(entry, TEST_KEYS, "tests[].")) unknownKeys.add(key);
	const url = stringAt(fail, entry, "url", context);
	assertUpstreamUrl(fail, url, context);
	const testdriver =
		entry.testdriver === null || entry.testdriver === undefined
			? null
			: booleanAt(fail, entry, "testdriver", context);
	const features = optionalArrayAt(fail, entry, "testdriverFeatures", context);
	if (features !== undefined) {
		for (const [position, item] of features.entries()) {
			if (typeof item !== "string") {
				fail(`${context}.testdriverFeatures[${position}] must be a string`, {
					kind: typeof item,
				});
			}
		}
	}
	const scriptMetadata = stringPairsAt(fail, entry, "scriptMetadata", context);
	const pac = optionalStringAt(fail, entry, "pac", context);
	const jsshell =
		entry.jsshell === undefined ? undefined : booleanAt(fail, entry, "jsshell", context);
	// Gated on the producer's declaration, not on presence. An absent `h2` from a
	// producer that records the flag means false; from a producer that does not
	// record it, it means unknown — and those must not collapse to the same value.
	const h2 = recordedFlags.has("h2")
		? entry.h2 === undefined
			? false
			: booleanAt(fail, entry, "h2", context)
		: null;
	return Object.freeze({
		url,
		timeout: nullableStringAt(fail, entry, "timeout", context),
		testdriver,
		source: stringAt(fail, entry, "source", context),
		https: booleanAt(fail, entry, "https", context),
		subdomain: booleanAt(fail, entry, "subdomain", context),
		h2,
		...(features === undefined
			? {}
			: { testdriverFeatures: Object.freeze([...(features as string[])]) }),
		...(scriptMetadata === undefined ? {} : { scriptMetadata }),
		...(pac === undefined ? {} : { pac }),
		...(jsshell === undefined ? {} : { jsshell }),
	});
}

function readOtherCase(
	fail: SchemaFail,
	value: unknown,
	index: number,
	unknownKeys: Set<string>
): WptOtherCase {
	const context = `otherCases[${index}]`;
	const entry = plainObject(fail, value, context);
	for (const key of unrecognized(entry, OTHER_CASE_KEYS, "otherCases[].")) unknownKeys.add(key);
	const items = arrayAt(fail, entry, "items", context).map((item, position) => {
		const itemContext = `${context}.items[${position}]`;
		const raw = plainObject(fail, item, itemContext);
		const url = optionalStringAt(fail, raw, "url", itemContext);
		if (url !== undefined) assertUpstreamUrl(fail, url, itemContext);
		const timeout = optionalStringAt(fail, raw, "timeout", itemContext);
		const references = stringPairsAt(fail, raw, "references", itemContext);
		return Object.freeze({
			type: stringAt(fail, raw, "type", itemContext),
			...(url === undefined ? {} : { url }),
			...(timeout === undefined ? {} : { timeout }),
			...(references === undefined ? {} : { references }),
		});
	});
	const itemCount = integerAt(fail, entry, "itemCount", context, { min: 0 });
	if (itemCount !== items.length) {
		fail(`${context}.itemCount is ${itemCount} but ${items.length} item(s) are listed`, {
			itemCount,
			listed: items.length,
		});
	}
	const variants = optionalArrayAt(fail, entry, "variants", context);
	if (variants !== undefined) {
		for (const [position, item] of variants.entries()) {
			if (typeof item !== "string") {
				fail(`${context}.variants[${position}] must be a string`, { kind: typeof item });
			}
		}
	}
	return Object.freeze({
		path: stringAt(fail, entry, "path", context),
		type: stringAt(fail, entry, "type", context),
		items: Object.freeze(items),
		itemCount,
		runnerSupportedType: booleanAt(fail, entry, "runnerSupportedType", context),
		...(variants === undefined
			? {}
			: { variants: Object.freeze([...(variants as string[])]) }),
	});
}

/**
 * A generated test URL is a server-absolute path with optional query and fragment.
 *
 * Checked rather than assumed: a manifest whose `url` carries a scheme or an
 * authority would make the origin the *manifest's* choice instead of the running
 * server's, which is how a case ends up fetched from somewhere nobody recorded.
 */
function assertUpstreamUrl(fail: SchemaFail, url: string, context: string): void {
	if (!url.startsWith("/")) {
		fail(`${context}.url must be a server-absolute path starting with "/"`, { url });
	}
	if (url.startsWith("//")) {
		fail(`${context}.url must not start with "//": that is a scheme-relative authority`, { url });
	}
	if (/[\s\0]/.test(url)) {
		fail(`${context}.url must not contain whitespace or NUL`, { url });
	}
}

function readProvenance(
	fail: SchemaFail,
	raw: Record<string, unknown>,
	unknownKeys: Set<string>
): WptManifestProvenance {
	const provenance = objectAt(fail, raw, "provenance", "the manifest");
	const schemaVersion = integerAt(fail, provenance, "schemaVersion", "provenance", { min: 0 });
	if (schemaVersion !== WPT_MANIFEST_SCHEMA_VERSION) {
		fail(
			`the manifest declares provenance.schemaVersion ${schemaVersion}, this reader reads ` +
				`${WPT_MANIFEST_SCHEMA_VERSION}`,
			{ schemaVersion, expected: WPT_MANIFEST_SCHEMA_VERSION }
		);
	}

	const identityRaw = objectAt(fail, provenance, "identity", "provenance");
	const revision = stringAt(fail, identityRaw, "wptSourceRevision", "provenance.identity");
	if (!SHA1_PATTERN.test(revision)) {
		fail("provenance.identity.wptSourceRevision must be a 40-character git revision", {
			wptSourceRevision: revision,
		});
	}
	const aggregate = nullableStringAt(
		fail,
		identityRaw,
		"wptSourceAggregateHash",
		"provenance.identity"
	);
	if (aggregate !== null && !SHA256_PATTERN.test(aggregate)) {
		fail(
			"provenance.identity.wptSourceAggregateHash must be 64 lowercase hex characters or null",
			{ wptSourceAggregateHash: aggregate }
		);
	}
	const aggregateComplete = booleanAt(
		fail,
		identityRaw,
		"wptSourceAggregateHashComplete",
		"provenance.identity"
	);
	// The producer withholds a partial digest on purpose: an incomplete aggregate
	// would look like a pin while omitting files. A manifest that claims complete
	// and carries none is contradicting itself.
	if (aggregateComplete && aggregate === null) {
		fail(
			"provenance.identity claims a complete aggregate hash but records none",
			{ wptSourceAggregateHashComplete: aggregateComplete }
		);
	}

	const inventory = objectAt(fail, provenance, "inventory", "provenance");
	// Refused, not branched on: the generator's contract is that it observes no
	// execution, so `true` is a manifest claiming something its producer cannot
	// know. `executionRecorded` is therefore always false past this point, and
	// nothing downstream may test it as if it could vary.
	if (booleanAt(fail, inventory, "executionRecorded", "provenance.inventory")) {
		fail(
			"provenance.inventory.executionRecorded is true; an inventory manifest records no execution",
			{ executionRecorded: true }
		);
	}
	const recordedFlagsRaw = optionalArrayAt(
		fail,
		inventory,
		"recordedTestFlags",
		"provenance.inventory"
	);
	const recordedTestFlags = (recordedFlagsRaw ?? []).map((item, index) => {
		if (typeof item !== "string") {
			fail(`provenance.inventory.recordedTestFlags[${index}] must be a string`, {
				kind: typeof item,
			});
		}
		return item;
	});
	const supportedTypeNames = arrayAt(
		fail,
		inventory,
		"supportedTypeNames",
		"provenance.inventory"
	).map((item, index) => {
		if (typeof item !== "string") {
			fail(`provenance.inventory.supportedTypeNames[${index}] must be a string`, {
				kind: typeof item,
			});
		}
		return item;
	});

	const source = objectAt(fail, provenance, "source", "provenance");
	const validation = objectAt(fail, provenance, "validation", "provenance");
	// A missing map is a legitimate zero, but a present one is validated strictly:
	// its values are the contract that lets the count reconciliation below be exact.
	const duplicatesRaw =
		validation.duplicateTestUrls === undefined
			? {}
			: objectAt(fail, validation, "duplicateTestUrls", "provenance.validation");
	const duplicateTestUrls = new Map<string, readonly string[]>();
	let droppedDuplicateCount = 0;
	for (const [url, sources] of Object.entries(duplicatesRaw)) {
		const context = `provenance.validation.duplicateTestUrls[${JSON.stringify(url)}]`;
		if (!Array.isArray(sources)) {
			fail(`${context} must be an array of the source files that produced this URL`, {
				url,
				kind: sources === null ? "null" : typeof sources,
			});
		}
		// Fewer than two sources is not a duplicate: the generator records the kept
		// source first and appends one entry per dropped case, so a one-element list
		// describes a collision that never happened.
		if (sources.length < 2) {
			fail(
				`${context} lists ${sources.length} source(s); a duplicate needs at least two ` +
					"(the source that was kept, plus one per dropped case)",
				{ url, sources: sources.length }
			);
		}
		for (const [index, source] of sources.entries()) {
			if (typeof source !== "string" || source.length === 0) {
				fail(`${context}[${index}] must be a non-empty upstream source path`, {
					url,
					kind: typeof source,
				});
			}
		}
		duplicateTestUrls.set(url, Object.freeze([...(sources as string[])]));
		droppedDuplicateCount += sources.length - 1;
	}

	for (const key of unrecognized(
		provenance,
		[
			"schemaVersion",
			"identity",
			"inventory",
			"source",
			"selection",
			"validation",
			"hashes",
			"manifestTooling",
			"output",
			"runLocal",
			"generatedAt",
			"generator",
		],
		"provenance."
	)) {
		unknownKeys.add(key);
	}

	return Object.freeze({
		schemaVersion,
		identity: Object.freeze({
			wptSourceRevision: revision,
			wptSourceAggregateHash: aggregate,
			wptSourceAggregateHashComplete: aggregateComplete,
		}),
		executionRecorded: false,
		recordedTestFlags: Object.freeze(recordedTestFlags),
		supportedTypeNames: Object.freeze(supportedTypeNames),
		unparsableSourceFileCount: integerAt(
			fail,
			inventory,
			"unparsableSourceFileCount",
			"provenance.inventory",
			{ min: 0 }
		),
		supportFiles: integerAt(fail, inventory, "supportFiles", "provenance.inventory", { min: 0 }),
		repositoryDirty: booleanAt(fail, source, "repositoryDirty", "provenance.source"),
		selectedPathsDirty: booleanAt(fail, source, "selectedPathsDirty", "provenance.source"),
		revisionIdentifiesSelectedSources: booleanAt(
			fail,
			source,
			"revisionIdentifiesSelectedSources",
			"provenance.source"
		),
		duplicateTestUrls: duplicateTestUrls,
		droppedDuplicateCount,
		allSelectedFilesParsed: booleanAt(
			fail,
			validation,
			"allSelectedFilesParsed",
			"provenance.validation"
		),
	});
}

/**
 * Validates a manifest read back from disk and returns it in normalized form.
 *
 * `context` names the file for error details only; nothing is read from it.
 */
export function readWptManifest(
	value: unknown,
	context: string,
	options: ReadManifestOptions = {}
): WptManifest {
	// Annotated, not inferred: TypeScript only treats a call as never-returning —
	// and therefore only narrows the code after it — when the callee has an explicit
	// type annotation. Without this the `fail(...)` guards below would not narrow.
	const fail: SchemaFail = manifestFail(context);
	const raw = plainObject(fail, value, "the manifest");
	const unknownKeys = new Set<string>();
	for (const key of unrecognized(raw, MANIFEST_KEYS, "")) unknownKeys.add(key);

	const provenance = readProvenance(fail, raw, unknownKeys);
	const revision = stringAt(fail, raw, "revision", "the manifest");
	if (revision !== provenance.identity.wptSourceRevision) {
		fail(
			"the manifest's revision and provenance.identity.wptSourceRevision disagree",
			{ revision, identityRevision: provenance.identity.wptSourceRevision }
		);
	}

	const paths = arrayAt(fail, raw, "paths", "the manifest").map((item, index) => {
		if (typeof item !== "string" || item.length === 0) {
			fail(`paths[${index}] must be a non-empty string`, { kind: typeof item });
		}
		return item;
	});
	if (paths.length === 0) {
		fail("the manifest selects no upstream paths", {});
	}

	const recordedFlags = new Set<string>(provenance.recordedTestFlags);
	const tests = arrayAt(fail, raw, "tests", "the manifest").map((item, index) =>
		readTest(fail, item, index, unknownKeys, recordedFlags)
	);
	const seen = new Map<string, number>();
	for (const [index, test] of tests.entries()) {
		const previous = seen.get(test.url);
		if (previous !== undefined) {
			fail(`the manifest lists the test URL ${test.url} at tests[${previous}] and tests[${index}]`, {
				url: test.url,
			});
		}
		seen.set(test.url, index);
	}

	const otherCases = arrayAt(fail, raw, "otherCases", "the manifest").map((item, index) =>
		readOtherCase(fail, item, index, unknownKeys)
	);

	const countsRaw = objectAt(fail, raw, "counts", "the manifest");
	const counts: Record<string, number> = {};
	for (const [type, count] of Object.entries(countsRaw)) {
		if (
			typeof count !== "number" ||
			!Number.isInteger(count) ||
			count < 0 ||
			!Number.isSafeInteger(count)
		) {
			fail(`counts.${type} must be a non-negative whole number`, {
				type,
				count: typeof count === "number" ? count : null,
				kind: typeof count,
			});
		}
		counts[type] = count;
	}

	/*
	 * Reconcile `counts` against what the manifest actually lists, in both
	 * directions and against an exact expected value.
	 *
	 * `counts` is what upstream's parser produced; `tests` is what the generator
	 * kept. The only sanctioned difference is a dropped duplicate URL, and the
	 * generator records each one it dropped. So the relation is exact:
	 *
	 *     counts.testharness === tests.length + droppedDuplicates
	 *
	 * Checking only `counts > tests.length` would miss the opposite direction — a
	 * manifest listing *more* tests than upstream parsed is equally broken, and
	 * would silently inflate the denominator with cases upstream never produced.
	 */
	const harnessCount = counts.testharness ?? 0;
	// Summed, not the number of distinct URLs: see WptManifestProvenance.duplicateTestUrls.
	const dropped = provenance.droppedDuplicateCount;
	const expected = tests.length + dropped;
	if (harnessCount !== expected) {
		fail(
			`counts.testharness is ${harnessCount}, but the manifest lists ${tests.length} test(s) ` +
				`and records ${dropped} dropped duplicate case(s) across ` +
				`${provenance.duplicateTestUrls.size} colliding URL(s), which accounts for ${expected}`,
			{
				countsTestharness: harnessCount,
				tests: tests.length,
				droppedDuplicates: dropped,
				collidingUrls: provenance.duplicateTestUrls.size,
				expected,
				direction: harnessCount > expected ? "cases-missing" : "cases-unaccounted",
			}
		);
	}

	/*
	 * Incompleteness is carried, and by default refused.
	 *
	 * A manifest whose producer could not parse every selected file, or which
	 * withheld its "everything parsed" claim, is a short denominator. Reading one
	 * silently is the accounting failure the inventory exists to prevent, so it is
	 * refused unless the caller explicitly asks for diagnostic mode — and even then
	 * the reasons travel with the manifest so nothing built from it can be quoted
	 * as a complete selection.
	 */
	const incompleteness: string[] = [];
	if (provenance.unparsableSourceFileCount > 0) {
		incompleteness.push(
			`the producer could not parse ${provenance.unparsableSourceFileCount} selected file(s), ` +
				"so those upstream sources contributed no cases to this manifest"
		);
	}
	if (!provenance.allSelectedFilesParsed) {
		incompleteness.push(
			"provenance.validation.allSelectedFilesParsed is false, so the producer does not claim " +
				"this manifest covers its whole selection"
		);
	}
	if (!provenance.identity.wptSourceAggregateHashComplete) {
		incompleteness.push(
			"the producer withheld the aggregate source hash, so this manifest's sources are not " +
				"pinned by content"
		);
	}
	if (incompleteness.length > 0 && options.allowIncomplete !== true) {
		fail(
			`this manifest does not describe its whole selection: ${incompleteness.join("; ")}`,
			{ incompleteness, unparsable: provenance.unparsableSourceFileCount }
		);
	}

	return Object.freeze({
		revision,
		suite: stringAt(fail, raw, "suite", "the manifest"),
		paths: Object.freeze(paths),
		tests: Object.freeze(tests),
		otherCases: Object.freeze(otherCases),
		counts: Object.freeze(counts),
		provenance,
		unrecognizedFields: Object.freeze([...unknownKeys].sort()),
		incompleteness: Object.freeze(incompleteness),
	});
}

/**
 * Upstream's declared timeout class for a case.
 *
 * `null` is normal, `"long"` is long, and anything else is `unknown`: upstream has
 * one extra timeout token today, and inventing a deadline for a token this build
 * has never seen would be a guess. An unknown class makes the case non-executable
 * at this boundary rather than running with a made-up budget.
 */
export function timeoutClassOf(test: WptManifestTest): WptTimeoutClass | "unknown" {
	if (test.timeout === null) return "normal";
	if (test.timeout === "long") return "long";
	return "unknown";
}

/** The in-page harness timeout upstream will apply to this case. */
export function harnessTimeoutMsOf(test: WptManifestTest): number | null {
	const kind = timeoutClassOf(test);
	if (kind === "unknown") return null;
	return UPSTREAM_HARNESS_TIMEOUT_MS[kind];
}

/**
 * Whether this case needs `testdriver.js`, judged from every place upstream records it.
 *
 * Three independent signals, because no single one covers both plain and generated
 * items (see {@link WptManifestTest.testdriver}):
 *
 * 1. the `testdriver` extra, set by upstream for plain files;
 * 2. `testdriverFeatures`, which upstream only fills in when the file included
 *    `testdriver.js`;
 * 3. a `META: script=/resources/testdriver.js` pair, which is how a generated
 *    `.any.js` / `.window.js` / `.worker.js` file asks for it.
 *
 * Query parameters on the include are allowed by upstream
 * (`/resources/testdriver.js?feature=…`), so the script path is compared with the
 * query stripped, exactly as `sourcefile.py` does.
 */
export function requiresTestDriver(test: WptManifestTest): boolean {
	if (test.testdriver === true) return true;
	if (test.testdriverFeatures !== undefined && test.testdriverFeatures.length > 0) return true;
	for (const [key, value] of test.scriptMetadata ?? []) {
		if (key !== "script") continue;
		const withoutQuery = value.split("?")[0] ?? "";
		if (withoutQuery === "/resources/testdriver.js") return true;
	}
	return false;
}

/** The variant part of a generated URL (`?…`), as upstream appended it. */
export function variantOf(test: WptManifestTest): string | null {
	const index = test.url.indexOf("?");
	if (index < 0) return null;
	return test.url.slice(index);
}

/**
 * Characters an identifier may carry through, minus `_`.
 *
 * `_` is reserved as the escape introducer below, so it is excluded here and
 * escaped like any other reserved byte. See `core/ids.ts` for the id grammar.
 */
const ID_SAFE = /^[A-Za-z0-9.:@/+-]$/;

/**
 * Losslessly encodes an upstream URL into the identifier alphabet.
 *
 * `composeTestId` replaces every character an id may not carry with `_`, which is
 * not injective: `a-element.html?include=file` and `a-element.html_include=file`
 * would become the same id, and two different upstream cases would then collide in
 * the inventory — or worse, one would silently replace the other. So the URL is
 * escaped instead: every byte outside {@link ID_SAFE} becomes `_` followed by two
 * uppercase hex digits of that UTF-8 byte, and a literal `_` becomes `_5F`. The
 * result is in the id alphabet, and {@link decodeUpstreamUrl} recovers the URL
 * exactly — which is what the round-trip test asserts.
 */
export function encodeUpstreamUrl(url: string): string {
	const bytes = new TextEncoder().encode(url);
	let out = "";
	for (const byte of bytes) {
		const char = String.fromCharCode(byte);
		if (byte < 0x80 && ID_SAFE.test(char)) {
			out += char;
			continue;
		}
		out += `_${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/** Inverse of {@link encodeUpstreamUrl}. Throws on a malformed encoding. */
export function decodeUpstreamUrl(encoded: string): string {
	const bytes: number[] = [];
	for (let index = 0; index < encoded.length; index += 1) {
		const char = encoded[index]!;
		if (char !== "_") {
			bytes.push(char.charCodeAt(0));
			continue;
		}
		const hex = encoded.slice(index + 1, index + 3);
		if (!/^[0-9A-F]{2}$/.test(hex)) {
			throw new RunwayError(
				"suite/discovery-failed",
				`the encoded upstream URL is malformed at offset ${index}`,
				{ details: { encoded, offset: index } }
			);
		}
		bytes.push(Number.parseInt(hex, 16));
		index += 2;
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
}

const SUITE_LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Suite id for a manifest's selection label.
 *
 * Namespaced under `wpt/` so a WPT selection can never be confused with the
 * native suite, and refused outright when the label is not something the id
 * grammar can carry — a selection label is chosen by whoever ran the generator,
 * and sanitizing it here would let two labels share one suite id.
 */
export function wptSuiteId(manifestSuite: string): SuiteId {
	if (!SUITE_LABEL.test(manifestSuite)) {
		throw new RunwayError(
			"suite/discovery-failed",
			`the manifest's suite label ${JSON.stringify(manifestSuite)} is not a usable suite id`,
			{
				details: { suite: manifestSuite },
				remedy:
					"Regenerate the manifest with a --suite label of letters, digits, dot, dash or " +
					"underscore, starting with a letter or digit.",
			}
		);
	}
	return suiteId(`wpt/${manifestSuite}`);
}

/** Parses a manifest from JSON text. Never evaluates it. */
export function parseWptManifest(
	text: string,
	context: string,
	options: ReadManifestOptions = {}
): WptManifest {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (cause) {
		throw new RunwayError(
			"suite/discovery-failed",
			`the manifest ${context} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ details: { manifest: context }, cause }
		);
	}
	if (!isPlainObject(value)) {
		throw new RunwayError("suite/discovery-failed", `the manifest ${context} is not a JSON object`, {
			details: { manifest: context, kind: Array.isArray(value) ? "array" : typeof value },
		});
	}
	return readWptManifest(value, context, options);
}

/** Re-exported for callers that record a manifest's own identity map verbatim. */
export function manifestIdentityRecord(manifest: WptManifest): Readonly<Record<string, string>> {
	return Object.freeze({
		wptSourceRevision: manifest.provenance.identity.wptSourceRevision,
		wptSourceAggregateHash: manifest.provenance.identity.wptSourceAggregateHash ?? "withheld",
		wptSourceAggregateHashComplete: String(
			manifest.provenance.identity.wptSourceAggregateHashComplete
		),
		manifestSuite: manifest.suite,
		manifestSchemaVersion: String(manifest.provenance.schemaVersion),
		selectedPathsDirty: String(manifest.provenance.selectedPathsDirty),
		revisionIdentifiesSelectedSources: String(
			manifest.provenance.revisionIdentifiesSelectedSources
		),
		// Completeness travels with identity, so a record built from a short
		// denominator carries that fact rather than looking like a full one.
		unparsableSourceFileCount: String(manifest.provenance.unparsableSourceFileCount),
		allSelectedFilesParsed: String(manifest.provenance.allSelectedFilesParsed),
		recordedTestFlags: manifest.provenance.recordedTestFlags.join(",") || "none",
		incompleteness: manifest.incompleteness.length === 0 ? "none" : manifest.incompleteness.join(" | "),
	});
}
