/**
 * Browser entry asset for the scoped libcurl transport.
 *
 * Served to the harness page and imported dynamically. It does two things and
 * nothing else: re-export the built fork's libcurl object under a stable name,
 * and record which artifact was loaded so a run can prove it did not get the
 * bundled upstream build.
 *
 * BUNDLING CONTRACT (for the browser-lane owner)
 * ----------------------------------------------
 *   input   packages/runway/src/net/assets/libcurl-scoped-entry.js
 *   needs   the built fork's ESM entry reachable at ./libcurl.mjs beside it,
 *           together with its libcurl.wasm
 *   output  serve both from the harness origin; pass the entry's URL as
 *           ForkLoadConfig.moduleUrl
 *
 * Nothing is written to node_modules, and the installed unpatched
 * @mercuryworkshop/libcurl-transport is not used on this path.
 */
export { libcurl } from "./libcurl.mjs";

/** Set by the build step that copies the fork in, for artifact provenance. */
export const forkArtifact = {
	source: "vendor/libcurl.js + patches/0001-scoped-per-session-ca-trust.patch",
	builtAt: null,
	wasmSha256: null,
};
