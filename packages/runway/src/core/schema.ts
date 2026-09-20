/**
 * Strict validators for untrusted structured data.
 *
 * Every persisted artefact Runway reads back — terminal records, saved plans,
 * inventory snapshots — is data written by an earlier process and possibly edited
 * since. These helpers exist so that reading it is *checking* it: a field is the
 * type it declares or the read fails, and nothing is coerced on the way in.
 *
 * Two rules matter more than the individual functions:
 *
 *   * No coercion. `String(value)`, `Number(value)` and truthiness turn
 *     `[["runner/browser"]]` into `"runner/browser"` and `[]` into `{}`, which
 *     lets an edited file describe something the original never said while still
 *     hashing to the recorded digest. A hash is not a substitute for structural
 *     validation, so shapes are checked before anything is canonicalized.
 *   * Only declared fields. A versioned contract lists its keys; an unknown key
 *     means the document was written by something else, and that is reported
 *     rather than ignored.
 *
 * Each helper takes the caller's `fail` function so the resulting error keeps the
 * caller's own error code and remedy.
 */

/** Raises the caller's own structured error. Never returns. */
export type SchemaFail = (message: string, details: Record<string, unknown>) => never;

const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER;

/** Keys that would shadow object internals are never accepted from a file. */
const FORBIDDEN_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

function present(source: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined;
}

/** A plain JSON object: not null, not an array, no exotic prototype. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function plainObject(
	fail: SchemaFail,
	value: unknown,
	context: string
): Record<string, unknown> {
	if (!isPlainObject(value)) {
		fail(`${context} must be a JSON object`, {
			context,
			kind: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
		});
	}
	return value;
}

/** The value at `key` as a plain object. Arrays are rejected, never treated as one. */
export function objectAt(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string
): Record<string, unknown> {
	if (!present(source, key)) {
		fail(`${context} is missing the object field ${key}`, { context, key });
	}
	return plainObject(fail, source[key], `${context}.${key}`);
}

/**
 * A non-empty string: an identifier, path, origin, digest or selector.
 *
 * Emptiness is rejected because these fields *name* something, and `""` names
 * nothing. Text a subject wrote is a different kind of field and uses
 * {@link textAt}, which accepts `""` as the message it is.
 */
export function stringAt(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string
): string {
	const value = source[key];
	if (typeof value !== "string" || value.length === 0) {
		fail(`${context}.${key} must be a non-empty string`, {
			context,
			key,
			kind: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
		});
	}
	return value;
}

/**
 * Free text: any string, including the empty one.
 *
 * Deliberately separate from {@link stringAt}. `stringAt` is for *identifiers and
 * locators* — ids, paths, origins, digests, selectors — where an empty value names
 * nothing and is a defect. This is for text a subject wrote: a summary, an
 * assertion message. `""` is a real message ("it failed and said nothing"), it is
 * what `new Error("").message` is, and it is not the same fact as `null` ("there is
 * no message"). So it is preserved exactly: never rejected, and never normalized
 * into `null`.
 */
export function textAt(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string
): string {
	const value = source[key];
	if (typeof value !== "string") {
		fail(`${context}.${key} must be a string`, {
			context,
			key,
			kind: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
		});
	}
	return value;
}

/**
 * Free text or an explicit `null`. Absent is an error: the field must be stated.
 *
 * The two are distinct and both are kept: `""` is an empty message, `null` is the
 * absence of one. See {@link textAt}.
 */
export function nullableTextAt(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string
): string | null {
	if (!present(source, key) && source[key] !== null) {
		fail(`${context}.${key} must be a string or null`, { context, key, kind: "missing" });
	}
	if (source[key] === null) return null;
	return textAt(fail, source, key, context);
}

/** An optional string: absent, or a non-empty string. Never `null`, never coerced. */
export function optionalStringAt(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string
): string | undefined {
	if (!present(source, key)) return undefined;
	return stringAt(fail, source, key, context);
}

/**
 * A non-empty string or an explicit `null`. Absent is an error: the field must be
 * stated. For free text use {@link nullableTextAt}.
 */
export function nullableStringAt(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string
): string | null {
	if (!present(source, key) && source[key] !== null) {
		fail(`${context}.${key} must be a string or null`, { context, key, kind: "missing" });
	}
	const value = source[key];
	if (value === null) return null;
	return stringAt(fail, source, key, context);
}

export function booleanAt(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string
): boolean {
	const value = source[key];
	if (typeof value !== "boolean") {
		fail(`${context}.${key} must be a boolean`, {
			context,
			key,
			kind: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
			value: typeof value === "string" || typeof value === "number" ? value : undefined,
		});
	}
	return value;
}

/** A finite integer in range. Numeric strings are refused, not parsed. */
export function integerAt(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string,
	range: { readonly min: number; readonly max?: number }
): number {
	const value = source[key];
	if (typeof value !== "number" || !Number.isInteger(value)) {
		fail(`${context}.${key} must be an integer`, {
			context,
			key,
			kind: typeof value,
			value: typeof value === "string" ? value : undefined,
		});
	}
	const max = range.max ?? SAFE_INT_MAX;
	if (value < range.min || value > max) {
		fail(`${context}.${key} must be between ${range.min} and ${max}, got ${value}`, {
			context,
			key,
			value,
		});
	}
	return value;
}

export function optionalIntegerAt(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string,
	range: { readonly min: number; readonly max?: number }
): number | undefined {
	if (!present(source, key)) return undefined;
	return integerAt(fail, source, key, context, range);
}

