/**
 * Typed run inputs and their provenance.
 *
 * An option carries the flag it came from, so every error can name the exact
 * argument that caused it. Options exist only between the argument parser and plan
 * resolution: no layer below the CLI ever sees them, and there is no environment
 * fallback anywhere.
 */

export type OptionOrigin = "cli";

export type OptionValue<T> = {
	readonly value: T;
	readonly origin: OptionOrigin;
	/** Flag or variable the value came from, for error messages. */
	readonly source: string;
};

export type RunwayOptions = {
	readonly suites?: OptionValue<readonly string[]>;
	readonly filters?: OptionValue<readonly string[]>;
	readonly lanes?: OptionValue<readonly string[]>;

	readonly browserExecutable?: OptionValue<string>;
	readonly browserChannel?: OptionValue<string>;
	readonly browserBundled?: OptionValue<boolean>;
	readonly headed?: OptionValue<boolean>;

	readonly harnessPort?: OptionValue<number>;
	readonly wispPort?: OptionValue<number>;
	readonly barePort?: OptionValue<number>;

	readonly scramjetDist?: OptionValue<string>;
	readonly controllerDist?: OptionValue<string>;
	readonly libcurlDist?: OptionValue<string>;

	/** Path to a WPT inventory manifest. Required when the `wpt` suite is selected. */
	readonly wptManifest?: OptionValue<string>;
	/**
	 * Read a manifest that does not describe its whole selection.
	 *
	 * Diagnosis only: entries from such a manifest are still refused execution by the
	 * suite adapter's own gate, so this can widen what is *read*, never what runs.
	 */
	readonly wptAllowIncomplete?: OptionValue<boolean>;
	/** Absolute path to an upstream WPT checkout, for the fixture server. */
	readonly wptRoot?: OptionValue<string>;
	/** Path to the wptserve config the caller owns. */
	readonly wptServerConfig?: OptionValue<string>;

	readonly pluginManifest?: OptionValue<string>;
	readonly expectations?: OptionValue<string>;
	readonly outputDir?: OptionValue<string>;

	readonly concurrency?: OptionValue<number>;
	readonly deadlineMs?: OptionValue<number>;


	readonly insecureDiagnostics?: OptionValue<boolean>;
	readonly coverage?: OptionValue<boolean>;
	readonly traceConsole?: OptionValue<boolean>;
};

export type OptionKey = keyof RunwayOptions;

/** Convenience constructor used by the CLI layer. */
export function option<T>(
	value: T,
	origin: OptionOrigin,
	source: string
): OptionValue<T> {
	return Object.freeze({ value, origin, source });
}
