#!/usr/bin/env bash
#
# Two related jobs, both framed identically so one set of safety machinery
# covers them:
#
#   hash-inputs.sh --root DIR [--config-scan-from DIR] [--listing FILE]
#                  [--policy NAME=VALUE ...]
#       Prints one lowercase 64-character sha256 over everything that can
#       change the rewriter's WebAssembly output.
#
#   hash-inputs.sh --manifest --root DIR --include REL [--include REL ...]
#                  [--exclude REL ...]
#       Prints framed `O` records, one per generated file, for a build receipt.
#
# ---------------------------------------------------------------------------
# What the fingerprint covers, and the boundary it does not cross
# ---------------------------------------------------------------------------
#
# The input set is the WHOLE source tree under --root, minus exactly three
# generated directories: `target/`, `wasm/out/` and any `.git/`. It is a
# deliberately conservative closure rather than a dependency graph:
#
#   - `build.rs` is auto-discovered by cargo with no manifest edit, so a
#     closure derived from `Cargo.toml` would miss one appearing.
#   - workspace members outside a crate's dependency graph can still affect a
#     build through feature unification and lockfile resolution, so excluding
#     `native/` on "it is not in the closure" grounds was not sound.
#   - `include_bytes!`/`include_str!` targets, `.cargo/config.toml`, test
#     fixtures and data files are all covered for free.
#
# The cost is over-invalidation: editing anything under --root rebuilds,
# including files that cannot affect the artifact. That is the intended
# trade-off. Under-invalidation ships a stale artifact; over-invalidation
# only costs time.
#
# Cargo configuration is discovered the way cargo discovers it: every
# `.cargo/config.toml` (and legacy `.cargo/config`) from --config-scan-from
# upwards to `/`, plus `$CARGO_HOME/config.toml`. Ancestor configs are
# recorded by DEPTH and content, never by absolute path, so an unconfigured
# machine produces byte-identical records regardless of where the checkout
# lives.
#
# SUPPORTED-LAYOUT BOUNDARY. This script fingerprints a hermetic tree. It cannot
# see inputs that live outside --root, and it does not pretend to. It runs a
# BEST-EFFORT TEXT SCREEN -- not a Rust or TOML parser -- and refuses to produce
# a digest when that screen finds a reference it cannot resolve:
#
#   - any symlink in the source tree (its target may be outside the tree, and
#     `find -type f` would silently skip it)
#   - any `path = "..."` dependency in a hashed manifest that resolves outside
#     --root
#   - any `include!`/`include_bytes!`/`include_str!` whose literal resolves
#     outside --root, or whose argument is not a plain string literal (e.g.
#     `concat!(env!("OUT_DIR"), ...)`)
#
# The screen is deliberately NOT described as complete. It is a heuristic whose
# only guaranteed property is direction: it refuses rather than assumes. Two
# things make that honest rather than hand-waving. build.sh cross-checks cargo's
# dep-info after the build, which is what the compiler actually read; and the
# dynamic-input cases the screen cannot see are handled by refusing or by
# switching the cache off, never by documentation alone.
#
# DYNAMIC INPUTS, which cover PROC-MACROS as well as build scripts. Both run
# arbitrary code at compile time and may read env vars, the network, or files
# anywhere. Hashing `build.rs` or a macro crate covers the code, not its inputs.
# So: build.sh refuses `COVERAGE_VISITOR_FILE` (the one such input this tree
# actually has -- coverage-macro reads it with std::fs at expansion time, where
# neither this hash nor dep-info can see it), and build.sh publishes no receipt
# at all while a `build.rs` is present, which disables the skip cache rather
# than assuming hermeticity.
#
# Deliberately NOT hashed: `target/`, `wasm/out/`, `../dist/` — build outputs.
# Hashing them is what made the previous scheme self-invalidating.
#
# `build.sh` and this file ARE hashed, because they live in the tree. That is
# what actually covers the wasm-bindgen argument vector, the post-processing
# order and the step sequence, none of which were ever expressible as policy
# records. Editing a comment in either script forces one rebuild; that is the
# accepted price for the guarantee.
#
# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------
#
# Every variable-length field is hex encoded and length prefixed, so the
# concatenation is injective: no path or value can smuggle a delimiter and
# collide with a different input set. File records are sorted under LC_ALL=C;
# policy records keep the order they were given.
#
# Bash 3.2 compatible on purpose: macOS ships bash 3.2.57 and `rewriter:build`
# invokes `bash build.sh` explicitly, so the system bash is the interpreter.
# Nothing here uses `inherit_errexit`; every command substitution, pipeline and
# enumeration result is checked explicitly.

