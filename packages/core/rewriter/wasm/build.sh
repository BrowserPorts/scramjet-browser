#!/usr/bin/env bash
set -euo pipefail

# `packages/core`'s `rewriter:build` runs `bash build.sh`, so the interpreter is
# whatever `bash` resolves to on PATH -- on macOS that is /bin/bash 3.2.57, and
# the shebang is never consulted.
#
# `shopt -s inherit_errexit` used to sit on the line below. It is a bash >= 4.4
# feature and it was the only one in this script, so on a default macOS install
# the script aborted on line 3 before it could even evaluate the freshness gate.
# It is gone.
#
# `inherit_errexit` only ever affected `$(...)`: without it, a failure inside a
# command substitution does not abort the shell, it just yields an empty or
# partial value. Rather than rely on the option, every command substitution
# below checks its own status explicitly and refuses empty or malformed results,
# and every external command is followed by an explicit failure branch.
# `set -euo pipefail` still applies to everything else.

die() {
	printf 'build.sh: %s\n' "$*" >&2
	exit 1
}

# --------------------------------------------------------------------------
# locations
# --------------------------------------------------------------------------

# This script has always assumed it is run from `rewriter/wasm/`; make that a
# checked precondition instead of a silent one, then work from absolute paths so
# the later `cd` cannot change what the freshness gate looks at.
[ -f build.sh ] || die "must be run from packages/core/rewriter/wasm (no build.sh in $PWD)"
[ -f Cargo.toml ] || die "must be run from packages/core/rewriter/wasm (no Cargo.toml in $PWD)"

# `pwd -P` everywhere: plain `pwd` reports the LOGICAL path, so the same
# directory reached through a symlink (macOS /var -> /private/var) yields a
# different string and any later prefix or equality comparison against it
# silently fails.
if ! WASM_DIR="$(pwd -P)"; then
	die "cannot resolve the current directory"
fi
if ! REWRITER_DIR="$(cd .. && pwd -P)"; then
	die "cannot resolve the rewriter directory from $PWD"
fi
if ! CORE_DIR="$(cd ../.. && pwd -P)"; then
	die "cannot resolve the packages/core directory from $PWD"
fi

HASH_HELPER="$WASM_DIR/hash-inputs.sh"
[ -f "$HASH_HELPER" ] || die "missing $HASH_HELPER"

# The build receipt binds an input fingerprint to the exact bytes of every file
# the build generated. It supersedes the old `.build-hash`, which recorded only
# the fingerprint and so could not notice a deleted or corrupted output.
RECEIPT_FILE="$WASM_DIR/out/.build-receipt"
RECEIPT_SCRATCH="$RECEIPT_FILE.tmp"
RECEIPT_SCHEMA="scramjet-rewriter-receipt/1"
LEGACY_HASH_FILE="$WASM_DIR/out/.build-hash"

# --------------------------------------------------------------------------
# environment preconditions
#
# Each of these would silently invalidate what the fingerprint claims, so each
# is refused with an actionable message rather than recorded as a fiction.
# --------------------------------------------------------------------------

assert_env_unset() {
	eval "ae_state=\${$1+set}"
	if [ "${ae_state:-}" = "set" ]; then
		printf 'build.sh: %s is set, and %s\n' "$1" "$2" >&2
		die "unset $1 and re-run"
	fi
}

# cargo reads CARGO_ENCODED_RUSTFLAGS in preference to RUSTFLAGS. If it were
# set, the RUSTFLAGS this script exports below would be silently ignored while
# the fingerprint went on recording them as the flags in effect.
assert_env_unset CARGO_ENCODED_RUSTFLAGS \
	"it takes precedence over the RUSTFLAGS this build sets, which would make the recorded RUSTFLAGS a fiction."

# These substitute or wrap the compiler. The identity probed below would then
# not be the compiler that actually produces the artifact.
for compiler_override in RUSTC RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER \
	CARGO_BUILD_RUSTC CARGO_BUILD_RUSTC_WRAPPER CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER; do
	assert_env_unset "$compiler_override" \
		"it replaces or wraps the compiler, so the rustc identity this build records would not describe the compiler actually used."
done

# The wasm-bindgen step below reads ../target/<triple>/release/wasm.wasm by
# construction. Honouring a relocated target directory would need more than an
# environment variable, so claiming support for it would be wrong.
for relocation in CARGO_TARGET_DIR CARGO_BUILD_TARGET_DIR; do
	assert_env_unset "$relocation" \
		"this script resolves the compiled artifact at ../target/<triple>/release/wasm.wasm and does not support a relocated target directory."
