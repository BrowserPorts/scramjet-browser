/**
 * @fileoverview
 * Contract tests for `packages/core/rewriter/wasm/build.sh` and its input
 * fingerprint helper `hash-inputs.sh`.
 *
 * These run the real production scripts. Nothing here is a reimplementation:
 * each test copies the rewriter tree into a throwaway fixture, puts stub
 * `cargo` / `rustc` / `wasm-bindgen` / `wasm-opt` / `wasm-snip` executables on
 * PATH, and executes `build.sh` exactly the way `packages/core`'s
 * `rewriter:build` does. The shared checkout is never mutated, and no native
 * compilation happens, so this is a unit-level suite rather than a build.
 *
 * `/bin/bash` is invoked explicitly. On macOS that is bash 3.2.57, which is the
 * whole point: `rewriter:build` runs `bash build.sh`, so the system bash is the
 * interpreter and the script must not use any bash >= 4.4 feature.
 *
 * SCOPE OF WHAT THE STUBS PROVE. The stubs emit a realistic *file structure* --
 * including the `snippets/` directory and the `import` of it that wasm-bindgen
 * really generates -- so that the freshness gate, the receipt and the error
 * paths are exercised against the real shape of a build. They compile nothing.
 * Nothing in this file is evidence about WebAssembly semantics, rewriter
 * behaviour, or the correctness of the emitted module.
 */

import test from "ava";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	".."
);
const SOURCE_REWRITER = path.join(REPO_ROOT, "packages", "core", "rewriter");
const BUILD_SH = path.join(SOURCE_REWRITER, "wasm", "build.sh");
const HASH_SH = path.join(SOURCE_REWRITER, "wasm", "hash-inputs.sh");

/** The interpreter under test. On macOS this is bash 3.2.57. */
const BASH = "/bin/bash";

/**
 * A minimal PATH. The real toolchain must be unreachable so that a test can
 * never accidentally invoke the host's cargo, and the stub directory always
 * comes first.
 */
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(
	path.delimiter
);

/**
 * wasm-bindgen emits inline_js snippets into a directory whose name carries a
 * content hash. The real build produces exactly this path from the
 * `#[wasm_bindgen(inline_js = ...)]` in `wasm/src/jsr.rs`, and `out/wasm.js`
 * line 1 imports from it.
 */
const SNIPPET_REL = "snippets/wasm-4b0f351a8e6eeb46/inline0.js";

/** Artifacts named explicitly by build.sh, relative to `packages/core`. */
const EXPECTED_OUTPUTS = [
	"rewriter/wasm/out/wasm.js",
	"rewriter/wasm/out/wasm.d.ts",
	"rewriter/wasm/out/wasm_bg.wasm",
	"rewriter/wasm/out/wasm_snipped.wasm",
	"rewriter/wasm/out/optimized.wasm",
	"dist/scramjet.wasm",
];

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Per-test budget. These are synchronous and spawn a lot of short lived
 * processes, so the default 10s inactivity timeout is too tight on a loaded or
 * slow runner.
 */
const TEST_TIMEOUT_MS = 180_000;

/**
 * Strips whole line `#` comments from a shell script so that assertions about
 * what the script *does* are not satisfied or broken by what it *says*.
 *
 * @param {string} source - Shell script text.
 * @returns {string} The script with comment-only lines removed.
 */
function shellCodeOnly(source) {
	return source
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");
}

/**
 * Shared stub preamble. Written as plain (non template) strings so that `${...}`
 * stays literal shell syntax.
 *
 * Each stub logs its argv to `$STUB_LOG`, honours `$STUB_FAIL` (a comma
 * separated list of tools that must fail), and verifies that the input file it
 * was handed actually exists, so the pipeline between the stubs is real.
 *
 * @param {string} name - The tool name this stub impersonates.
 * @returns {string} Shell source for the preamble.
 */
const stubPrelude = (name) =>
	[
		"#!/bin/bash",
		"set -u",
		`STUB_NAME=${JSON.stringify(name)}`,
		'printf "%s" "$STUB_NAME" >> "$STUB_LOG"',
		'for a in "$@"; do printf " %s" "$a" >> "$STUB_LOG"; done',
		'printf "\\n" >> "$STUB_LOG"',
		"forced_failure() {",
		'	case ",${STUB_FAIL:-}," in',
		'	*",$STUB_NAME,"*)',
		'		echo "stub $STUB_NAME: forced failure" >&2',
		"		exit 3",
		"		;;",
		"	esac",
		"}",
		"first_wasm_input() {",
		'	for a in "$@"; do',
		'		case "$a" in',
		"		*.wasm)",
		'			if [ -f "$a" ]; then',
		'				printf "%s" "$a"',
		"				return 0",
		"			fi",
		"			;;",
		"		esac",
		"	done",
		"	return 1",
		"}",
		"output_arg() {",
		"	while [ $# -gt 0 ]; do",
		'		if [ "$1" = "-o" ]; then',
		'			printf "%s" "${2:-}"',
		"			return 0",
		"		fi",
		"		shift",
		"	done",
		"	return 1",
		"}",
		"",
	].join("\n");

const STUBS = {
	cargo: [
		stubPrelude("cargo"),
		'if [ "${1:-}" = "+nightly" ] && [ "${2:-}" = "--version" ]; then',
		'	if [ "${STUB_CARGO_NO_PLUS_TOOLCHAIN:-0}" = "1" ]; then',
		'		echo "error: no such command: \\`+nightly\\`" >&2',
		"		exit 101",
		"	fi",
		'	echo "${STUB_CARGO_VERSION-cargo 1.100.0-nightly (stub0000000 2026-09-11)}"',
		"	exit 0",
		"fi",
		"forced_failure",
		"# Simulates somebody editing a hash input while the compile is running.",
		'if [ -n "${STUB_MUTATE_DURING_BUILD:-}" ]; then',
		'	printf "// touched while cargo was running\\n" >> "$STUB_MUTATE_DURING_BUILD"',
		"fi",
		"# Writes into target/ the way a real build does, including a cargo style",
		"# fingerprint JSON. Those must never be part of the input fingerprint.",
		"mkdir -p ../target/wasm32-unknown-unknown/release",
		"mkdir -p ../target/release/build/stub-0000000000000000/fingerprint",
		'printf "{\\"rustc\\":%s}\\n" "$RANDOM$RANDOM" > ../target/release/build/stub-0000000000000000/fingerprint/lib-stub.json',
		'printf "stub compiled wasm %s\\n" "${STUB_WASM_BODY-fixed}" > ../target/wasm32-unknown-unknown/release/wasm.wasm',
		"# Cargo writes a makefile rule naming every file rustc read. Reproduced",
		"# so build.sh's dep-info cross-check runs against a realistic shape.",
		'dep_out=../target/wasm32-unknown-unknown/release/wasm.d',
		'printf "%s/wasm.wasm:" "$PWD/../target/wasm32-unknown-unknown/release" > "$dep_out"',
		'for f in ../js/src/lib.rs ../wasm/src/lib.rs ../transform/src/lib.rs; do',
		'\tdp="$(cd "$(dirname "$f")" && pwd -P)/$(basename "$f")"',
		"\t# Cargo escapes an embedded space as a backslash-space pair.",
		'\tprintf " %s" "${dp// /\\\\ }" >> "$dep_out"',
		"done",
		'if [ -n "${STUB_DEP_INFO_EXTRA:-}" ]; then',
		'\tprintf " %s" "${STUB_DEP_INFO_EXTRA// /\\\\ }" >> "$dep_out"',
		"fi",
		'printf "\\n" >> "$dep_out"',
		'if [ "${STUB_DEP_INFO_MISSING:-0}" = "1" ]; then rm -f "$dep_out"; fi',
		'if [ -n "${STUB_DEP_INFO_RAW:-}" ]; then printf "%s\\n" "$STUB_DEP_INFO_RAW" > "$dep_out"; fi',
		"exit 0",
	].join("\n"),

	rustc: [
		stubPrelude("rustc"),
		'if [ "${1:-}" = "+nightly" ] && [ "${2:-}" = "-vV" ]; then',
		'	if [ "${STUB_RUSTC_NO_PLUS_TOOLCHAIN:-0}" = "1" ]; then',
		'		echo "error: no such command: \\`+nightly\\`" >&2',
		"		exit 101",
		"	fi",
		'	if [ -n "${STUB_RUSTC_IDENTITY+set}" ]; then',
		'		printf "%s" "$STUB_RUSTC_IDENTITY"',
		"		exit 0",
		"	fi",
		'	echo "rustc 1.100.0-nightly (809936eac 2026-09-12)"',
		'	echo "binary: rustc"',
		'	echo "commit-hash: 809936eac0000000000000000000000000000000"',
		'	echo "commit-date: 2026-09-12"',
		'	echo "host: aarch64-apple-darwin"',
		'	echo "release: 1.100.0-nightly"',
		'	echo "LLVM version: 21.1.1"',
		"	exit 0",
		"fi",
		"forced_failure",
		"exit 0",
	].join("\n"),

	"wasm-bindgen": [
		stubPrelude("wasm-bindgen"),
		'if [ "${1:-}" = "-V" ] || [ "${1:-}" = "--version" ]; then',
		'	echo "${STUB_WASM_BINDGEN_VERSION-wasm-bindgen 0.2.105}"',
		"	exit 0",
		"fi",
		"forced_failure",
		'if ! input="$(first_wasm_input "$@")"; then',
		'	echo "stub wasm-bindgen: no existing .wasm input in: $*" >&2',
		"	exit 4",
		"fi",
		'out=""',
		"while [ $# -gt 0 ]; do",
		'	if [ "$1" = "--out-dir" ]; then',
		'		out="${2:-}"',
		"		break",
		"	fi",
		"	shift",
		"done",
		'if [ -z "$out" ]; then',
		'	echo "stub wasm-bindgen: no --out-dir" >&2',
		"	exit 5",
		"fi",
		'mkdir -p "$out"',
		"# The real wasm-bindgen emits inline_js snippets into a content-hashed",
		"# directory and makes the glue import from it. Reproduced here so the",
		"# receipt is exercised against the real output shape.",
		`mkdir -p "$out/${path.dirname(SNIPPET_REL)}"`,
		`printf "export function scramtag() { return %s; }\\n" "\${STUB_SNIPPET_BODY-0}" > "$out/${SNIPPET_REL}"`,
		`printf "import { scramtag } from './${SNIPPET_REL}';\\n" > "$out/wasm.js"`,
		'printf "const u = import.meta.url;\\nexport default u;\\n" >> "$out/wasm.js"',
		'printf "stub bindgen wasm from %s\\n" "$(cat "$input")" > "$out/wasm_bg.wasm"',
		'printf "export default undefined;\\n" > "$out/wasm.d.ts"',
		'printf "export default undefined;\\n" > "$out/wasm_bg.wasm.d.ts"',
		"exit 0",
	].join("\n"),

	"wasm-snip": [
		stubPrelude("wasm-snip"),
		'if [ "${1:-}" = "--version" ] || [ "${1:-}" = "-V" ]; then',
		'	echo "${STUB_WASM_SNIP_VERSION-wasm-snip 0.4.0}"',
		"	exit 0",
		"fi",
		"forced_failure",
		'if ! input="$(first_wasm_input "$@")"; then',
		'	echo "stub wasm-snip: no existing .wasm input in: $*" >&2',
		"	exit 4",
		"fi",
		'if ! out="$(output_arg "$@")"; then',
		'	echo "stub wasm-snip: no -o argument" >&2',
		"	exit 5",
		"fi",
		'cp "$input" "$out"',
		"exit 0",
	].join("\n"),

	"wasm-opt": [
		stubPrelude("wasm-opt"),
		'if [ "${1:-}" = "--version" ] || [ "${1:-}" = "-V" ]; then',
		'	echo "${STUB_WASM_OPT_VERSION-wasm-opt version 132 (version_132)}"',
		"	exit 0",
		"fi",
		"forced_failure",
		'if ! input="$(first_wasm_input "$@")"; then',
		'	echo "stub wasm-opt: no existing .wasm input in: $*" >&2',
		"	exit 4",
		"fi",
		'if ! out="$(output_arg "$@")"; then',
		'	echo "stub wasm-opt: no -o argument" >&2',
		"	exit 5",
		"fi",
		'cp "$input" "$out"',
		"exit 0",
	].join("\n"),
};

