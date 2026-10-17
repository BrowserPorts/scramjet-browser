/**
 * Types for the one value the test imports from the build script.
 *
 * `build.mjs` runs the full build when invoked directly and does nothing but
 * export when imported. The asset directories are exported so the packaging
 * tests assert against the build's own list rather than a handwritten copy.
 */
export declare const ASSET_DIRECTORIES: readonly string[];

/**
 * What importing `build.mjs` does and does not do.
 *
 * Importing it evaluates the module — constants, function definitions, the
 * export — and nothing else: no `dist/` wipe, no `tsc` spawn, no writes, no
 * chmod. The build, including the pre-build wipe and the failure cleanup, runs
 * only when the file is invoked directly (`node build.mjs`, including via the
 * `prepack` script). A regression test imports a copy of the module over a
 * sentinel `dist/` to prove this stays true.
 */