/** A finite number (integral or not) in range. */
export function finiteNumberAt(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string,
	range: { readonly min: number; readonly max?: number }
): number {
	const value = source[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		fail(`${context}.${key} must be a finite number`, { context, key, kind: typeof value });
	}
	const max = range.max ?? Number.MAX_VALUE;
	if (value < range.min || value > max) {
		fail(`${context}.${key} must be between ${range.min} and ${max}, got ${value}`, {
			context,
			key,
			value,
		});
	}
	return value;
}

export function enumAt<T extends string>(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string,
	allowed: readonly T[]
): T {
	const value = source[key];
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		fail(`${context}.${key} is not one of ${allowed.join(", ")}`, {
			context,
			key,
			value: typeof value === "string" ? value : undefined,
			kind: typeof value,
			allowed,
		});
	}
	return value as T;
}

export function arrayAt(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string
): readonly unknown[] {
	const value = source[key];
	if (!Array.isArray(value)) {
		fail(`${context}.${key} must be an array`, {
			context,
			key,
			kind: value === null ? "null" : typeof value,
		});
	}
	return value;
}

export function optionalArrayAt(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string
): readonly unknown[] | undefined {
	if (!present(source, key)) return undefined;
	return arrayAt(fail, source, key, context);
}

/**
 * An array of non-empty strings.
 *
 * A nested array is a hard error: `[["runner/browser"]]` does not describe one
 * capability, and stringifying it would invent one that was never declared.
 */
export function stringArrayAt(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string
): readonly string[] {
	const items = arrayAt(fail, source, key, context);
	return Object.freeze(
		items.map((item, index) => {
			if (typeof item !== "string" || item.length === 0) {
				fail(`${context}.${key}[${index}] must be a non-empty string`, {
					context,
					key,
					index,
					kind: Array.isArray(item) ? "array" : item === null ? "null" : typeof item,
				});
			}
			return item;
		})
	);
}

/** A `Record<string, string>`: a plain object whose every value is a string. */
export function stringRecordAt(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string
): Readonly<Record<string, string>> {
	const object = objectAt(fail, source, key, context);
	assertNoForbiddenKeys(fail, object, `${context}.${key}`);
	const out: Record<string, string> = {};
	for (const [entryKey, value] of Object.entries(object)) {
		if (typeof value !== "string") {
			fail(`${context}.${key}.${entryKey} must be a string`, {
				context,
				key,
				entry: entryKey,
				kind: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
			});
		}
		out[entryKey] = value;
	}
	return Object.freeze(out);
}

/** An ISO-8601 instant. The value must be a string a clock could have produced. */
export function timestampAt(
	fail: SchemaFail,
	source: Record<string, unknown>,
	key: string,
	context: string
): string {
	const value = stringAt(fail, source, key, context);
	if (!Number.isFinite(Date.parse(value))) {
		fail(`${context}.${key} is not a parseable timestamp`, { context, key, value });
	}
	return value;
}

export function assertNoForbiddenKeys(
	fail: SchemaFail,
	source: Record<string, unknown>,
	context: string
): void {
	for (const key of Object.keys(source)) {
		if (FORBIDDEN_KEYS.includes(key)) {
			fail(`${context} may not carry the key ${key}`, { context, key });
		}
	}
}

/**
 * Rejects keys the contract does not declare.
 *
 * A versioned document describes itself completely. An extra key means the file
 * was produced by a different contract, and guessing which one is how a reader
 * starts accepting evidence it cannot interpret.
 */
export function assertOnlyKeys(
	fail: SchemaFail,
	source: Record<string, unknown>,
	allowed: readonly string[],
	context: string
): void {
	assertNoForbiddenKeys(fail, source, context);
	const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) {
		fail(`${context} carries unknown field(s): ${unknown.sort().join(", ")}`, {
			context,
			unknown: unknown.sort(),
			allowed: [...allowed].sort(),
		});
	}
}

/**
 * Deep-validates plain JSON data and returns a frozen copy.
 *
 * Accepts strings, finite numbers, booleans, null, arrays and plain objects.
 * Everything else — functions, symbols, class instances, `NaN`, `Infinity` — is
 * rejected, because it either cannot round-trip or is executable state that has
 * no business in persisted configuration. Arrays and objects stay distinct.
 */
export function jsonData(fail: SchemaFail, value: unknown, context: string): unknown {
	if (value === null) return null;
	switch (typeof value) {
		case "string":
		case "boolean":
			return value;
		case "number":
			if (!Number.isFinite(value)) {
				fail(`${context} holds the non-finite number ${String(value)}`, { context });
			}
			return value;
		case "object": {
			if (Array.isArray(value)) {
				return Object.freeze(value.map((item, index) => jsonData(fail, item, `${context}[${index}]`)));
			}
			if (!isPlainObject(value)) {
				fail(`${context} is not plain JSON data`, {
					context,
					constructor: (value as object).constructor?.name ?? null,
				});
			}
			assertNoForbiddenKeys(fail, value, context);
			const out: Record<string, unknown> = {};
			for (const [key, item] of Object.entries(value)) {
				if (item === undefined) continue;
				out[key] = jsonData(fail, item, `${context}.${key}`);
			}
			return Object.freeze(out);
		}
		default:
			return fail(`${context} holds a ${typeof value}, which is not JSON data`, {
				context,
				kind: typeof value,
			});
	}
}