/**
 * Builds an isolated fixture: a `packages/core` lookalike holding a copy of the
 * rewriter tree (without any build output) plus a stub tool directory.
 *
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 * @returns {{
 *   root: string,
 *   coreDir: string,
 *   rewriterDir: string,
 *   wasmDir: string,
 *   binDir: string,
 *   logPath: string,
 *   receiptFile: string,
 *   legacyHashFile: string,
 *   outDir: string,
 *   snippetFile: string,
 *   distWasm: string,
 * }} Fixture paths.
 */
function makeFixture(t, options = {}) {
	t.timeout(TEST_TIMEOUT_MS);
	const outer = mkdtempSync(path.join(tmpdir(), "scramjet-rewriter-build-"));
	t.teardown(() => rmSync(outer, { recursive: true, force: true }));
	// `awkwardRoot` puts the whole fixture under a directory whose name is full
	// of glob metacharacters. `find -path` takes a PATTERN, so interpolating a
	// root like this into a prune argument fails OPEN: the prune silently stops
	// matching and generated output re-enters the fingerprint.
	const root = options.awkwardRoot
		? path.join(outer, "we[i]rd*root?dir")
		: options.spaceRoot
			? path.join(outer, "T7 APFS", "My Projects")
			: outer;
	mkdirSync(root, { recursive: true });

	const coreDir = path.join(root, "core");
	const rewriterDir = path.join(coreDir, "rewriter");
	mkdirSync(coreDir, { recursive: true });

	// `target/` is hundreds of megabytes of build output and `wasm/out/` is the
	// previous artifact set. Both are excluded so every fixture starts from a
	// state with no outputs at all -- and so the fixture matches what the
	// fingerprint's own pruning would exclude anyway.
	cpSync(SOURCE_REWRITER, rewriterDir, {
		recursive: true,
		filter: (src) => {
			const rel = path.relative(SOURCE_REWRITER, src);
			return rel !== "target" && rel !== path.join("wasm", "out");
		},
	});

	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = path.join(root, "tool-invocations.log");
	writeFileSync(logPath, "");

	for (const [name, body] of Object.entries(STUBS)) {
		const stubPath = path.join(binDir, name);
		writeFileSync(stubPath, `${body}\n`);
		chmodSync(stubPath, 0o755);
	}

	const outDir = path.join(rewriterDir, "wasm", "out");
	return {
		root,
		coreDir,
		rewriterDir,
		wasmDir: path.join(rewriterDir, "wasm"),
		binDir,
		logPath,
		outDir,
		receiptFile: path.join(outDir, ".build-receipt"),
		legacyHashFile: path.join(outDir, ".build-hash"),
		snippetFile: path.join(outDir, SNIPPET_REL),
		distWasm: path.join(coreDir, "dist", "scramjet.wasm"),
	};
}

/**
 * Runs the real `build.sh` from the fixture's wasm directory under `/bin/bash`.
 *
 * The environment is constructed from scratch rather than inherited, so the
 * ambient shell cannot leak CARGO_HOME, RUSTFLAGS or anything else the script
 * now refuses.
 *
 * @param {ReturnType<typeof makeFixture>} fixture - Fixture paths.
 * @param {Record<string, string>} [env] - Extra environment for the run.
 * @param {{ bareBin?: boolean }} [options] - `bareBin` drops the stub tools.
 * @returns {import("node:child_process").SpawnSyncReturns<string>} Result.
 */
function runBuild(fixture, env = {}, options = {}) {
	const searchPath = options.bareBin
		? SYSTEM_PATH
		: `${fixture.binDir}${path.delimiter}${SYSTEM_PATH}`;
	return spawnSync(BASH, ["build.sh"], {
		cwd: fixture.wasmDir,
		encoding: "utf8",
		env: {
			PATH: searchPath,
			HOME: fixture.root,
			STUB_LOG: fixture.logPath,
			...env,
		},
	});
}

/**
 * Runs the real `hash-inputs.sh` against a fixture's rewriter tree.
 *
 * @param {ReturnType<typeof makeFixture>} fixture - Fixture paths.
 * @param {string[]} [policies] - `NAME=VALUE` policy records, in order.
 * @param {Record<string, string>} [env] - Extra environment for the run.
 * @returns {import("node:child_process").SpawnSyncReturns<string>} Result.
 */
function runHash(fixture, policies = ["MODE=release"], env = {}) {
	const args = [
		path.join(fixture.wasmDir, "hash-inputs.sh"),
		"--root",
		fixture.rewriterDir,
		"--config-scan-from",
		fixture.wasmDir,
	];
	for (const policy of policies) {
		args.push("--policy", policy);
	}
	return spawnSync(BASH, args, {
		encoding: "utf8",
		env: {
			PATH: `${fixture.binDir}${path.delimiter}${SYSTEM_PATH}`,
			HOME: fixture.root,
			STUB_LOG: fixture.logPath,
			...env,
		},
	});
}

/**
 * Runs `hash-inputs.sh` and asserts it succeeded, returning the digest.
 *
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 * @param {ReturnType<typeof makeFixture>} fixture - Fixture paths.
 * @param {string[]} [policies] - `NAME=VALUE` policy records, in order.
 * @param {Record<string, string>} [env] - Extra environment for the run.
 * @returns {string} The 64 character digest.
 */
function digestOf(t, fixture, policies, env) {
	const result = runHash(fixture, policies, env);
	t.is(result.status, 0, `hash-inputs.sh failed: ${result.stderr}`);
	const digest = result.stdout.trim();
	t.regex(digest, SHA256_RE, "digest must be a lowercase sha256 hex string");
	return digest;
}

/**
 * Reads the stub invocation log as a list of argv lines.
 *
 * @param {ReturnType<typeof makeFixture>} fixture - Fixture paths.
 * @returns {string[]} One line per stub invocation.
 */
function toolLog(fixture) {
	return readFileSync(fixture.logPath, "utf8")
		.split("\n")
		.filter((line) => line.length > 0);
}

/**
 * True when the stub cargo was asked to actually compile, rather than just
 * report its version.
 *
 * @param {ReturnType<typeof makeFixture>} fixture - Fixture paths.
 * @returns {boolean} Whether a compile was attempted.
 */
function cargoCompiled(fixture) {
	return toolLog(fixture).some((line) =>
		line.startsWith("cargo +nightly build")
	);
}

/**
 * The generated-output paths a receipt binds, decoded from its framed records.
 *
 * @param {ReturnType<typeof makeFixture>} fixture - Fixture paths.
 * @returns {string[]} Paths relative to `packages/core`.
 */
function receiptPaths(fixture) {
	return readFileSync(fixture.receiptFile, "utf8")
		.split("\n")
		.filter((line) => line.startsWith("O "))
		.map((line) => Buffer.from(line.split(" ")[2], "hex").toString("utf8"));
}

/**
 * Installs a `find` that emits one real path and then fails, to prove the
 * enumeration's exit status is not discarded.
 *
 * @param {ReturnType<typeof makeFixture>} fixture - Fixture paths.
 */
function installFailingFind(fixture) {
	const stub = path.join(fixture.binDir, "find");
	writeFileSync(
		stub,
		[
			"#!/bin/bash",
			// One NUL-terminated path, exactly as -print0 would emit, then a
			// mid-walk failure.
			`printf '%s\\0' "${fixture.rewriterDir}/Cargo.toml"`,
			'echo "find: a directory vanished mid-walk" >&2',
			"exit 1",
			"",
		].join("\n")
	);
	chmodSync(stub, 0o755);
}