done

# `coverage-macro` is a proc-macro. `locate_visitor_rs()` in
# coverage-macro/src/helper_index.rs returns $COVERAGE_VISITOR_FILE when set and
# the macro then reads that path with std::fs::read_to_string at expansion time.
# A proc-macro's own file reads are NOT recorded in cargo's dep-info, so neither
# the hashed tree nor the dep-info cross-check below would see it: the artifact
# would depend on a file nothing fingerprinted. Unset, the same function falls
# back to CARGO_MANIFEST_DIR/../js/src/visitor.rs, which is inside the hashed
# tree and therefore covered.
#
# This is refused rather than documented, because an untracked external input
# cannot be made safe to skip by documentation.
assert_env_unset COVERAGE_VISITOR_FILE \
	"coverage-macro reads that file at proc-macro expansion time, and a proc-macro's file reads appear in neither the hashed source tree nor cargo's dep-info, so no fingerprint here can cover it. Unset it to use the in-tree js/src/visitor.rs."

# A cargo configuration file can set build.rustc / build.rustc-wrapper /
# build.rustc-workspace-wrapper. Those files ARE hashed, so a change to one
# invalidates the fingerprint -- but the rustc identity recorded below would
# still describe a compiler that is not the one cargo runs. Hashing makes the
# record change; it does not make it true. Refuse instead.
check_config_for_compiler_override() {
	[ -f "$1" ] || return 0
	# Both spellings: a key nested under [build], and the dotted top-level form
	# `build.rustc = ...`, which is equally legal TOML and was not matched.
	if grep -Eq '^[[:space:]]*(build\.)?rustc(-wrapper|-workspace-wrapper)?[[:space:]]*=' "$1"; then
		printf 'build.sh: %s sets a rustc override.\n' "$1" >&2
		printf 'build.sh: the compiler identity this build records would then describe a\n' >&2
		printf 'build.sh: different compiler than the one cargo runs.\n' >&2
		die "remove the rustc/rustc-wrapper setting from $1, or build without that configuration"
	fi
}

config_scan_dir="$WASM_DIR"
while :; do
	check_config_for_compiler_override "$config_scan_dir/.cargo/config.toml"
	check_config_for_compiler_override "$config_scan_dir/.cargo/config"
	[ "$config_scan_dir" != "/" ] || break
	config_scan_dir="$(dirname "$config_scan_dir")"
done
check_config_for_compiler_override "${CARGO_HOME:-$HOME/.cargo}/config.toml"
check_config_for_compiler_override "${CARGO_HOME:-$HOME/.cargo}/config"

# --------------------------------------------------------------------------
# build policy
#
# Everything here is a value that changes the emitted wasm, and everything here
# is fed into the input fingerprint below.
#
# NOTE, correcting an earlier claim made about this script: feeding the same
# arrays to both the fingerprint and the execution keeps *those argument
# vectors* from drifting, but it never made the policy as a whole drift-proof.
# The wasm-bindgen argument vector, the sed post-processing, the order of the
# steps and the set of files the build writes were all outside the policy
# records. What actually covers them is that `build.sh` and `hash-inputs.sh` are
# themselves hashed as part of the source tree.
# --------------------------------------------------------------------------

if ! [ "${RELEASE:-0}" = "1" ]; then
	WASMOPTFLAGS="${WASMOPTFLAGS:-} -g"
	FEATURES="debug,${FEATURES:-}"
else
	: "${WASMOPTFLAGS:=}"
	: "${FEATURES:=}"
fi

MODE="release"
if [ "${RELEASE:-0}" != "1" ]; then MODE="debug"; fi

TARGET="wasm32-unknown-unknown"
WBG="wasm-bindgen 0.2.105"
SED_EXPR='s/import.meta.url/""/g'

# Hoisted out of the cargo subshell that used to compute them, so that the
# fingerprint covers the exact flags cargo is invoked with.
RUSTFLAGS_EFFECTIVE='-Zlocation-detail=none -Zfmt-debug=none'
if [ "${OPTIMIZE_FOR_SIZE:-0}" = "1" ]; then
	RUSTFLAGS_EFFECTIVE="${RUSTFLAGS_EFFECTIVE} -C opt-level=z"
fi
STD_FEATURES=""
if [ "${OPTIMIZE_FOR_SPEED:-0}" = "0" ]; then
	STD_FEATURES="${STD_FEATURES},optimize_for_size"
fi

CARGO_ARGS=(
	+nightly build --release --target "$TARGET"
	-Z "build-std=panic_abort,std"
	-Z "build-std-features=${STD_FEATURES}"
	--no-default-features --features "$FEATURES"
)

