/**
 * Which paths may never be inside the Runway tarball, as a pure function.
 *
 * This is the whole of the "custom" packaging logic: a list of rules over
 * tarball member paths. It lives in its own module so the rules can be read and
 * reused without running the packer; `check-package.mjs` imports
 * `findForbiddenTarballPaths` and applies it to the members of the archive
 * `pnpm pack` produced, alongside `publint` and `attw`. There is no parser, no
 * framework, no state — a rule is a label and a pattern.
 *
 * Nothing here is covered by an automated test: this package ships no unit
 * tests, so `pnpm check-package` running over a real tarball is the only thing
 * that exercises these rules.
 */

/**
 * Paths that must not be in the tarball, and what each one is.
 *
 * These are all things the working tree really contains: run output, Python
 * bytecode from the WPT tooling, and the unmigrated producers under `migration/`.
 * `files` excludes them today; this is what notices when that stops being true.
 *
 * The `wpt` rule is a path-segment rule, not a substring: any member whose path
 * has `wpt` as a directory or file-stem segment is refused. Upstream suites are
 * parked, not shipped — `migration/wpt` is excluded by the rule above and this one
 * catches a suite landing anywhere else. The single exemption is the runner's own
 * `dist/suites/wpt/` adapter, which is compiled product code and has to ship for
 * the `wpt` suite to be usable by an installed consumer.
 */
export const FORBIDDEN_TARBALL_PATHS = Object.freeze([
	{ label: "agent scratch state", pattern: /(^|\/)\.agent(\/|$)/ },
	{ label: "run output", pattern: /(^|\/)(output|runway-output)(\/|$)/ },
	{ label: "coverage report", pattern: /(^|\/)coverage(\/|$)/ },
	{ label: "backup directory", pattern: /(^|\/)backups?(\/|$)/ },
	{ label: "Python bytecode", pattern: /(^|\/)__pycache__(\/|$)|\.py[co]$/ },
	{ label: "unmigrated WPT producer", pattern: /(^|\/)migration(\/|$)/ },
	// The runner's own WPT suite adapter ships; parked upstream fixtures do not.
	// Without the exemption this rule refused `dist/suites/wpt/*`, which is product
	// code, not an upstream suite.
	{
		label: "parked upstream WPT content",
		pattern: /(^|\/)wpt([/.]|$)/,
		allow: /(^|\/)dist\/suites\/wpt\//,
	},
	{ label: "TypeScript source", pattern: /\.ts$/, allow: /\.d\.ts$/ },
	{ label: "nested install tree", pattern: /(^|\/)node_modules(\/|$)/ },
	{ label: "environment file", pattern: /(^|\/)\.env(\.|$)/ },
]);

/**
 * Every member that breaks a rule, as `"path (label)"` strings.
 *
 * `entries` are tarball member paths relative to the `package/` root npm
 * tarballs use — exactly what `tar -tzf` lists, minus the prefix.
 */
export function findForbiddenTarballPaths(entries) {
	const offenders = [];
	for (const entry of entries) {
		for (const rule of FORBIDDEN_TARBALL_PATHS) {
			if (!rule.pattern.test(entry)) continue;
			if (rule.allow?.test(entry)) continue;
			offenders.push(`${entry} (${rule.label})`);
		}
	}
	return offenders;
}