// ==========================================================================
// the interpreter contract
// ==========================================================================

/**
 * The script is invoked as `bash build.sh`, so the shebang is irrelevant and
 * the system bash is the interpreter. `shopt -s inherit_errexit` is bash >= 4.4
 * only and made the script abort on line 3 on any default macOS install.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("neither script uses a bash >= 4.4 feature", (t) => {
	t.timeout(TEST_TIMEOUT_MS);
	// Comment-only lines are stripped: both scripts deliberately *explain*
	// inherit_errexit, and mentioning it must not count as using it.
	for (const script of [BUILD_SH, HASH_SH]) {
		const code = shellCodeOnly(readFileSync(script, "utf8"));
		t.false(
			code.includes("inherit_errexit"),
			`${script}: inherit_errexit is bash >= 4.4 and must not be required`
		);
		t.false(code.includes("shopt"), `${script}: no shopt option should be needed`);
	}

	const version = execFileSync(BASH, ["-c", "echo $BASH_VERSION"], {
		encoding: "utf8",
	}).trim();
	t.log(`${BASH} reports ${version}`);
	for (const script of [BUILD_SH, HASH_SH]) {
		const parsed = spawnSync(BASH, ["-n", script], { encoding: "utf8" });
		t.is(parsed.status, 0, `${script} failed to parse: ${parsed.stderr}`);
	}
});

// ==========================================================================
// the input closure
// ==========================================================================

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh is deterministic", (t) => {
	const fixture = makeFixture(t);
	t.is(digestOf(t, fixture), digestOf(t, fixture));
});

/**
 * The defect this replaces: the old expression hashed `../target/**`, so 180 of
 * its 209 inputs were build outputs and the digest changed every time the build
 * ran.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh ignores generated outputs", (t) => {
	const fixture = makeFixture(t);
	const before = digestOf(t, fixture);

	const generated = [
		path.join(
			fixture.rewriterDir,
			"target/release/build/whatever/fingerprint/lib-x.json"
		),
		path.join(fixture.rewriterDir, "target/generated.rs"),
		path.join(fixture.outDir, "optimized.wasm"),
		path.join(fixture.outDir, SNIPPET_REL),
		path.join(fixture.outDir, ".build-receipt"),
		path.join(fixture.coreDir, "dist", "scramjet.wasm"),
	];
	for (const file of generated) {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, "generated output, not an input\n");
	}

	t.is(digestOf(t, fixture), before, "outputs must not affect the digest");
});

/**
 * Cargo discovers `build.rs` by filename. A closure derived from `Cargo.toml`
 * would not see one appear; the whole-tree closure does.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh sees a build.rs appear with no manifest edit", (t) => {
	const fixture = makeFixture(t);
	const manifest = path.join(fixture.rewriterDir, "wasm", "Cargo.toml");
	const manifestBefore = readFileSync(manifest, "utf8");
	const before = digestOf(t, fixture);

	const buildRs = path.join(fixture.rewriterDir, "wasm", "build.rs");
	writeFileSync(buildRs, 'fn main() { println!("cargo:rustc-cfg=injected"); }\n');

	t.is(
		readFileSync(manifest, "utf8"),
		manifestBefore,
		"the manifest is deliberately untouched"
	);
	const withBuildRs = digestOf(t, fixture);
	t.not(withBuildRs, before, "an auto-discovered build.rs must invalidate");

	writeFileSync(buildRs, 'fn main() { println!("cargo:rustc-cfg=other"); }\n');
	t.not(digestOf(t, fixture), withBuildRs, "its contents must invalidate too");
});

/**
 * Cargo reads `.cargo/config.toml` from the invocation directory upwards, so a
 * config ABOVE the hashed tree still changes the build. That one cannot be
 * covered by hashing the tree and needs explicit discovery.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh discovers cargo config above the hashed tree", (t) => {
	const fixture = makeFixture(t);
	const before = digestOf(t, fixture);

	// Outside --root (which is coreDir/rewriter) but an ancestor of the
	// directory cargo is invoked from (coreDir/rewriter/wasm).
	const ancestorConfig = path.join(fixture.coreDir, ".cargo", "config.toml");
	mkdirSync(path.dirname(ancestorConfig), { recursive: true });
	writeFileSync(ancestorConfig, '[build]\nrustflags = ["-C", "opt-level=1"]\n');

	t.false(
		ancestorConfig.startsWith(fixture.rewriterDir + path.sep),
		"the fixture must place this outside the hashed tree for the test to mean anything"
	);

	const withConfig = digestOf(t, fixture);
	t.not(withConfig, before, "an ancestor cargo config must invalidate");

	writeFileSync(ancestorConfig, '[build]\nrustflags = ["-C", "opt-level=2"]\n');
	t.not(digestOf(t, fixture), withConfig, "its contents must invalidate too");

	rmSync(path.dirname(ancestorConfig), { recursive: true });
	t.is(digestOf(t, fixture), before, "removing it restores the digest");
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh covers the CARGO_HOME cargo config", (t) => {
	const fixture = makeFixture(t);
	const before = digestOf(t, fixture);

	const cargoHome = path.join(fixture.root, "scoped-cargo-home");
	mkdirSync(cargoHome, { recursive: true });
	writeFileSync(
		path.join(cargoHome, "config.toml"),
		"[net]\noffline = true\n"
	);

	const withHome = digestOf(t, fixture, undefined, { CARGO_HOME: cargoHome });
	t.not(withHome, before, "a CARGO_HOME config must invalidate");

	writeFileSync(
		path.join(cargoHome, "config.toml"),
		"[net]\noffline = false\n"
	);
	t.not(
		digestOf(t, fixture, undefined, { CARGO_HOME: cargoHome }),
		withHome,
		"its contents must invalidate too"
	);
});

/**
 * The closure is the whole tree, so members outside the wasm crate's dependency
 * graph and files previously argued to be irrelevant are all covered. This is
 * deliberate over-invalidation: workspace feature unification and lockfile
 * resolution make "not in the closure" an unsafe reason to exclude something.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh covers the whole tree conservatively", (t) => {
	const fixture = makeFixture(t);
	const baseline = digestOf(t, fixture);

	const conservative = [
		["native/src/main.rs", "fn main() { /* another workspace member */ }\n"],
		["rustfmt.toml", "hard_tabs = false\n"],
		["native/tests/0-sanity.js", "// a fixture used by another member\n"],
		["wasm/build.sh", null],
		["wasm/hash-inputs.sh", null],
	];

	const seen = new Map([[baseline, "baseline"]]);
	for (const [relative, contents] of conservative) {
		const target = path.join(fixture.rewriterDir, relative);
		const original = readFileSync(target);
		writeFileSync(
			target,
			contents === null ? `${original.toString("utf8")}\n# appended\n` : contents
		);
		const digest = digestOf(t, fixture);
		t.not(digest, baseline, `${relative} must invalidate the fingerprint`);
		t.false(seen.has(digest), `${relative} collided with ${seen.get(digest)}`);
		seen.set(digest, relative);
		writeFileSync(target, original);
	}

	t.is(digestOf(t, fixture), baseline, "restoring every input restores the digest");
});

/**
 * Hashing both scripts is what actually covers the wasm-bindgen argument
 * vector, the sed post-processing and the order of the steps. None of those
 * were ever expressible as policy records, so the earlier claim that sharing
 * the argv arrays made the policy drift-proof was wrong.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh covers build.sh and itself", (t) => {
	const fixture = makeFixture(t);
	const baseline = digestOf(t, fixture);

	// A change that no policy record could have represented: the wasm-bindgen
	// invocation itself.
	const buildSh = path.join(fixture.wasmDir, "build.sh");
	const buildShText = readFileSync(buildSh, "utf8");
	t.true(
		buildShText.includes("wasm-bindgen --target web --out-dir out/"),
		"precondition: build.sh invokes wasm-bindgen this way"
	);
	writeFileSync(
		buildSh,
		buildShText.replace(
			"wasm-bindgen --target web --out-dir out/",
			"wasm-bindgen --target bundler --out-dir out/"
		)
	);
	const withBindgenChange = digestOf(t, fixture);
	t.not(withBindgenChange, baseline, "the wasm-bindgen argv must be covered");
	writeFileSync(buildSh, buildShText);
	t.is(digestOf(t, fixture), baseline);

	const hashSh = path.join(fixture.wasmDir, "hash-inputs.sh");
	const hashShText = readFileSync(hashSh, "utf8");
	writeFileSync(hashSh, `${hashShText}\n# a change to the helper itself\n`);
	t.not(digestOf(t, fixture), baseline, "the helper must cover itself");
	writeFileSync(hashSh, hashShText);
	t.is(digestOf(t, fixture), baseline);
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh invalidates on every real build input", (t) => {
	const fixture = makeFixture(t);
	const baseline = digestOf(t, fixture);

	const mutations = [
		["js/src/lib.rs", "// a rust source edit\n"],
		["wasm/src/lib.rs", "// a rust source edit\n"],
		["transform/src/transform.rs", "// a rust source edit\n"],
		["coverage-macro/src/lib.rs", "// a rust source edit\n"],
		["Cargo.lock", "# a lockfile edit\n"],
		["Cargo.toml", '[workspace]\nmembers = []\n'],
		["wasm/Cargo.toml", '[package]\nname = "wasm"\n'],
		["js/Cargo.toml", '[package]\nname = "js"\n'],
		["rust-toolchain.toml", '[toolchain]\nchannel = "stable"\n'],
	];

	const seen = new Map([[baseline, "baseline"]]);
	for (const [relative, contents] of mutations) {
		const target = path.join(fixture.rewriterDir, relative);
		const original = readFileSync(target);
		writeFileSync(target, contents);
		const digest = digestOf(t, fixture);
		t.not(digest, baseline, `${relative} must invalidate the fingerprint`);
		t.false(seen.has(digest), `${relative} collided with ${seen.get(digest)}`);
		seen.set(digest, relative);
		writeFileSync(target, original);
	}

	t.is(digestOf(t, fixture), baseline);
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh counts newly added source files", (t) => {
	const fixture = makeFixture(t);
	const before = digestOf(t, fixture);
	const added = path.join(fixture.rewriterDir, "js", "src", "extra_module.rs");
	writeFileSync(added, "pub fn extra() {}\n");
	t.not(digestOf(t, fixture), before);
	rmSync(added);
	t.is(digestOf(t, fixture), before);
});

/**
 * Source paths are enumerated with `find -print0` and hex encoded into the
 * canonical listing, so spaces, quotes, dollar signs and newlines are all legal
 * and none of them can disturb the record framing.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh handles source paths with shell metacharacters", (t) => {
	const fixture = makeFixture(t);
	const before = digestOf(t, fixture);

	const awkward = path.join(
		fixture.rewriterDir,
		"js",
		"src",
		"we ird 'n$(dangerous) [name].rs"
	);
	writeFileSync(awkward, "pub fn awkward() {}\n");

	const withAwkward = digestOf(t, fixture);
	t.not(withAwkward, before);
	t.is(digestOf(t, fixture), withAwkward, "still deterministic");

	writeFileSync(awkward, "pub fn awkward() { /* changed */ }\n");
	t.not(digestOf(t, fixture), withAwkward, "content, not just existence");
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh is fatal when a required input is missing", (t) => {
	const fixture = makeFixture(t);
	rmSync(path.join(fixture.rewriterDir, "Cargo.lock"));
	const result = runHash(fixture);
	t.not(result.status, 0, "a missing build input must be fatal");
	t.regex(result.stderr, /required build input is missing: Cargo\.lock/);
	t.is(result.stdout.trim(), "", "no digest may be printed on failure");
});