# Paths in the two argument vectors below are relative to packages/core, because
# that is the directory they are executed from. Keeping them relative also keeps
# the fingerprint machine independent.
SNIP_ARGS=(
	rewriter/wasm/out/wasm_bg.wasm -o rewriter/wasm/out/wasm_snipped.wasm
	-p 'oxc_regular_expression::.*'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_non_array_type'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_ts_import_type'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_type_operator_or_higher'
	'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::parse_ts_interface_declaration'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_mapped_type'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_index_signature_declaration'
	'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::parse_ts_import_equals_declaration'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_type_or_type_predicate'
	'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::parse_ts_namespace_or_module_declaration_body'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_ts_implements_clause'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_intersection_type_or_higher'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_ts_type_name'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_literal_type_node'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_asserts_type_predicate'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_tuple_element_type'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_type_arguments_of_type_reference'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_ts_call_signature_member'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::is_start_of_type'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_this_type_predicate'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_type_query'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_type_reference'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_type_operator'
	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_type_literal'
	'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::is_at_enum_declaration'
	'oxc_parser::jsx::<impl oxc_parser::ParserImpl>::parse_jsx_element'
	'oxc_parser::jsx::<impl oxc_parser::ParserImpl>::parse_jsx_identifier'
	'oxc_parser::jsx::<impl oxc_parser::ParserImpl>::parse_jsx_element_name'
	'oxc_parser::jsx::<impl oxc_parser::ParserImpl>::parse_jsx_children'
	'oxc_parser::jsx::<impl oxc_parser::ParserImpl>::parse_jsx_fragment'
	'oxc_parser::jsx::<impl oxc_parser::ParserImpl>::parse_jsx_expression_container'
	'oxc_parser::jsx::<impl oxc_parser::ParserImpl>::parse_jsx_expression'
)
#
#	these are confirmed to break oxc
#   'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::parse_declaration'
#	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_ts_type'
#	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_type_arguments_in_expression'
#	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_ts_type_parameters'
#	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_class_element_modifiers'
#	'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::eat_decorators'
#	'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::is_nth_at_modifier'
#	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::try_parse_type_arguments'
#	'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::is_at_ts_index_signature_member'
#	'oxc_parser::ts::types::<impl oxc_parser::ParserImpl>::parse_ts_return_type_annotation'
#	'oxc_parser::ts::statement::<impl oxc_parser::ParserImpl>::parse_ts_type_annotation'

WASMOPT_G="--generate-global-effects"
WASMOPT_ARGS=()
# WASMOPTFLAGS is a caller supplied flag string and is word split on purpose.
# shellcheck disable=SC2206
WASMOPT_ARGS+=($WASMOPTFLAGS)
WASMOPT_ARGS+=(
	rewriter/wasm/out/wasm_snipped.wasm -o rewriter/wasm/out/optimized.wasm
	--converge -tnh --vacuum
	"$WASMOPT_G" -O4 "$WASMOPT_G" --flatten "$WASMOPT_G" --rereloop "$WASMOPT_G" -O4 "$WASMOPT_G" -O4 "$WASMOPT_G" -O4
	"$WASMOPT_G" -Oz "$WASMOPT_G" --flatten "$WASMOPT_G" --rereloop "$WASMOPT_G" -Oz "$WASMOPT_G" -Oz "$WASMOPT_G" -Oz
	"$WASMOPT_G" --code-folding "$WASMOPT_G" --const-hoisting "$WASMOPT_G" --dae "$WASMOPT_G" --flatten "$WASMOPT_G" --merge-locals
	"$WASMOPT_G" -O4 "$WASMOPT_G" --flatten "$WASMOPT_G" --rereloop "$WASMOPT_G" -O4 "$WASMOPT_G" -O4 "$WASMOPT_G" -O4
	"$WASMOPT_G" -Oz "$WASMOPT_G" --flatten "$WASMOPT_G" --rereloop "$WASMOPT_G" -Oz "$WASMOPT_G" -Oz "$WASMOPT_G" -Oz
)

# A fast, explicit list used to produce a clear error the moment a step fails to
# write what it should. It is NOT the freshness gate: the receipt is, and the
# receipt covers the whole generated tree including wasm-bindgen's `snippets/`
# directory, which this list cannot enumerate ahead of time because its name
# contains a content hash.
OUTPUTS=(
	rewriter/wasm/out/wasm.js
	rewriter/wasm/out/wasm.d.ts
	rewriter/wasm/out/wasm_bg.wasm
	rewriter/wasm/out/wasm_snipped.wasm
	rewriter/wasm/out/optimized.wasm
	dist/scramjet.wasm
)