set -euo pipefail

SELF="hash-inputs.sh"

die() {
	printf '%s: %s\n' "$SELF" "$*" >&2
	exit 1
}

# --------------------------------------------------------------------------
# sha256 backend
# --------------------------------------------------------------------------

EMPTY_SHA256="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

HASHER=""
if command -v sha256sum >/dev/null; then
	HASHER="sha256sum"
elif command -v shasum >/dev/null; then
	HASHER="shasum"
elif command -v openssl >/dev/null; then
	HASHER="openssl"
else
	die "no sha256 implementation found (looked for sha256sum, shasum, openssl)"
fi

# Reads stdin, writes the bare hex digest. `cut` drops the filename column that
# every backend appends; stdin is used instead of a filename argument so that
# no path is ever parsed back out of the tool's output.
hash_stdin() {
	case "$HASHER" in
	sha256sum) sha256sum | cut -d' ' -f1 ;;
	shasum) shasum -a 256 | cut -d' ' -f1 ;;
	openssl) openssl dgst -sha256 -r | cut -d' ' -f1 ;;
	esac
}

is_sha256() {
	case "$1" in
	*[!0-9a-f]*) return 1 ;;
	esac
	[ ${#1} -eq 64 ]
}

# Prove the backend works before trusting any digest it produces. A silently
# broken hasher would otherwise become a silently wrong gate.
if ! HASHER_PROBE="$(printf '' | hash_stdin)"; then
	die "sha256 backend '$HASHER' failed on empty input"
fi
if [ "$HASHER_PROBE" != "$EMPTY_SHA256" ]; then
	die "sha256 backend '$HASHER' produced '$HASHER_PROBE' for empty input, expected $EMPTY_SHA256"
fi

# `-v` is mandatory: without it od collapses repeated input lines to `*`,
# which would make distinct inputs share an encoding.
hex_encode() {
	od -An -v -tx1 | tr -d ' \n'
}

hex_of() {
	printf '%s' "$1" | hex_encode
}

# --------------------------------------------------------------------------
# scratch space
# --------------------------------------------------------------------------

if ! SELF_TMP="$(mktemp -d "${TMPDIR:-/tmp}/scramjet-hash-inputs.XXXXXX")"; then
	die "cannot create a temporary directory"
fi
cleanup() {
	rm -rf "$SELF_TMP"
}
trap cleanup EXIT

# --------------------------------------------------------------------------
# checked enumeration
#
# `find` runs into a NUL-separated temporary file and its exit status is
# checked BEFORE a single path is consumed. Reading from a process
# substitution instead, as this used to, discards that status: a `find` that
# printed some paths and then failed (permissions, a directory vanishing
# mid-walk) produced a short list that still looked like a complete, valid
# digest.
# --------------------------------------------------------------------------

# Both enumerations `cd` into the directory and walk `.`, so the only find
# arguments are fixed literals. Interpolating the root into `-path` patterns was
# a fail-OPEN bug: `-path` takes a glob, so a checkout whose path contains `[`,
# `*` or `?` stopped matching and the prune silently did nothing, letting
# `target/` back into the fingerprint. Emitted paths are `./`-prefixed and made
# root-relative by the callers.
#
# $1 abs dir, $2 find -type argument, $3 output file. Prunes generated dirs.
enumerate_source() {
	if ! (cd "$1" && find . \
		-path ./target -prune -o \
		-path ./wasm/out -prune -o \
		-name ".git" -prune -o \
		-type "$2" -print0) >"$3"; then
		die "enumerating $1 failed: find exited non-zero, so the input set is incomplete"
	fi
}

# $1 abs dir, $2 find -type argument, $3 output file. No pruning.
enumerate_plain() {
	if ! (cd "$1" && find . -type "$2" -print0) >"$3"; then
		die "enumerating $1 failed: find exited non-zero, so the file set is incomplete"
	fi
}

# --------------------------------------------------------------------------
# path normalisation, used only by the layout-rejection checks
# --------------------------------------------------------------------------

# $1 = directory the reference is relative to (root-relative, may be empty)
# $2 = the reference as written
# Prints the normalised root-relative path, or returns 1 if it escapes --root.
normalize_rel() {
	nr_escaped=0
	nr_out=""
	# Combine BEFORE splitting. Splitting `$1/$2` directly does not work: only
	# the results of expansions are split, so the literal `/` between them glues
	# the tail of $1 onto the head of $2 and `..` segments stop being their own
	# fields.
	nr_combined="$1/$2"
	nr_old_ifs="$IFS"
	set -f
	IFS='/'
	for nr_seg in $nr_combined; do
		case "$nr_seg" in
		"" | ".")
			continue
			;;
		"..")
			if [ -z "$nr_out" ]; then
				nr_escaped=1
				break
			fi
			case "$nr_out" in
			*/*) nr_out="${nr_out%/*}" ;;
			*) nr_out="" ;;
			esac
			;;
		*)
			if [ -z "$nr_out" ]; then
				nr_out="$nr_seg"
			else
				nr_out="$nr_out/$nr_seg"
			fi
			;;
		esac
	done
	IFS="$nr_old_ifs"
	set +f
	[ "$nr_escaped" -eq 0 ] || return 1
	printf '%s' "$nr_out"
}

# --------------------------------------------------------------------------
# arguments
# --------------------------------------------------------------------------

MODE="fingerprint"
ROOT=""
CONFIG_SCAN_FROM=""
LISTING=""
POLICY_NAMES=()
POLICY_VALUES=()
INCLUDES=()
EXCLUDES=()

while [ $# -gt 0 ]; do
	case "$1" in
	--manifest)
		MODE="manifest"
		shift
		;;
	--root)
		[ $# -ge 2 ] || die "--root requires a value"
		ROOT="$2"
		shift 2
		;;
	--config-scan-from)
		[ $# -ge 2 ] || die "--config-scan-from requires a value"
		CONFIG_SCAN_FROM="$2"
		shift 2
		;;
	--listing)
		[ $# -ge 2 ] || die "--listing requires a value"
		LISTING="$2"
		shift 2
		;;
	--policy)
		[ $# -ge 2 ] || die "--policy requires NAME=VALUE"
		case "$2" in
		*=*) ;;
		*) die "--policy expects NAME=VALUE, got '$2'" ;;
		esac
		POLICY_NAMES+=("${2%%=*}")
		POLICY_VALUES+=("${2#*=}")
		shift 2
		;;
	--include)
		[ $# -ge 2 ] || die "--include requires a value"
		INCLUDES+=("$2")
		shift 2
		;;
	--exclude)
		[ $# -ge 2 ] || die "--exclude requires a value"
		EXCLUDES+=("$2")
		shift 2
		;;
	*)
		die "unknown argument '$1'"
		;;
	esac
done

[ -n "$ROOT" ] || die "--root is required"
[ -d "$ROOT" ] || die "--root is not a directory: $ROOT"
# `pwd -P` throughout. Plain `pwd` is LOGICAL: it reports the path as it was
# reached, so a directory entered through a symlink (on macOS /var -> /private/var)
# compares unequal to the same directory reached physically. Two paths resolved
# with different `pwd` flavours can therefore name one directory and still fail an
# equality test, which silently disabled the guard below.
if ! ROOT_ABS="$(cd "$ROOT" && pwd -P)"; then
	die "cannot enter --root: $ROOT"
fi

# Writing the canonical listing inside the tree being hashed would mutate the
# input set while it is being read, and would then be hashed by the next run.
if [ -n "$LISTING" ]; then
	listing_parent="$(dirname "$LISTING")"
	if listing_parent_abs="$(cd "$listing_parent" 2>/dev/null && pwd -P)"; then
		listing_escapes=0
		[ "$listing_parent_abs" = "$ROOT_ABS" ] && listing_escapes=1
		case "$listing_parent_abs/" in
		"$ROOT_ABS"/*) listing_escapes=1 ;;
		esac
		if [ "$listing_escapes" -eq 1 ]; then
			printf '%s: --listing points inside --root: %s\n' "$SELF" "$LISTING" >&2
			printf '%s: writing it there would mutate the input set while it is being\n' "$SELF" >&2
			printf '%s: hashed, and the file would itself be hashed on the next run.\n' "$SELF" >&2
			die "choose a --listing path outside $ROOT_ABS"
		fi
	fi
fi

# --------------------------------------------------------------------------
# records
# --------------------------------------------------------------------------

# $1 tag, $2 root-relative path, $3 absolute path.
emit_record() {
	er_abs="$3"
	[ -e "$er_abs" ] || die "required file is missing: $2"
	[ -f "$er_abs" ] || die "required path is not a regular file: $2"
	[ -r "$er_abs" ] || die "required file is not readable: $2"
	if ! er_hash="$(hash_stdin <"$er_abs")"; then
		die "failed to hash: $2"
	fi
	is_sha256 "$er_hash" || die "bad digest '$er_hash' for: $2"
	if ! er_path_hex="$(hex_of "$2")"; then
		die "failed to encode path: $2"
	fi
	[ -n "$er_path_hex" ] || die "empty encoded path for: $2"
	printf '%s %s %s %s\n' "$1" "${#er_path_hex}" "$er_path_hex" "$er_hash"
}

RECORDS=""
FILE_COUNT=0

# `emit_record` runs in a command substitution, so its `die` cannot abort this
# shell by itself -- exactly what `inherit_errexit` used to paper over. The
# status is checked here instead.
append_record() {
	if ! ar_rec="$(emit_record "$1" "$2" "$3")"; then
		exit 1
	fi
	RECORDS="$RECORDS$ar_rec
"
	FILE_COUNT=$((FILE_COUNT + 1))
}

# ==========================================================================
# manifest mode
# ==========================================================================

if [ "$MODE" = "manifest" ]; then
	[ ${#INCLUDES[@]} -ne 0 ] || die "--manifest requires at least one --include"

	is_excluded() {
		ix_total=${#EXCLUDES[@]}
		ix_i=0
		while [ "$ix_i" -lt "$ix_total" ]; do
			[ "${EXCLUDES[$ix_i]}" = "$1" ] && return 0
			ix_i=$((ix_i + 1))
		done
		return 1
	}

	for include_rel in "${INCLUDES[@]}"; do
		include_abs="$ROOT_ABS/$include_rel"
		if [ -d "$include_abs" ]; then
			enumerate_plain "$include_abs" l "$SELF_TMP/links"
			if [ -s "$SELF_TMP/links" ]; then
				die "generated output tree contains a symlink under $include_rel; refusing to bind a receipt to it"
			fi
			enumerate_plain "$include_abs" f "$SELF_TMP/files"
			while IFS= read -r -d '' found_rel; do
				found_rel="$include_rel/${found_rel#./}"
				is_excluded "$found_rel" && continue
				append_record O "$found_rel" "$ROOT_ABS/$found_rel"
			done <"$SELF_TMP/files"
		elif [ -e "$include_abs" ]; then
			is_excluded "$include_rel" && continue
			append_record O "$include_rel" "$include_abs"
		else
			die "expected build output is missing: $include_rel"
		fi
	done

	[ "$FILE_COUNT" -ne 0 ] || die "the generated output set is empty"

	if ! SORTED="$(printf '%s' "$RECORDS" | LC_ALL=C sort)"; then
		die "failed to sort output records"
	fi
	[ -n "$SORTED" ] || die "sorting output records produced nothing"
	printf '%s\n' "$SORTED"
	exit 0
fi

# ==========================================================================
# fingerprint mode
# ==========================================================================

# -- the source tree ------------------------------------------------------

# The closure is the whole tree, so a vanished file would merely change the
# digest rather than be noticed. These few must exist: without them the tree is
# not a rewriter checkout at all, and silently fingerprinting the remains would
# turn a truncated working copy into a plausible-looking digest.
REQUIRED_PRESENT=(
	"Cargo.toml"
	"Cargo.lock"
	"rust-toolchain.toml"
	"wasm/Cargo.toml"
	"wasm/build.sh"
	"wasm/hash-inputs.sh"
)
for required_rel in "${REQUIRED_PRESENT[@]}"; do
	[ -f "$ROOT_ABS/$required_rel" ] || die "required build input is missing: $required_rel"
done

enumerate_source "$ROOT_ABS" l "$SELF_TMP/links"
if [ -s "$SELF_TMP/links" ]; then
	printf '%s: the source tree contains symlinks, which this fingerprint cannot cover:\n' "$SELF" >&2
	while IFS= read -r -d '' link_rel; do
		link_rel="${link_rel#./}"
		printf '%s:   %s -> %s\n' "$SELF" "$link_rel" "$(readlink "$ROOT_ABS/$link_rel" || echo '?')" >&2
	done <"$SELF_TMP/links"
	die "refusing to produce a digest for an unsupported layout (a symlink target may live outside --root, and find -type f skips symlinks entirely)"
fi

enumerate_source "$ROOT_ABS" f "$SELF_TMP/files"
while IFS= read -r -d '' found_rel; do
	found_rel="${found_rel#./}"
	append_record F "$found_rel" "$ROOT_ABS/$found_rel"
done <"$SELF_TMP/files"

[ "$FILE_COUNT" -ne 0 ] || die "no build inputs were hashed under $ROOT_ABS"

# -- best-effort screen for references this fingerprint cannot follow -------
#
# BEST EFFORT, NOT COMPLETE. This is a text screen, not a Rust or TOML parser,
# and it is documented as such deliberately rather than described as
# enforcement. What it does guarantee is direction: when it cannot resolve a
# reference it refuses instead of assuming. Completeness for what the compiler
# actually read comes from the dep-info cross-check in build.sh.
#
# Two counting rules matter here. Input is flattened to a single line first, so
# a construct spanning several lines is still one occurrence rather than a false
# positive. And occurrences are counted with `grep -o`, not matching lines, so
# two uses on one line cannot hide each other.

# $1 file (for messages), $2 what was found, $3 base dir, $4 referenced path
refuse_if_escaping() {
	case "$4" in
	/*) die "$1 has $2 with the absolute path '$4', which is outside --root and is not fingerprinted" ;;
	esac
	if ! normalize_rel "$3" "$4" >/dev/null; then
		die "$1 has $2 '$4', which resolves outside --root and is not fingerprinted"
	fi
}

# $1 file (for messages), $2 base dir, $3 regex for any use, $4 regex for the
# literal form, $5 regex capturing the literal, $6 label
screen_references() {
	sr_uses="$({ grep -o "$3" "$SELF_TMP/flat" || true; } | wc -l | tr -d ' ')"
	[ "${sr_uses:-0}" -ne 0 ] || return 0
	sr_lits="$({ grep -o "$4" "$SELF_TMP/flat" || true; } | wc -l | tr -d ' ')"
	if [ "${sr_uses:-0}" -ne "${sr_lits:-0}" ]; then
		die "$1 uses $6 with a path this screen cannot resolve (not a plain string literal); refusing rather than assuming it stays inside --root"
	fi
	grep -o "$5" "$SELF_TMP/flat" | sed 's/.*"\(.*\)"/\1/' >"$SELF_TMP/refs" || true
	while IFS= read -r sr_ref; do
		[ -n "$sr_ref" ] || continue
		refuse_if_escaping "$1" "$6" "$2" "$sr_ref"
	done <"$SELF_TMP/refs"
}

while IFS= read -r -d '' found_rel; do
	found_rel="${found_rel#./}"
	found_abs="$ROOT_ABS/$found_rel"
	case "$found_rel" in
	*/*) found_dir="${found_rel%/*}" ;;
	*) found_dir="" ;;
	esac

	case "$found_rel" in
	Cargo.toml | */Cargo.toml | *.rs) ;;
	*) continue ;;
	esac

	if ! tr '\n' ' ' <"$found_abs" >"$SELF_TMP/flat"; then
		die "cannot read $found_rel for the reference screen"
	fi

	case "$found_rel" in
	Cargo.toml | */Cargo.toml)
		# Both quote styles are legal TOML; only the double-quoted form was
		# screened before.
		grep -o "path[[:space:]]*=[[:space:]]*\"[^\"]*\"" "$SELF_TMP/flat" |
			sed 's/.*"\(.*\)"/\1/' >"$SELF_TMP/refs" || true
		while IFS= read -r dep_path; do
			[ -n "$dep_path" ] || continue
			refuse_if_escaping "$found_rel" "a path dependency" "$found_dir" "$dep_path"
		done <"$SELF_TMP/refs"
		grep -o "path[[:space:]]*=[[:space:]]*'[^']*'" "$SELF_TMP/flat" |
			sed "s/.*'\(.*\)'/\1/" >"$SELF_TMP/refs" || true
		while IFS= read -r dep_path; do
			[ -n "$dep_path" ] || continue
			refuse_if_escaping "$found_rel" "a path dependency" "$found_dir" "$dep_path"
		done <"$SELF_TMP/refs"
		;;
	*.rs)
		for macro_name in "include" "include_bytes" "include_str"; do
			screen_references "$found_rel" "$found_dir" \
				"${macro_name}![[:space:]]*(" \
				"${macro_name}![[:space:]]*([[:space:]]*\"" \
				"${macro_name}![[:space:]]*([[:space:]]*\"[^\"]*\"" \
				"${macro_name}!"
		done
		# #[path = "..."] relocates a module's file and can point anywhere.
		screen_references "$found_rel" "$found_dir" \
			"#\[[[:space:]]*path[[:space:]]*=" \
			"#\[[[:space:]]*path[[:space:]]*=[[:space:]]*\"" \
			"#\[[[:space:]]*path[[:space:]]*=[[:space:]]*\"[^\"]*\"" \
			"#[path]"
		;;
	esac