/**
 * Length prefixed framing means adjacent policy records cannot be merged into
 * one another, which naive concatenation would allow.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh framing keeps policy records injective", (t) => {
	const fixture = makeFixture(t);
	t.not(digestOf(t, fixture, ["P=a", "P=b"]), digestOf(t, fixture, ["P=ab"]));
	t.not(
		digestOf(t, fixture, ["A=1", "B=2"]),
		digestOf(t, fixture, ["B=2", "A=1"]),
		"policy order is part of the fingerprint"
	);
});

// ==========================================================================
// unsupported layouts are refused, not silently under-covered
// ==========================================================================

/**
 * `find -type f` skips symlinks entirely, so one pointing outside the tree
 * would be an input the digest never saw.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh refuses a source tree containing a symlink", (t) => {
	const fixture = makeFixture(t);
	digestOf(t, fixture);
	spawnSync("ln", [
		"-s",
		"/etc/hosts",
		path.join(fixture.rewriterDir, "js", "src", "escaped.rs"),
	]);
	const result = runHash(fixture);
	t.not(result.status, 0);
	t.regex(result.stderr, /symlink/);
	t.is(result.stdout.trim(), "", "no digest may be printed");
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh refuses a path dependency outside the tree", (t) => {
	const fixture = makeFixture(t);
	const manifest = path.join(fixture.rewriterDir, "js", "Cargo.toml");
	const original = readFileSync(manifest, "utf8");

	for (const escaping of ["../../../outside-crate", "/opt/elsewhere"]) {
		writeFileSync(
			manifest,
			`${original}\noutside = { version = "0.1.0", path = "${escaping}" }\n`
		);
		const result = runHash(fixture);
		t.not(result.status, 0, `${escaping} must be refused`);
		t.regex(result.stderr, /path dependency/);
		t.is(result.stdout.trim(), "");
	}

	writeFileSync(manifest, original);
	// The in-tree path dependencies this workspace really uses must still pass.
	t.regex(original, /path = "\.\.\/transform"/);
	t.regex(digestOf(t, fixture), SHA256_RE);
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh refuses an include that leaves the tree", (t) => {
	const fixture = makeFixture(t);
	const source = path.join(fixture.rewriterDir, "js", "src", "lib.rs");
	const original = readFileSync(source, "utf8");

	writeFileSync(
		source,
		`${original}\nconst X: &str = include_str!("../../../../outside.txt");\n`
	);
	let result = runHash(fixture);
	t.not(result.status, 0, "an escaping include must be refused");
	t.regex(result.stderr, /resolves outside --root/);

	writeFileSync(
		source,
		`${original}\ninclude!(concat!(env!("OUT_DIR"), "/generated.rs"));\n`
	);
	result = runHash(fixture);
	t.not(result.status, 0, "a non-literal include path must be refused");
	t.regex(result.stderr, /cannot resolve \(not a plain string literal\)/);

	writeFileSync(source, original);
	t.regex(digestOf(t, fixture), SHA256_RE);
});

/**
 * The tree really does contain `include_str!("../sample/google.js")` in
 * `native/src/test_runner.rs`. A rejection rule that fired on it would break
 * every build, so the accepted case is pinned too.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh accepts a relative include that stays in the tree", (t) => {
	const fixture = makeFixture(t);
	const real = path.join(fixture.rewriterDir, "native", "src", "test_runner.rs");
	t.regex(
		readFileSync(real, "utf8"),
		/include_str!\("\.\.\/sample\/google\.js"\)/,
		"precondition: the real tree has an in-tree relative include"
	);
	const baseline = digestOf(t, fixture);

	const source = path.join(fixture.rewriterDir, "js", "src", "lib.rs");
	const original = readFileSync(source, "utf8");
	writeFileSync(
		source,
		`${original}\nconst Y: &str = include_str!("../Cargo.toml");\n`
	);
	const result = runHash(fixture);
	t.is(result.status, 0, `an in-tree include must be accepted: ${result.stderr}`);
	t.not(result.stdout.trim(), baseline);
	writeFileSync(source, original);
});

/**
 * Reading the enumeration from a process substitution discarded `find`'s exit
 * status: a walk that printed some paths and then failed produced a short list
 * that still looked like a complete, valid digest.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh refuses a find that fails after emitting a path", (t) => {
	const fixture = makeFixture(t);
	t.regex(digestOf(t, fixture), SHA256_RE, "healthy before the stub is installed");

	installFailingFind(fixture);
	const result = runHash(fixture);
	t.not(result.status, 0, "a failed enumeration must not produce a digest");
	t.regex(result.stderr, /find exited non-zero/);
	t.is(result.stdout.trim(), "", "no digest may be printed");
});

// ==========================================================================
// build.sh: the happy path and the receipt
// ==========================================================================

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh completes, produces every output and publishes a receipt", (t) => {
	const fixture = makeFixture(t);
	const result = runBuild(fixture, { RELEASE: "1" });
	t.is(result.status, 0, `build.sh failed: ${result.stderr}`);
	t.regex(result.stdout, /Rewriter Build Complete!/);

	for (const relative of EXPECTED_OUTPUTS) {
		const produced = path.join(fixture.coreDir, relative);
		t.true(existsSync(produced), `missing output ${relative}`);
		t.true(readFileSync(produced).length > 0, `empty output ${relative}`);
	}

	const receipt = readFileSync(fixture.receiptFile, "utf8").split("\n");
	t.is(receipt[0], "scramjet-rewriter-receipt/1");
	t.regex(receipt[1], /^I [0-9a-f]{64}$/);

	// The retired single-hash record must not be left behind alongside it.
	t.false(existsSync(fixture.legacyHashFile));

	const log = toolLog(fixture);
	t.true(cargoCompiled(fixture));
	t.true(log.some((line) => line.startsWith("rustc +nightly -vV")));
	t.true(log.some((line) => line.startsWith("wasm-bindgen --target web")));
	t.true(log.some((line) => line.startsWith("wasm-snip ")));
	t.true(log.some((line) => line.includes("--converge")), "wasm-opt ran in release mode");

	const glue = readFileSync(path.join(fixture.outDir, "wasm.js"), "utf8");
	t.false(glue.includes("import.meta.url"), "the sed step rewrote the glue");
});

/**
 * The six-file list build.sh checks explicitly cannot name the snippets
 * directory, because wasm-bindgen puts a content hash in its name. The receipt
 * enumerates the tree instead, so the snippet is bound too.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("the receipt binds the wasm-bindgen snippet tree", (t) => {
	const fixture = makeFixture(t);
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);

	const glue = readFileSync(path.join(fixture.outDir, "wasm.js"), "utf8");
	t.true(
		glue.includes(`from './${SNIPPET_REL}'`),
		"precondition: the glue imports the snippet, as the real wasm-bindgen output does"
	);
	t.true(existsSync(fixture.snippetFile), "the snippet exists on disk");

	const bound = receiptPaths(fixture);
	t.true(
		bound.includes(`rewriter/wasm/out/${SNIPPET_REL}`),
		`the receipt must bind the snippet; it bound ${JSON.stringify(bound)}`
	);
	t.true(bound.includes("dist/scramjet.wasm"));
	t.false(
		bound.includes("rewriter/wasm/out/.build-receipt"),
		"the receipt must not describe itself"
	);
});

/**
 * The exact hole the previous gate had: every named file was present and
 * non-empty, so deleting the snippet the glue imports still looked fresh.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh rebuilds when a generated snippet is deleted", (t) => {
	const fixture = makeFixture(t);
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);

	rmSync(fixture.snippetFile);
	for (const relative of EXPECTED_OUTPUTS) {
		t.true(
			existsSync(path.join(fixture.coreDir, relative)),
			"every explicitly named output is still present and non-empty"
		);
	}

	writeFileSync(fixture.logPath, "");
	const second = runBuild(fixture, { RELEASE: "1" });
	t.is(second.status, 0, second.stderr);
	t.notRegex(second.stdout, /skipping rebuild/, "a missing snippet must not skip");
	t.true(cargoCompiled(fixture));
	t.true(existsSync(fixture.snippetFile), "the rebuild restored it");
});

/**
 * Non-emptiness accepts a replaced or corrupted file. Digests do not.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh rebuilds when a generated output's content changes", (t) => {
	const fixture = makeFixture(t);
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);

	const swapped = path.join(fixture.coreDir, "dist", "scramjet.wasm");
	writeFileSync(swapped, "a different, still non-empty, wasm\n");

	writeFileSync(fixture.logPath, "");
	const second = runBuild(fixture, { RELEASE: "1" });
	t.is(second.status, 0, second.stderr);
	t.notRegex(second.stdout, /skipping rebuild/);
	t.true(cargoCompiled(fixture), "a replaced artifact must not be accepted");
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh skips a rebuild when nothing relevant changed", (t) => {
	const fixture = makeFixture(t);
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);
	const receipt = readFileSync(fixture.receiptFile, "utf8");

	writeFileSync(fixture.logPath, "");
	const second = runBuild(fixture, { RELEASE: "1" });
	t.is(second.status, 0, second.stderr);
	t.regex(second.stdout, /skipping rebuild/);
	t.false(cargoCompiled(fixture), "a skip must not recompile");
	t.is(readFileSync(fixture.receiptFile, "utf8"), receipt, "receipt unchanged");
});

/**
 * The regression test for the self-invalidating gate: a real build rewrites
 * `target/` fingerprints and `wasm/out/`, and that alone used to change the
 * hash and force an unconditional rebuild forever.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh still skips after its own target churn", (t) => {
	const fixture = makeFixture(t);
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);

	writeFileSync(
		path.join(
			fixture.rewriterDir,
			"target/release/build/stub-0000000000000000/fingerprint/lib-stub.json"
		),
		'{"rustc":"a completely different value"}\n'
	);

	writeFileSync(fixture.logPath, "");
	const second = runBuild(fixture, { RELEASE: "1" });
	t.is(second.status, 0, second.stderr);
	t.regex(second.stdout, /skipping rebuild/);
	t.false(cargoCompiled(fixture));
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh rebuilds after a rust source edit", (t) => {
	const fixture = makeFixture(t);
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);
	const firstReceipt = readFileSync(fixture.receiptFile, "utf8");

	const source = path.join(fixture.rewriterDir, "js", "src", "lib.rs");
	writeFileSync(source, `${readFileSync(source, "utf8")}\n// edited\n`);

	writeFileSync(fixture.logPath, "");
	const second = runBuild(fixture, { RELEASE: "1" });
	t.is(second.status, 0, second.stderr);
	t.true(cargoCompiled(fixture), "a source edit must recompile");
	t.not(readFileSync(fixture.receiptFile, "utf8"), firstReceipt);
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh rebuilds after a tool version change", (t) => {
	const fixture = makeFixture(t);
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);

	writeFileSync(fixture.logPath, "");
	const second = runBuild(fixture, {
		RELEASE: "1",
		STUB_WASM_OPT_VERSION: "wasm-opt version 133 (version_133)",
	});
	t.is(second.status, 0, second.stderr);
	t.true(cargoCompiled(fixture), "a wasm-opt upgrade changes the output bytes");
});

/**
 * `cargo --version` identifies cargo, not the compiler. A nightly bump or a
 * rebuilt LLVM can sit behind one cargo version and emit different bytes, so
 * the compiler identity has to be probed separately.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh rebuilds when only the compiler identity changes", (t) => {
	const fixture = makeFixture(t);
	const pinnedCargo = "cargo 1.100.0-nightly (stub0000000 2026-09-11)";
	t.is(
		runBuild(fixture, { RELEASE: "1", STUB_CARGO_VERSION: pinnedCargo }).status,
		0
	);

	writeFileSync(fixture.logPath, "");
	const second = runBuild(fixture, {
		RELEASE: "1",
		// Same cargo, different rustc: a new commit hash and a new LLVM.
		STUB_CARGO_VERSION: pinnedCargo,
		STUB_RUSTC_IDENTITY: [
			"rustc 1.100.0-nightly (ffffffff 2026-09-20)",
			"binary: rustc",
			"commit-hash: ffffffff00000000000000000000000000000000",
			"commit-date: 2026-09-20",
			"host: aarch64-apple-darwin",
			"release: 1.100.0-nightly",
			"LLVM version: 21.1.2",
			"",
		].join("\n"),
	});
	t.is(second.status, 0, second.stderr);
	t.true(
		toolLog(fixture).some((line) =>
			line.includes(`cargo +nightly --version`)
		),
		"cargo was still probed"
	);
	t.true(
		cargoCompiled(fixture),
		"an unchanged cargo version must not mask a changed compiler"
	);
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh fingerprints the build mode", (t) => {
	const fixture = makeFixture(t);
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);

	writeFileSync(fixture.logPath, "");
	const debug = runBuild(fixture, {});
	t.is(debug.status, 0, debug.stderr);
	t.true(cargoCompiled(fixture), "a mode change must recompile");
	t.false(
		toolLog(fixture).some((line) => line.includes("--converge")),
		"a debug build copies instead of running the wasm-opt pass chain"
	);
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh fingerprint is independent of the checkout path", (t) => {
	const first = makeFixture(t);
	const second = makeFixture(t);
	t.not(first.rewriterDir, second.rewriterDir);
	t.is(runBuild(first, { RELEASE: "1" }).status, 0);
	t.is(runBuild(second, { RELEASE: "1" }).status, 0);
	const line = (f) => readFileSync(f.receiptFile, "utf8").split("\n")[1];
	t.is(line(first), line(second));
});

// ==========================================================================
// build.sh: failure propagation
// ==========================================================================

/**
 * The build pipeline, in order, identified by a marker that appears in the stub
 * invocation log only for the real step, not for a `--version` probe.
 */