# --------------------------------------------------------------------------
# toolchain gate
#
# This runs before the freshness gate because the tool and compiler identities
# are fingerprint inputs: a recorded hash that did not cover them could not
# honestly mean "this artifact matches these inputs". The cost is that the
# toolchain must be present even for a run that ends up skipping.
# --------------------------------------------------------------------------

REQUIRED_TOOLS=(cargo rustc wasm-bindgen wasm-opt wasm-snip)
MISSING_TOOLS=()
for required_tool in "${REQUIRED_TOOLS[@]}"; do
	if ! command -v "$required_tool" >/dev/null; then
		MISSING_TOOLS+=("$required_tool")
	fi
done
if [ ${#MISSING_TOOLS[@]} -ne 0 ]; then
	echo "Please install cargo, wasm-bindgen, wasm-opt from https://github.com/WebAssembly/binaryen, and wasm-snip from https://github.com/r58playz/wasm-snip!" >&2
	die "missing required tools: ${MISSING_TOOLS[*]}"
fi

# Captures a tool's first output line. Dies on a non-zero exit or empty output,
# so a broken or shadowed tool can never silently contribute an empty string to
# the fingerprint. stderr is deliberately not redirected.
probe_version() {
	pv_label="$1"
	shift
	if ! pv_out="$("$@")"; then
		die "\`$*\` failed; cannot determine the $pv_label version"
	fi
	[ -n "$pv_out" ] || die "\`$*\` produced no output; cannot determine the $pv_label version"
	printf '%s\n' "${pv_out%%$'\n'*}"
}

# Same checks, but keeps every line. Used for `rustc -vV`, whose value is the
# whole block: commit hash, commit date, host triple, release and LLVM version.
probe_identity() {
	pi_label="$1"
	shift
	if ! pi_out="$("$@")"; then
		die "\`$*\` failed; cannot determine the $pi_label identity"
	fi
	[ -n "$pi_out" ] || die "\`$*\` produced no output; cannot determine the $pi_label identity"
	printf '%s\n' "$pi_out"
}

if ! WASM_BINDGEN_VERSION="$(probe_version wasm-bindgen wasm-bindgen -V)"; then
	exit 1
fi
case "$WASM_BINDGEN_VERSION" in
"$WBG"*) ;;
*) die "Incorrect wasm-bindgen-cli version: '$WASM_BINDGEN_VERSION' != '$WBG'" ;;
esac

if ! WASM_OPT_VERSION="$(probe_version wasm-opt wasm-opt --version)"; then
	exit 1
fi
if ! WASM_SNIP_VERSION="$(probe_version wasm-snip wasm-snip --version)"; then
	exit 1
fi

TOOLCHAIN_HINT_1="build.sh: \`+toolchain\` selection is a rustup feature. If \`cargo\` or \`rustc\`"
TOOLCHAIN_HINT_2="build.sh: resolves to a distribution or Homebrew build it rejects \`+nightly\`. Put"
TOOLCHAIN_HINT_3="build.sh: rustup's shims first, e.g. PATH=\"\$HOME/.cargo/bin:\$PATH\"."

if ! CARGO_NIGHTLY_VERSION="$(probe_version "cargo +nightly" cargo +nightly --version)"; then
	echo "$TOOLCHAIN_HINT_1" >&2
	echo "$TOOLCHAIN_HINT_2" >&2
	echo "$TOOLCHAIN_HINT_3" >&2
	exit 1
fi

# `cargo --version` identifies cargo, not the compiler. Two different rustc
# builds -- a nightly bump, a rebuilt LLVM, a different host triple -- can sit
# behind one cargo version and emit different bytes. `rustc -vV` through the
# same `+nightly` toolchain is the compiler identity that actually matters, and
# the compiler-substituting variables refused above are what make it truthful.
if ! RUSTC_IDENTITY="$(probe_identity "rustc +nightly" rustc +nightly -vV)"; then
	echo "$TOOLCHAIN_HINT_1" >&2
	echo "$TOOLCHAIN_HINT_2" >&2
	echo "$TOOLCHAIN_HINT_3" >&2
	exit 1
fi

# --------------------------------------------------------------------------
# input fingerprint
# --------------------------------------------------------------------------

POLICY_ARGS=()
add_policy() {
	POLICY_ARGS+=(--policy "$1=$2")
}