done <"$SELF_TMP/files"

# -- cargo configuration, discovered the way cargo discovers it ------------
#
# Recorded by DEPTH relative to the scan directory, never by absolute path, so
# a machine with no cargo configuration produces identical records wherever the
# checkout lives.

CONFIG_RECORDS=""

if [ -n "$CONFIG_SCAN_FROM" ]; then
	[ -d "$CONFIG_SCAN_FROM" ] || die "--config-scan-from is not a directory: $CONFIG_SCAN_FROM"
	if ! scan_dir="$(cd "$CONFIG_SCAN_FROM" && pwd -P)"; then
		die "cannot enter --config-scan-from: $CONFIG_SCAN_FROM"
	fi
	scan_depth=0
	while :; do
		for config_name in ".cargo/config.toml" ".cargo/config"; do
			config_abs="$scan_dir/$config_name"
			if [ -f "$config_abs" ]; then
				if ! config_hash="$(hash_stdin <"$config_abs")"; then
					die "failed to hash the cargo configuration at $config_abs"
				fi
				is_sha256 "$config_hash" || die "bad digest for $config_abs"
				if ! config_hex="$(hex_of "$config_name")"; then
					die "failed to encode $config_name"
				fi
				CONFIG_RECORDS="${CONFIG_RECORDS}C $scan_depth ${#config_hex} $config_hex $config_hash