const PIPELINE = [
	["cargo", "cargo +nightly build"],
	["wasm-bindgen", "wasm-bindgen --target web"],
	["wasm-snip", "wasm-snip rewriter/wasm/out/wasm_bg.wasm"],
	["wasm-opt", "--converge"],
];

for (const [index, [tool]] of PIPELINE.entries()) {
	/**
	 * Asserts more than a non-zero exit: the pipeline has to stop at the failing
	 * step. Without that, a swallowed failure would still look like a pass here,
	 * because the next stub would refuse a missing input and fail for its own
	 * reasons.
	 * @param {import("ava").ExecutionContext} t - AVA unit test context.
	 */
	test.serial(`build.sh fails closed when ${tool} fails`, (t) => {
		const fixture = makeFixture(t);
		const result = runBuild(fixture, { RELEASE: "1", STUB_FAIL: tool });

		t.not(result.status, 0, `a ${tool} failure must fail the build`);
		t.regex(result.stderr, new RegExp(tool));
		t.false(existsSync(fixture.receiptFile), "no receipt may be published");
		t.false(existsSync(fixture.distWasm), "no artifact may be published");
		t.false(result.stdout.includes("Rewriter Build Complete!"));

		const log = toolLog(fixture);
		t.true(
			log.some((line) => line.includes(PIPELINE[index][1])),
			`the ${tool} step should have been reached`
		);
		for (const [later, marker] of PIPELINE.slice(index + 1)) {
			t.false(
				log.some((line) => line.includes(marker)),
				`${later} must not run after ${tool} failed`
			);
		}
	});
}

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh removes a stale receipt before rebuilding", (t) => {
	const fixture = makeFixture(t);
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);
	t.true(existsSync(fixture.receiptFile));

	const source = path.join(fixture.rewriterDir, "js", "src", "lib.rs");
	writeFileSync(source, `${readFileSync(source, "utf8")}\n// edited\n`);

	const failed = runBuild(fixture, { RELEASE: "1", STUB_FAIL: "cargo" });
	t.not(failed.status, 0);
	t.false(
		existsSync(fixture.receiptFile),
		"the previous receipt must not survive a failed rebuild"
	);
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh refuses to claim freshness when inputs change mid-build", (t) => {
	const fixture = makeFixture(t);
	const edited = path.join(fixture.rewriterDir, "js", "src", "rewrite.rs");
	const before = readFileSync(edited, "utf8");

	const result = runBuild(fixture, {
		RELEASE: "1",
		STUB_MUTATE_DURING_BUILD: edited,
	});

	t.not(result.status, 0, "a mid-build input change must not report success");
	t.regex(result.stderr, /inputs changed while the build was running/);
	t.false(existsSync(fixture.receiptFile), "no receipt may be published");
	t.false(result.stdout.includes("Rewriter Build Complete!"));

	t.is(
		readFileSync(edited, "utf8"),
		`${before}// touched while cargo was running\n`,
		"build.sh must never revert or overwrite a concurrent writer's edit"
	);
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh is fatal when a required build input is missing", (t) => {
	const fixture = makeFixture(t);
	rmSync(path.join(fixture.rewriterDir, "Cargo.lock"));
	const result = runBuild(fixture, { RELEASE: "1" });
	t.not(result.status, 0);
	t.regex(result.stderr, /required build input is missing: Cargo\.lock/);
	t.regex(result.stderr, /could not fingerprint the rewriter build inputs/);
	t.false(cargoCompiled(fixture), "nothing may be compiled without a fingerprint");
	t.false(existsSync(fixture.receiptFile));
});