add_policy SCHEMA "scramjet-rewriter-wasm/2"
add_policy MODE "$MODE"
add_policy TARGET "$TARGET"
add_policy FEATURES "$FEATURES"
add_policy STD_FEATURES "$STD_FEATURES"
add_policy RUSTFLAGS "$RUSTFLAGS_EFFECTIVE"
add_policy WASMOPTFLAGS "$WASMOPTFLAGS"
add_policy SED_EXPR "$SED_EXPR"
add_policy WBG_REQUIRED "$WBG"
add_policy TOOL_CARGO_NIGHTLY "$CARGO_NIGHTLY_VERSION"
add_policy TOOL_RUSTC_NIGHTLY "$RUSTC_IDENTITY"
add_policy TOOL_WASM_BINDGEN "$WASM_BINDGEN_VERSION"
add_policy TOOL_WASM_OPT "$WASM_OPT_VERSION"
add_policy TOOL_WASM_SNIP "$WASM_SNIP_VERSION"
# Environment that changes what cargo or the macros do. These are recorded
# rather than refused, so that setting one invalidates the cache instead of
# silently reusing an artifact built without it. Names come from `compgen -e`
# and values from indirect expansion, so a value containing newlines cannot
# disturb the record (every value is hex encoded and length prefixed anyway).
# CARGO_TARGET_* is included for the per-target settings that do change
# codegen (RUSTFLAGS, LINKER). CARGO_TARGET_<TRIPLE>_RUNNER is recorded by the
# same prefix, but it selects how a binary is EXECUTED by `cargo run`/`test`,
# not how it is compiled; recording it is completeness, not a claim that it
# affects the artifact.
ENV_PREFIXES="CARGO_PROFILE_ CARGO_UNSTABLE_ CARGO_BUILD_ CARGO_TARGET_ COVERAGE_"
for env_name in $({ compgen -e || true; } | LC_ALL=C sort); do
	for env_prefix in $ENV_PREFIXES; do
		case "$env_name" in
		"$env_prefix"*)
			add_policy "ENV_$env_name" "${!env_name}"
			break
			;;
		esac
	done
done
# Recorded explicitly as absent-or-present so that the transition from unset to
# set changes the fingerprint even for the values above that are empty.
for state_name in COVERAGE_CHECK COVERAGE_AUDIT CARGO_INCREMENTAL; do
	eval "env_state=\${$state_name+set}"
	add_policy "ENV_STATE_$state_name" "${env_state:-unset}"
	if [ "${env_state:-}" = "set" ]; then
		add_policy "ENV_$state_name" "${!state_name}"
	fi
done

for policy_arg in "${CARGO_ARGS[@]}"; do add_policy CARGO_ARG "$policy_arg"; done
for policy_arg in "${SNIP_ARGS[@]}"; do add_policy SNIP_ARG "$policy_arg"; done
for policy_arg in "${WASMOPT_ARGS[@]}"; do add_policy WASMOPT_ARG "$policy_arg"; done

# These policy records, plus the hashed source tree and the discovered cargo
# configuration, are a DOCUMENTED PARTIAL account of what can change the output.
# They are not a claim of universal reproducibility: cargo and rustc read more
# environment than any whitelist here can track. What is claimed is narrower and
# checkable -- the inputs listed are covered, and the environment that would
# make the listed values untrue is refused outright above.

# $1: path to write the canonical listing to, or "" for none.
compute_src_hash() {
	if [ -n "$1" ]; then
		"${BASH:-bash}" "$HASH_HELPER" --root "$REWRITER_DIR" \
			--config-scan-from "$WASM_DIR" --listing "$1" "${POLICY_ARGS[@]}"
	else
		"${BASH:-bash}" "$HASH_HELPER" --root "$REWRITER_DIR" \
			--config-scan-from "$WASM_DIR" "${POLICY_ARGS[@]}"
	fi
}

# The generated-output manifest: every file the build writes, with its digest.
# `out/` is enumerated wholesale so wasm-bindgen's content-hashed `snippets/`
# directory is covered. The receipt itself and the retired `.build-hash` are
# excluded, so the receipt never describes itself.
compute_output_manifest() {
	"${BASH:-bash}" "$HASH_HELPER" --manifest --root "$CORE_DIR" \
		--include rewriter/wasm/out \
		--include dist/scramjet.wasm \
		--exclude rewriter/wasm/out/.build-receipt \
		--exclude rewriter/wasm/out/.build-receipt.tmp \
		--exclude rewriter/wasm/out/.build-hash
}