"
			fi
		done
		[ "$scan_dir" != "/" ] || break
		scan_dir="$(dirname "$scan_dir")"
		scan_depth=$((scan_depth + 1))
	done
fi

CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
for config_name in "config.toml" "config"; do
	config_abs="$CARGO_HOME_DIR/$config_name"
	if [ -f "$config_abs" ]; then
		if ! config_hash="$(hash_stdin <"$config_abs")"; then
			die "failed to hash the cargo configuration at $config_abs"
		fi
		is_sha256 "$config_hash" || die "bad digest for $config_abs"
		if ! config_hex="$(hex_of "$config_name")"; then
			die "failed to encode $config_name"
		fi
		CONFIG_RECORDS="${CONFIG_RECORDS}H ${#config_hex} $config_hex $config_hash
"
	fi
done

# -- canonical listing ----------------------------------------------------

if ! SORTED_RECORDS="$(printf '%s' "$RECORDS" | LC_ALL=C sort)"; then
	die "failed to sort build input records"
fi
[ -n "$SORTED_RECORDS" ] || die "sorting build input records produced nothing"

LISTING_TEXT="$SORTED_RECORDS
"

if [ -n "$CONFIG_RECORDS" ]; then
	if ! SORTED_CONFIGS="$(printf '%s' "$CONFIG_RECORDS" | LC_ALL=C sort)"; then
		die "failed to sort cargo configuration records"
	fi
	LISTING_TEXT="${LISTING_TEXT}${SORTED_CONFIGS}