/**
 * A failed enumeration must not be launderable into a skip: the receipt from a
 * previous good build is present, and the run must still fail.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh does not turn a failed enumeration into a skip", (t) => {
	const fixture = makeFixture(t);
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);
	const receipt = readFileSync(fixture.receiptFile, "utf8");

	installFailingFind(fixture);
	writeFileSync(fixture.logPath, "");
	const result = runBuild(fixture, { RELEASE: "1" });

	t.not(result.status, 0, "a failed enumeration must fail the run");
	t.regex(result.stderr, /find exited non-zero/);
	t.notRegex(result.stdout, /skipping rebuild/, "and must not be reported as fresh");
	t.false(cargoCompiled(fixture));
	t.is(
		readFileSync(fixture.receiptFile, "utf8"),
		receipt,
		"the existing receipt is left untouched, not replaced by an unverified one"
	);
});

// ==========================================================================
// build.sh: the toolchain and environment gate
// ==========================================================================

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh reports every missing tool and builds nothing", (t) => {
	const fixture = makeFixture(t);
	const result = runBuild(fixture, { RELEASE: "1" }, { bareBin: true });
	t.not(result.status, 0);
	t.regex(result.stderr, /Please install cargo, wasm-bindgen, wasm-opt/);
	for (const tool of ["cargo", "rustc", "wasm-snip"]) {
		t.regex(result.stderr, new RegExp(`missing required tools:.*${tool}`));
	}
	t.false(existsSync(fixture.receiptFile));
	t.false(existsSync(fixture.distWasm));
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh rejects the wrong wasm-bindgen version", (t) => {
	const fixture = makeFixture(t);
	const result = runBuild(fixture, {
		RELEASE: "1",
		STUB_WASM_BINDGEN_VERSION: "wasm-bindgen 0.2.100",
	});
	t.not(result.status, 0);
	t.regex(result.stderr, /Incorrect wasm-bindgen-cli version/);
	t.false(cargoCompiled(fixture));
});

/**
 * The check is a prefix match, exactly as it was before this change, so a
 * version line carrying extra build metadata is still accepted. Pinned so the
 * rewrite is not silently stricter than the original.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh accepts the required wasm-bindgen version with a suffix", (t) => {
	const fixture = makeFixture(t);
	const result = runBuild(fixture, {
		RELEASE: "1",
		STUB_WASM_BINDGEN_VERSION: "wasm-bindgen 0.2.105 (extra build metadata)",
	});
	t.is(result.status, 0, result.stderr);
});

/**
 * `+toolchain` selection is a rustup feature. A Homebrew or distribution build
 * earlier on PATH rejects it, which is a PATH ordering problem and has to say
 * so -- for both cargo and rustc.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
for (const [label, env] of [
	["cargo", { STUB_CARGO_NO_PLUS_TOOLCHAIN: "1" }],
	["rustc", { STUB_RUSTC_NO_PLUS_TOOLCHAIN: "1" }],
]) {
	test.serial(`build.sh explains a ${label} that cannot select +nightly`, (t) => {
		const fixture = makeFixture(t);
		const result = runBuild(fixture, { RELEASE: "1", ...env });
		t.not(result.status, 0);
		t.regex(result.stderr, /rustup/);
		t.regex(result.stderr, /PATH/);
		t.false(cargoCompiled(fixture));
		t.false(existsSync(fixture.receiptFile));
	});
}

/**
 * A tool that exits zero but prints nothing must not silently contribute an
 * empty string to the fingerprint.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
for (const [label, env] of [
	["wasm-opt version", { STUB_WASM_OPT_VERSION: "" }],
	["rustc identity", { STUB_RUSTC_IDENTITY: "" }],
]) {
	test.serial(`build.sh rejects an empty ${label}`, (t) => {
		const fixture = makeFixture(t);
		const result = runBuild(fixture, { RELEASE: "1", ...env });
		t.not(result.status, 0);
		t.regex(result.stderr, /produced no output/);
		t.false(existsSync(fixture.receiptFile));
	});
}

/**
 * cargo reads CARGO_ENCODED_RUSTFLAGS in preference to RUSTFLAGS. Left alone,
 * the RUSTFLAGS this script sets would be silently ignored while the
 * fingerprint went on recording them as the flags in effect. Refusing is the
 * documented choice; the alternative would be to fingerprint the override.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh refuses an inherited CARGO_ENCODED_RUSTFLAGS", (t) => {
	const fixture = makeFixture(t);

	// Set, including the empty value, which still overrides RUSTFLAGS.
	for (const value of ["-Cpanic\u001fabort", ""]) {
		const blocked = runBuild(fixture, {
			RELEASE: "1",
			CARGO_ENCODED_RUSTFLAGS: value,
		});
		t.not(blocked.status, 0, `value ${JSON.stringify(value)} must be refused`);
		t.regex(blocked.stderr, /CARGO_ENCODED_RUSTFLAGS is set/);
		t.regex(blocked.stderr, /takes precedence over the RUSTFLAGS/);
		t.false(cargoCompiled(fixture), "nothing may be compiled under it");
		t.false(existsSync(fixture.receiptFile));
	}

	// Unset: the same fixture now builds, so the refusal is the only difference.
	const allowed = runBuild(fixture, { RELEASE: "1" });
	t.is(allowed.status, 0, allowed.stderr);
	t.true(existsSync(fixture.receiptFile));
});

/**
 * These replace or wrap the compiler, so the identity `rustc +nightly -vV`
 * reports would not describe the compiler that actually produced the artifact.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh refuses compiler substitution and wrappers", (t) => {
	const fixture = makeFixture(t);
	for (const name of [
		"RUSTC",
		"RUSTC_WRAPPER",
		"RUSTC_WORKSPACE_WRAPPER",
		"CARGO_BUILD_RUSTC",
		"CARGO_BUILD_RUSTC_WRAPPER",
		"CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
	]) {
		const result = runBuild(fixture, { RELEASE: "1", [name]: "/usr/bin/true" });
		t.not(result.status, 0, `${name} must be refused`);
		t.regex(result.stderr, new RegExp(`${name} is set`));
		t.regex(result.stderr, /rustc identity/);
		t.false(existsSync(fixture.receiptFile));
	}
});

/**
 * build.sh reads `../target/<triple>/release/wasm.wasm` by construction, so
 * honouring a relocated target directory would take more than an environment
 * variable. Pretending to support it would produce a confusing failure deep in
 * wasm-bindgen instead.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh refuses a relocated CARGO_TARGET_DIR", (t) => {
	const fixture = makeFixture(t);
	const result = runBuild(fixture, {
		RELEASE: "1",
		CARGO_TARGET_DIR: path.join(fixture.root, "elsewhere"),
	});
	t.not(result.status, 0);
	t.regex(result.stderr, /CARGO_TARGET_DIR is set/);
	t.regex(result.stderr, /does not support a relocated target directory/);
	t.false(cargoCompiled(fixture));
	t.false(existsSync(fixture.receiptFile));
});

// ==========================================================================
// portability: a checkout path is data, not a pattern
// ==========================================================================

/**
 * `-path "$ROOT/target"` fails OPEN when the root contains `[`, `*` or `?`: the
 * prune stops matching and `target/` re-enters the fingerprint, which is the
 * self-invalidating defect all over again.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh prunes generated output under a metacharacter root", (t) => {
	const fixture = makeFixture(t, { awkwardRoot: true });
	t.regex(fixture.rewriterDir, /we\[i\]rd\*root\?dir/, "the fixture really is awkward");
	const before = digestOf(t, fixture);

	for (const file of [
		path.join(fixture.rewriterDir, "target/release/build/x/fingerprint/lib.json"),
		path.join(fixture.outDir, "optimized.wasm"),
		path.join(fixture.outDir, SNIPPET_REL),
	]) {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, "generated, must stay out of the fingerprint\n");
	}

	t.is(digestOf(t, fixture), before, "the prune must still hold");
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh builds and skips under a metacharacter root", (t) => {
	const fixture = makeFixture(t, { awkwardRoot: true });
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);
	writeFileSync(fixture.logPath, "");
	const second = runBuild(fixture, { RELEASE: "1" });
	t.is(second.status, 0, second.stderr);
	t.regex(second.stdout, /skipping rebuild/);
	t.false(cargoCompiled(fixture));
});

// ==========================================================================
// the reference screen: best effort, but honest about direction
// ==========================================================================

/**
 * Single quotes are legal TOML. Only the double-quoted form was screened.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh screens single-quoted TOML path dependencies", (t) => {
	const fixture = makeFixture(t);
	const manifest = path.join(fixture.rewriterDir, "js", "Cargo.toml");
	const original = readFileSync(manifest, "utf8");
	writeFileSync(
		manifest,
		`${original}\noutside = { version = "0.1.0", path = '../../../outside' }\n`
	);
	const result = runHash(fixture);
	t.not(result.status, 0);
	t.regex(result.stderr, /path dependency/);
	writeFileSync(manifest, original);
});

/**
 * Counting matching LINES let a literal use on the same line mask a
 * non-literal one. Occurrences are counted now.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh screens two includes sharing one line", (t) => {
	const fixture = makeFixture(t);
	const source = path.join(fixture.rewriterDir, "js", "src", "lib.rs");
	const original = readFileSync(source, "utf8");
	writeFileSync(
		source,
		`${original}\nconst A: &str = include_str!("../Cargo.toml"); const B: &str = include_str!(concat!(env!("OUT_DIR"), "/x.rs"));\n`
	);
	const result = runHash(fixture);
	t.not(result.status, 0, "the non-literal use must not be masked");
	t.regex(result.stderr, /cannot resolve \(not a plain string literal\)/);
	writeFileSync(source, original);
});

/**
 * The converse: a perfectly legal include split across lines must not be
 * refused. Flattening before counting is what makes both cases work.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh accepts an include split across lines", (t) => {
	const fixture = makeFixture(t);
	const baseline = digestOf(t, fixture);
	const source = path.join(fixture.rewriterDir, "js", "src", "lib.rs");
	const original = readFileSync(source, "utf8");
	writeFileSync(
		source,
		`${original}\nconst C: &str = include_str!(\n    "../Cargo.toml"\n);\n`
	);
	const result = runHash(fixture);
	t.is(result.status, 0, `a multi-line literal must be accepted: ${result.stderr}`);
	t.not(result.stdout.trim(), baseline);
	writeFileSync(source, original);
});

/**
 * `#[path]` relocates a module's file and can point anywhere.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh screens a #[path] leaving the tree", (t) => {
	const fixture = makeFixture(t);
	const source = path.join(fixture.rewriterDir, "js", "src", "lib.rs");
	const original = readFileSync(source, "utf8");

	writeFileSync(source, `${original}\n#[path = "../../../../elsewhere/m.rs"]\nmod m;\n`);
	let result = runHash(fixture);
	t.not(result.status, 0);
	t.regex(result.stderr, /#\[path\]/);

	// An in-tree #[path] must still be accepted.
	writeFileSync(source, `${original}\n#[path = "cfg.rs"]\nmod aliased;\n`);
	result = runHash(fixture);
	t.is(result.status, 0, `an in-tree #[path] must be accepted: ${result.stderr}`);
	writeFileSync(source, original);
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh refuses to write its listing inside the hashed tree", (t) => {
	const fixture = makeFixture(t);
	const inside = path.join(fixture.rewriterDir, "listing.txt");
	const result = spawnSync(
		BASH,
		[
			path.join(fixture.wasmDir, "hash-inputs.sh"),
			"--root", fixture.rewriterDir,
			"--listing", inside,
			"--policy", "MODE=release",
		],
		{ encoding: "utf8", env: { PATH: SYSTEM_PATH, HOME: fixture.root } }
	);
	t.not(result.status, 0);
	t.regex(result.stderr, /--listing points inside --root/);
	t.false(existsSync(inside), "and nothing was written there");
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh refuses a REWRITER_HASH_LISTING inside the hashed tree", (t) => {
	const fixture = makeFixture(t);
	const result = runBuild(fixture, {
		RELEASE: "1",
		REWRITER_HASH_LISTING: path.join(fixture.rewriterDir, "listing.txt"),
	});
	t.not(result.status, 0);
	t.regex(result.stderr, /--listing points inside --root/);
	t.false(existsSync(fixture.receiptFile));
});

// ==========================================================================
// dynamic compile-time inputs
// ==========================================================================

/**
 * THE current-tree staleness bug. `coverage-macro` is a proc-macro;
 * `locate_visitor_rs()` returns $COVERAGE_VISITOR_FILE when set and the macro
 * reads that path with std::fs at expansion time. A proc-macro's own reads are
 * recorded in neither the hashed tree nor cargo's dep-info, so the artifact
 * would depend on a file nothing fingerprinted.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh refuses COVERAGE_VISITOR_FILE", (t) => {
	const fixture = makeFixture(t);

	// Confirm the mechanism still exists in the tree under test, so this test
	// cannot quietly become vacuous if the macro is refactored.
	const macro = readFileSync(
		path.join(fixture.rewriterDir, "coverage-macro", "src", "helper_index.rs"),
		"utf8"
	);
	t.regex(macro, /COVERAGE_VISITOR_FILE/, "precondition: the env hook exists");
	t.regex(macro, /read_to_string/, "precondition: it is read from disk");

	const external = path.join(fixture.root, "external-visitor.rs");
	writeFileSync(external, "// outside every hashed tree\n");

	// Set, and set-but-empty: both override the in-tree default.
	for (const value of [external, ""]) {
		const blocked = runBuild(fixture, {
			RELEASE: "1",
			COVERAGE_VISITOR_FILE: value,
		});
		t.not(blocked.status, 0, `value ${JSON.stringify(value)} must be refused`);
		t.regex(blocked.stderr, /COVERAGE_VISITOR_FILE is set/);
		t.regex(blocked.stderr, /proc-macro/);
		t.false(cargoCompiled(fixture), "nothing may be compiled under it");
		t.false(existsSync(fixture.receiptFile));
	}

	// Unset, the same fixture builds: the refusal is the only difference.
	const allowed = runBuild(fixture, { RELEASE: "1" });
	t.is(allowed.status, 0, allowed.stderr);
	t.true(existsSync(fixture.receiptFile));
});

/**
 * A build script's own inputs cannot be fingerprinted from the tree, so the
 * cache is switched off rather than assumed hermetic.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh publishes no receipt while a build script is present", (t) => {
	const fixture = makeFixture(t);
	writeFileSync(
		path.join(fixture.rewriterDir, "wasm", "build.rs"),
		'fn main() { println!("cargo:rustc-cfg=whatever"); }\n'
	);

	const first = runBuild(fixture, { RELEASE: "1" });
	t.is(first.status, 0, `the build itself must still succeed: ${first.stderr}`);
	t.regex(first.stdout, /no freshness receipt/);
	t.regex(first.stderr, /build script/);
	t.false(existsSync(fixture.receiptFile), "no receipt may be published");
	t.true(existsSync(fixture.distWasm), "but the artifact is produced");

	// With no receipt there is nothing to skip on.
	writeFileSync(fixture.logPath, "");
	const second = runBuild(fixture, { RELEASE: "1" });
	t.is(second.status, 0, second.stderr);
	t.true(cargoCompiled(fixture), "the next run must rebuild");
});

/**
 * Cargo's dep-info is what the compiler actually read, unlike the text screen.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh refuses a receipt when dep-info names an uncovered file", (t) => {
	const fixture = makeFixture(t);
	const outside = path.join(fixture.root, "outside-input.rs");
	writeFileSync(outside, "// read by the compiler, covered by nothing\n");

	const result = runBuild(fixture, {
		RELEASE: "1",
		STUB_DEP_INFO_EXTRA: outside,
	});
	t.not(result.status, 0);
	t.regex(result.stderr, /compiler read files that this fingerprint does not cover/);
	t.regex(result.stderr, new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	t.false(existsSync(fixture.receiptFile));

	// Without the extra dependency the same fixture builds.
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);
	t.true(existsSync(fixture.receiptFile));
});

// ==========================================================================
// environment and configuration that would make the record untrue
// ==========================================================================

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh refuses a relocated CARGO_BUILD_TARGET_DIR", (t) => {
	const fixture = makeFixture(t);
	const result = runBuild(fixture, {
		RELEASE: "1",
		CARGO_BUILD_TARGET_DIR: path.join(fixture.root, "elsewhere"),
	});
	t.not(result.status, 0);
	t.regex(result.stderr, /CARGO_BUILD_TARGET_DIR is set/);
	t.false(existsSync(fixture.receiptFile));
});

/**
 * These change what cargo builds. They are recorded rather than refused, so
 * setting one invalidates the cache instead of silently reusing an artifact
 * built without it.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
for (const [label, env] of [
	["CARGO_PROFILE_RELEASE_*", { CARGO_PROFILE_RELEASE_OPT_LEVEL: "1" }],
	["CARGO_UNSTABLE_*", { CARGO_UNSTABLE_BUILD_STD: "core" }],
	["COVERAGE_CHECK", { COVERAGE_CHECK: "error" }],
]) {
	test.serial(`build.sh invalidates the cache for ${label}`, (t) => {
		const fixture = makeFixture(t);
		t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);

		writeFileSync(fixture.logPath, "");
		const second = runBuild(fixture, { RELEASE: "1", ...env });
		t.is(second.status, 0, second.stderr);
		t.true(cargoCompiled(fixture), `${label} must not be silently stale`);

		// And back again: returning to the unset environment is itself a change.
		writeFileSync(fixture.logPath, "");
		const third = runBuild(fixture, { RELEASE: "1" });
		t.is(third.status, 0, third.stderr);
		t.true(cargoCompiled(fixture), "the unset transition must invalidate too");
	});
}

/**
 * A cargo config can substitute the compiler. The config file IS hashed, so the
 * fingerprint changes -- but the recorded rustc identity would still describe
 * the wrong compiler. Hashing makes the record change; it does not make it
 * true.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh refuses a cargo config that overrides the compiler", (t) => {
	const fixture = makeFixture(t);
	const config = path.join(fixture.coreDir, ".cargo", "config.toml");
	mkdirSync(path.dirname(config), { recursive: true });

	for (const key of ["rustc", "rustc-wrapper", "rustc-workspace-wrapper"]) {
		writeFileSync(config, `[build]\n${key} = "/usr/bin/true"\n`);
		const result = runBuild(fixture, { RELEASE: "1" });
		t.not(result.status, 0, `${key} must be refused`);
		t.regex(result.stderr, /sets a rustc override/);
		t.false(existsSync(fixture.receiptFile));
	}

	// A config without a compiler override is fine.
	writeFileSync(config, "[net]\noffline = true\n");
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);
});

// ==========================================================================
// receipt scratch state and stale generated output
// ==========================================================================

/**
 * A crash between writing the scratch receipt and renaming it leaves
 * `.build-receipt.tmp` behind. It must not break a legitimate skip, and it must
 * not survive a rebuild.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh tolerates and clears a leftover scratch receipt", (t) => {
	const fixture = makeFixture(t);
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);

	const scratch = `${fixture.receiptFile}.tmp`;
	writeFileSync(scratch, "truncated receipt from a crashed run\n");

	writeFileSync(fixture.logPath, "");
	const skipped = runBuild(fixture, { RELEASE: "1" });
	t.is(skipped.status, 0, skipped.stderr);
	t.regex(skipped.stdout, /skipping rebuild/, "the scratch file must not break a skip");
	t.false(cargoCompiled(fixture));

	// A SUCCEEDING rebuild consumes the scratch path anyway, because publishing
	// renames it into place -- so that case cannot distinguish invalidation from
	// the rename. The guarantee only bites when the rebuild FAILS: the stale
	// scratch must already be gone, and nothing may recreate it.
	const source = path.join(fixture.rewriterDir, "js", "src", "lib.rs");
	writeFileSync(source, `${readFileSync(source, "utf8")}\n// edited\n`);
	const failed = runBuild(fixture, { RELEASE: "1", STUB_FAIL: "cargo" });
	t.not(failed.status, 0, "precondition: this rebuild fails");
	t.false(
		existsSync(scratch),
		"invalidation must clear the scratch file before the build, not rely on the rename"
	);
	t.false(existsSync(fixture.receiptFile), "and no receipt survives either");

	// Recovering afterwards still works.
	const rebuilt = runBuild(fixture, { RELEASE: "1" });
	t.is(rebuilt.status, 0, rebuilt.stderr);
	t.false(existsSync(scratch));
	t.true(existsSync(fixture.receiptFile));
});

/**
 * wasm-bindgen names the snippets directory after a content hash, so a changed
 * inline_js leaves the old directory behind and the receipt would bind a
 * snippet nothing imports.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh clears stale generated snippets on a rebuild", (t) => {
	const fixture = makeFixture(t);
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);

	const stale = path.join(fixture.outDir, "snippets", "wasm-STALE0000000000", "inline0.js");
	mkdirSync(path.dirname(stale), { recursive: true });
	writeFileSync(stale, "export function scramtag() { return 'stale'; }\n");

	const source = path.join(fixture.rewriterDir, "js", "src", "lib.rs");
	writeFileSync(source, `${readFileSync(source, "utf8")}\n// edited\n`);
	const rebuilt = runBuild(fixture, { RELEASE: "1" });
	t.is(rebuilt.status, 0, rebuilt.stderr);

	t.false(existsSync(stale), "the stale snippet directory must be gone");
	t.true(existsSync(fixture.snippetFile), "the current snippet is regenerated");
	const bound = receiptPaths(fixture);
	t.false(
		bound.some((p) => p.includes("wasm-STALE0000000000")),
		"and the receipt must not bind it"
	);

	// Only `wasm/out` is touched: nothing else in the tree is removed.
	t.true(existsSync(path.join(fixture.rewriterDir, "native", "src", "main.rs")));
	t.true(existsSync(path.join(fixture.rewriterDir, "Cargo.lock")));
});

/**
 * The manifest enumeration must be as fail-closed as the fingerprint one, and
 * must fail AFTER the fingerprint has already succeeded.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh fails closed when the manifest enumeration fails", (t) => {
	const fixture = makeFixture(t);
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);

	// Fails only when invoked from inside the generated output directory, so
	// the source fingerprint still succeeds.
	const stub = path.join(fixture.binDir, "find");
	writeFileSync(
		stub,
		[
			"#!/bin/bash",
			'case "$PWD" in',
			'*/wasm/out)',
			'\tprintf "%s\\0" "./wasm.js"',
			'\techo "find: vanished mid-walk" >&2',
			"\texit 1",
			"\t;;",
			"esac",
			'exec /usr/bin/find "$@"',
			"",
		].join("\n")
	);
	chmodSync(stub, 0o755);

	const result = runBuild(fixture, { RELEASE: "1" });
	t.not(result.status, 0, "a failed manifest enumeration must fail the run");
	t.regex(result.stderr, /find exited non-zero/);
	t.false(existsSync(fixture.receiptFile), "no receipt may be published");
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh refuses a symlink in the generated output tree", (t) => {
	const fixture = makeFixture(t);
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);

	spawnSync("ln", ["-s", "/etc/hosts", path.join(fixture.outDir, "linked.wasm")]);
	const result = runBuild(fixture, { RELEASE: "1" });
	t.not(result.status, 0);
	t.regex(result.stderr, /symlink/);
	t.false(existsSync(fixture.receiptFile));
});