assert_hash() {
	case "$2" in
	*[!0-9a-f]*) die "$1 is not a lowercase sha256 hex digest: '$2'" ;;
	esac
	[ ${#2} -eq 64 ] || die "$1 is not 64 hex characters: '$2'"
}

if ! SRC_HASH="$(compute_src_hash "${REWRITER_HASH_LISTING:-}")"; then
	die "could not fingerprint the rewriter build inputs"
fi
assert_hash "the computed input fingerprint" "$SRC_HASH"

# --------------------------------------------------------------------------
# freshness gate
#
# A skip requires all three: a receipt of the expected schema, an input
# fingerprint equal to the one just computed, and a generated tree whose every
# file still hashes to exactly what the receipt recorded. Anything else
# rebuilds. Every failure direction here is "rebuild", never "skip".
# --------------------------------------------------------------------------

SKIP="no"

if [ -f "$RECEIPT_FILE" ]; then
	if ! RECEIPT_TEXT="$(cat "$RECEIPT_FILE")"; then
		die "cannot read $RECEIPT_FILE"
	fi
	RECEIPT_HEAD="$(printf '%s\n' "$RECEIPT_TEXT" | sed -n '1p')"
	RECEIPT_INPUT="$(printf '%s\n' "$RECEIPT_TEXT" | sed -n '2p')"
	RECEIPT_OUTPUTS="$(printf '%s\n' "$RECEIPT_TEXT" | sed -n '3,$p')"

	if [ "$RECEIPT_HEAD" != "$RECEIPT_SCHEMA" ]; then
		echo "Rewriter build receipt has an unrecognised schema; rebuilding."
	elif [ "$RECEIPT_INPUT" != "I $SRC_HASH" ]; then
		echo "Rewriter inputs changed since the recorded build; rebuilding."
	elif ! CURRENT_OUTPUTS="$(compute_output_manifest)"; then
		# Reaching here means an output is missing, unreadable, or the manifest
		# could not be produced. Rebuilding is the only safe direction; if the
		# cause is not a missing file the rebuild will hit it again and fail.
		echo "Rewriter outputs could not be verified against the receipt; rebuilding."
	elif [ "$CURRENT_OUTPUTS" != "$RECEIPT_OUTPUTS" ]; then
		echo "Rewriter outputs no longer match the receipt; rebuilding."
	else
		SKIP="yes"
	fi
fi

if [ "$SKIP" = "yes" ]; then
	echo "Rewriter inputs unchanged (hash $SRC_HASH) and outputs match the receipt; skipping rebuild."
	exit 0
fi

# Invalidate before touching a single output. If the build now fails part way
# through, the tree must not keep a receipt that would let a later run skip over
# half written artifacts.
rm -f "$RECEIPT_FILE" || die "cannot remove the stale receipt $RECEIPT_FILE"
# A crash between writing the scratch file and renaming it leaves this behind.
# It is excluded from the manifest, but it must not survive into a new build.
rm -f "$RECEIPT_SCRATCH" || die "cannot remove the leftover scratch receipt $RECEIPT_SCRATCH"
rm -f "$LEGACY_HASH_FILE" || die "cannot remove the retired hash record $LEGACY_HASH_FILE"

# wasm-bindgen names its snippets directory after a content hash, so changing an
# inline_js block produces a NEW directory and leaves the old one in place. The
# receipt would then bind a stale snippet that nothing imports, and the glue and
# the receipt would disagree about what the build produced.
#
# Only this one generated directory is removed, only inside the build's own
# `wasm/out`, and only AFTER the receipt is already invalidated -- so an
# interruption between the two cannot leave a receipt describing files that are
# no longer there. Nothing outside `wasm/out` is touched.
if [ -d "$WASM_DIR/out/snippets" ]; then
	rm -rf "$WASM_DIR/out/snippets" || die "cannot remove the stale generated snippets directory"
fi

# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------

RUSTFLAGS="$RUSTFLAGS_EFFECTIVE" cargo "${CARGO_ARGS[@]}" || die "cargo build failed"

wasm-bindgen --target web --out-dir out/ "../target/$TARGET/release/wasm.wasm" || die "wasm-bindgen failed"

case "$OSTYPE" in
darwin* | freebsd* | dragonfly*)
	sed -i '' "$SED_EXPR" out/wasm.js || die "rewriting out/wasm.js with sed failed"
	;;
*)
	sed -i "$SED_EXPR" out/wasm.js || die "rewriting out/wasm.js with sed failed"
	;;
esac

cd "$CORE_DIR" || die "cannot enter $CORE_DIR"

wasm-snip "${SNIP_ARGS[@]}" || die "wasm-snip failed"

if [ "$MODE" = "release" ]; then
	time wasm-opt "${WASMOPT_ARGS[@]}" || die "wasm-opt failed"