"
fi

policy_index=0
policy_total=${#POLICY_NAMES[@]}
while [ "$policy_index" -lt "$policy_total" ]; do
	policy_name="${POLICY_NAMES[$policy_index]}"
	policy_value="${POLICY_VALUES[$policy_index]}"
	[ -n "$policy_name" ] || die "policy record $policy_index has an empty name"
	if ! policy_name_hex="$(hex_of "$policy_name")"; then
		die "failed to encode policy name '$policy_name'"
	fi
	if ! policy_value_hex="$(hex_of "$policy_value")"; then
		die "failed to encode policy value for '$policy_name'"
	fi
	LISTING_TEXT="${LISTING_TEXT}P ${#policy_name_hex} $policy_name_hex ${#policy_value_hex} $policy_value_hex
"
	policy_index=$((policy_index + 1))
done

if ! DIGEST="$(printf '%s' "$LISTING_TEXT" | hash_stdin)"; then
	die "failed to hash the canonical listing"
fi
is_sha256 "$DIGEST" || die "computed digest is not a sha256 hex string: '$DIGEST'"

if [ -n "$LISTING" ]; then
	if ! printf '%s' "$LISTING_TEXT" >"$LISTING"; then
		die "failed to write the canonical listing to $LISTING"
	fi
fi

printf '%s\n' "$DIGEST"