// ==========================================================================
// a checkout path containing spaces
// ==========================================================================

/**
 * Cargo escapes an embedded space in dep-info as "\ ". Splitting the rule on
 * whitespace alone corrupts such a path, and aborting over it killed a build
 * that had already produced a correct artifact -- so `pnpm pack` failed outright
 * for anyone whose checkout lives under a path like "/Volumes/T7 APFS" or
 * "My Projects".
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh builds, publishes and skips under a root containing spaces", (t) => {
	const fixture = makeFixture(t, { spaceRoot: true });
	t.regex(fixture.rewriterDir, / /, "the fixture root really does contain spaces");

	const first = runBuild(fixture, { RELEASE: "1" });
	t.is(first.status, 0, `a spaced path must build: ${first.stderr}`);
	t.regex(first.stdout, /Rewriter Build Complete!/);
	t.notRegex(first.stdout, /no freshness receipt/, "and must still earn a receipt");
	t.notRegex(first.stderr, /escape/, "the escaped-space form must be understood, not refused");
	t.true(existsSync(fixture.receiptFile));
	t.true(existsSync(fixture.distWasm));

	// The dep-info really did carry escaped spaces, so the test is not vacuous.
	const depInfo = readFileSync(
		path.join(fixture.rewriterDir, "target/wasm32-unknown-unknown/release/wasm.d"),
		"utf8"
	);
	t.regex(depInfo, /\\ /, "precondition: the stub wrote cargo's escaped-space form");

	writeFileSync(fixture.logPath, "");
	const second = runBuild(fixture, { RELEASE: "1" });
	t.is(second.status, 0, second.stderr);
	t.regex(second.stdout, /skipping rebuild/, "and the skip must work too");
	t.false(cargoCompiled(fixture));
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("hash-inputs.sh fingerprints a tree whose path contains spaces", (t) => {
	const fixture = makeFixture(t, { spaceRoot: true });
	const before = digestOf(t, fixture);
	t.is(digestOf(t, fixture), before, "deterministic under a spaced path");

	// Generated output must still be pruned when the root has spaces.
	const generated = path.join(fixture.rewriterDir, "target/release/build/x/f.json");
	mkdirSync(path.dirname(generated), { recursive: true });
	writeFileSync(generated, "{}\n");
	t.is(digestOf(t, fixture), before);

	const source = path.join(fixture.rewriterDir, "js", "src", "lib.rs");
	writeFileSync(source, `${readFileSync(source, "utf8")}\n// edited\n`);
	t.not(digestOf(t, fixture), before);
});

// ==========================================================================
// an unchecked closure is never trusted
// ==========================================================================

/**
 * With no dep-info there is nothing to cross-check, so there is no basis for a
 * receipt. The build still succeeds; only the claim is withheld.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh publishes no receipt when dep-info is missing", (t) => {
	const fixture = makeFixture(t);

	const first = runBuild(fixture, { RELEASE: "1", STUB_DEP_INFO_MISSING: "1" });
	t.is(first.status, 0, `the build itself must succeed: ${first.stderr}`);
	t.regex(first.stdout, /no freshness receipt/);
	t.regex(first.stderr, /no dependency information/);
	t.false(existsSync(fixture.receiptFile), "an unchecked closure earns no receipt");
	t.true(existsSync(fixture.distWasm), "but the artifact is produced");

	// With nothing recorded there is nothing to skip on.
	writeFileSync(fixture.logPath, "");
	const second = runBuild(fixture, { RELEASE: "1", STUB_DEP_INFO_MISSING: "1" });
	t.is(second.status, 0, second.stderr);
	t.true(cargoCompiled(fixture), "the next invocation must rebuild");
	t.notRegex(second.stdout, /skipping rebuild/);

	// And once dep-info is available again, a receipt is earned.
	const third = runBuild(fixture, { RELEASE: "1" });
	t.is(third.status, 0, third.stderr);
	t.true(existsSync(fixture.receiptFile));
});

/**
 * An encoding this code does not model turns the cache off. It must not fail a
 * build that already produced a correct artifact, and must not forge a receipt.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh publishes no receipt for a dep-info encoding it cannot model", (t) => {
	const fixture = makeFixture(t);
	const result = runBuild(fixture, {
		RELEASE: "1",
		STUB_DEP_INFO_RAW: "/tmp/a/wasm.wasm: /tmp/back\\\\slash.rs",
	});
	t.is(result.status, 0, `an unmodelled escape must not fail the build: ${result.stderr}`);
	t.regex(result.stdout, /no freshness receipt/);
	t.regex(result.stderr, /escape this check does not model/);
	t.false(existsSync(fixture.receiptFile));
	t.true(existsSync(fixture.distWasm));
});

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh publishes no receipt for an empty dep-info", (t) => {
	const fixture = makeFixture(t);
	const result = runBuild(fixture, {
		RELEASE: "1",
		STUB_DEP_INFO_RAW: "/tmp/a/wasm.wasm:",
	});
	t.is(result.status, 0, result.stderr);
	t.regex(result.stdout, /no freshness receipt/);
	t.regex(result.stderr, /named no files/);
	t.false(existsSync(fixture.receiptFile));
});

// ==========================================================================
// smaller review items
// ==========================================================================

/**
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
for (const [label, env] of [
	["CARGO_INCREMENTAL", { CARGO_INCREMENTAL: "1" }],
	["CARGO_TARGET_*", { CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: "-C opt-level=1" }],
]) {
	test.serial(`build.sh invalidates the cache for ${label}`, (t) => {
		const fixture = makeFixture(t);
		t.is(runBuild(fixture, { RELEASE: "1" }).status, 0);

		writeFileSync(fixture.logPath, "");
		const second = runBuild(fixture, { RELEASE: "1", ...env });
		t.is(second.status, 0, second.stderr);
		t.true(cargoCompiled(fixture), `${label} must not be silently stale`);

		writeFileSync(fixture.logPath, "");
		const third = runBuild(fixture, { RELEASE: "1" });
		t.is(third.status, 0, third.stderr);
		t.true(cargoCompiled(fixture), "the unset transition must invalidate too");
	});
}

/**
 * `build.rustc = "..."` at top level is as legal as `rustc` nested under
 * `[build]`, and was not matched.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test.serial("build.sh refuses a dotted cargo compiler override", (t) => {
	const fixture = makeFixture(t);
	const config = path.join(fixture.coreDir, ".cargo", "config.toml");
	mkdirSync(path.dirname(config), { recursive: true });

	for (const key of ["build.rustc", "build.rustc-wrapper", "build.rustc-workspace-wrapper"]) {
		writeFileSync(config, `${key} = "/usr/bin/true"\n`);
		const result = runBuild(fixture, { RELEASE: "1" });
		t.not(result.status, 0, `${key} must be refused`);
		t.regex(result.stderr, /sets a rustc override/);
		t.false(existsSync(fixture.receiptFile));
	}

	writeFileSync(config, "build.jobs = 2\n");
	t.is(runBuild(fixture, { RELEASE: "1" }).status, 0, "an unrelated dotted key is fine");
});