else
	cp rewriter/wasm/out/wasm_snipped.wasm rewriter/wasm/out/optimized.wasm || die "copying wasm_snipped.wasm to optimized.wasm failed"
fi

mkdir -p dist/ || die "cannot create dist/"

cp rewriter/wasm/out/optimized.wasm dist/scramjet.wasm || die "copying optimized.wasm to dist/scramjet.wasm failed"

for expected_output in "${OUTPUTS[@]}"; do
	if ! [ -s "$CORE_DIR/$expected_output" ]; then
		die "expected build output is missing or empty: $expected_output"
	fi
done

# --------------------------------------------------------------------------
# publish a receipt, but only for a state that actually produced these bytes
# --------------------------------------------------------------------------

if ! SRC_HASH_AFTER="$(compute_src_hash "")"; then
	die "could not re-fingerprint the rewriter build inputs after the build"
fi
assert_hash "the post-build input fingerprint" "$SRC_HASH_AFTER"

if [ "$SRC_HASH_AFTER" != "$SRC_HASH" ]; then
	echo "build.sh: the rewriter build inputs changed while the build was running." >&2
	echo "build.sh:   fingerprint before: $SRC_HASH" >&2
	echo "build.sh:   fingerprint after:  $SRC_HASH_AFTER" >&2
	echo "build.sh: The artifacts just written cannot be attributed to either state, so no" >&2
	echo "build.sh: receipt has been recorded and this build is reported as failed." >&2
	echo "build.sh: Nothing in the source tree was modified or reverted. Re-run the build." >&2
	exit 1
fi

# -- what the compiler actually read --------------------------------------
#
# Cargo writes a makefile rule naming every file rustc read for this artifact.
# That is authentic evidence, unlike the best-effort text screen in
# hash-inputs.sh, and it is checked before any freshness is claimed: anything
# rustc read that is neither inside the hashed tree nor in a location pinned by
# Cargo.lock or the recorded compiler identity means the fingerprint is
# incomplete.
#
# LIMIT, stated because it is load bearing: dep-info records what the COMPILER
# read. A proc-macro that opens a file itself never appears here. That is
# precisely why COVERAGE_VISITOR_FILE is refused outright rather than screened.
DEP_INFO="$REWRITER_DIR/target/$TARGET/release/wasm.d"

# Reason the freshness cache must stay off for this build, or "" to publish a
# receipt. Setting this is never a build failure: the artifact is fine, it is
# only the CLAIM about it that cannot be made.
RECEIPT_SUPPRESSED=""

if ! [ -f "$DEP_INFO" ]; then
	# Previously this branch skipped the cross-check and published a receipt
	# anyway, which is the one thing it must not do: an unchecked closure is
	# exactly the case where the receipt would be a guess.
	RECEIPT_SUPPRESSED="cargo wrote no dependency information at $DEP_INFO, so what the compiler read could not be checked"
else
	# Tokenising the makefile rule. Cargo escapes a space in a path as "\ ",
	# so splitting on whitespace alone corrupts any checkout whose path
	# contains a space -- and the previous code then aborted a SUCCESSFUL
	# compile over it. The escaped form is handled here; anything else unknown
	# turns the cache off rather than failing.
	if ! DEP_FIELDS="$(awk '
		{ sub(/^[^:]*:/, ""); line = line $0 " " }
		END {
			gsub(/\\ /, "\001", line)
			n = split(line, tok, /[ \t\n]+/)
			for (i = 1; i <= n; i++) {
				if (tok[i] == "") continue
				gsub(/\001/, " ", tok[i])
				print tok[i]
			}
		}' "$DEP_INFO")"; then
		die "cannot read the dependency information at $DEP_INFO"
	fi

	if [ -z "$DEP_FIELDS" ]; then
		RECEIPT_SUPPRESSED="the dependency information at $DEP_INFO named no files, so what the compiler read could not be checked"
	fi
fi

if [ -z "$RECEIPT_SUPPRESSED" ]; then
	# The prefixes are physical (see pwd -P above), so each dependency is
	# resolved physically too before it is classified. Comparing a logical path
	# against a physical prefix would misfile every entry.
	if ! CARGO_HOME_ABS="$(cd "${CARGO_HOME:-$HOME/.cargo}" 2>/dev/null && pwd -P)"; then
		CARGO_HOME_ABS="${CARGO_HOME:-$HOME/.cargo}"
	fi
	if ! RUSTUP_HOME_ABS="$(cd "${RUSTUP_HOME:-$HOME/.rustup}" 2>/dev/null && pwd -P)"; then
		RUSTUP_HOME_ABS="${RUSTUP_HOME:-$HOME/.rustup}"
	fi
	UNCOVERED=""
	while IFS= read -r dep_path; do
		[ -n "$dep_path" ] || continue
		# A backslash surviving tokenisation means an escape this code does not
		# model. Turn the cache off; do not guess, and do not fail a build that
		# has already produced a correct artifact.
		case "$dep_path" in
		*\\*)
			RECEIPT_SUPPRESSED="the dependency information at $DEP_INFO uses an escape this check does not model ($dep_path)"
			break
			;;
		esac
		if dep_dir="$(cd "$(dirname "$dep_path")" 2>/dev/null && pwd -P)"; then
			dep_real="$dep_dir/$(basename "$dep_path")"
		else
			dep_real="$dep_path"
		fi
		case "$dep_real" in
		"$REWRITER_DIR/target/"*) continue ;;
		"$REWRITER_DIR/"*) continue ;;
		"$CARGO_HOME_ABS/"*) continue ;;
		"$RUSTUP_HOME_ABS/"*) continue ;;
		esac
		UNCOVERED="$UNCOVERED  $dep_path
"
	done <<EOF
$DEP_FIELDS
EOF
	# An uncovered file really is a failure: the compiler read something the
	# fingerprint cannot see, so the artifact is not attributable at all.
	if [ -n "$UNCOVERED" ]; then
		echo "build.sh: the compiler read files that this fingerprint does not cover:" >&2
		printf '%s' "$UNCOVERED" >&2
		echo "build.sh: they are outside the hashed tree, the cargo registry and the" >&2
		echo "build.sh: toolchain, so a recorded receipt could not honestly mean the" >&2
		echo "build.sh: artifact matches its inputs. No receipt has been published." >&2
		exit 1
	fi
fi

# -- the build-script contract --------------------------------------------
#
# A cargo build script runs arbitrary code and may read anything: env vars, the
# network, files outside the tree. Hashing build.rs covers the script, not its
# inputs, so the cache is switched off while one is present.
#
# SCOPE, because the two cases are not alike. This rule is about build scripts
# IN THE HASHED TREE, whose sources are local and mutable. Build scripts
# belonging to registry dependencies are a different boundary: their versions
# are pinned by Cargo.lock and their contents by the registry checksum that
# Cargo.lock records, and Cargo.lock is hashed. They are therefore treated as
# pinned rather than dynamic, and do not switch the cache off. What that does
# NOT claim is hermeticity of a registry build script at run time; it claims
# only that its code is pinned by a hashed lockfile.
if ! BUILD_SCRIPTS="$( (cd "$REWRITER_DIR" && find . -path ./target -prune -o -name build.rs -print) )"; then
	die "could not scan the tree for cargo build scripts"
fi
if [ -n "$BUILD_SCRIPTS" ] && [ -z "$RECEIPT_SUPPRESSED" ]; then
	printf 'build.sh: a cargo build script is present in the tree:\n' >&2
	printf '%s\n' "$BUILD_SCRIPTS" | sed 's|^\./|  |' >&2
	RECEIPT_SUPPRESSED="a cargo build script in the tree can read inputs the source fingerprint cannot see"
fi

# One decision point for every reason the cache must stay off. The build has
# succeeded by here; suppressing the receipt is not a failure and must never be
# reported as one, nor replaced by a receipt that was not earned.
if [ -n "$RECEIPT_SUPPRESSED" ]; then
	echo "build.sh: $RECEIPT_SUPPRESSED." >&2
	echo "build.sh: no freshness receipt has been published, so the next run will" >&2
	echo "build.sh: rebuild. The build itself succeeded and its output is complete." >&2
	echo "Rewriter Build Complete (no freshness receipt: $RECEIPT_SUPPRESSED)."
	exit 0
fi

if ! OUTPUT_MANIFEST="$(compute_output_manifest)"; then
	die "could not enumerate the generated outputs after the build"
fi
[ -n "$OUTPUT_MANIFEST" ] || die "the generated output manifest is empty"

# Written via a temporary file so an interrupted write cannot leave a truncated
# receipt that a later run would try to honour.
{
	printf '%s\n' "$RECEIPT_SCHEMA"
	printf 'I %s\n' "$SRC_HASH"
	printf '%s\n' "$OUTPUT_MANIFEST"
} >"$RECEIPT_SCRATCH" || die "cannot write $RECEIPT_SCRATCH"
mv "$RECEIPT_SCRATCH" "$RECEIPT_FILE" || die "cannot publish the receipt $RECEIPT_FILE"

echo "Rewriter Build Complete!"
