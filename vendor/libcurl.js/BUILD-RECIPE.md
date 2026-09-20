# Source build recipe

Builds libcurl.js from pristine `upstream/` + patches `0002`, `0003`, `0004`.
**`0001` is excluded**, and `prepare-build-tree.sh` aborts if its content ever
appears in the staged tree. This recipe has been executed successfully; the
commands below are the ones that worked, and they run from a fresh workspace
against pinned sources, not from any leftover state.

## Commands

```sh
WORK=<a fresh, empty directory outside this repository>

# 1. toolchain: standalone emsdk, EMSCRIPTEN 3.1.6 (see "toolchain" below --
#    3.1.72 builds cleanly and produces a dead artifact)
git clone https://github.com/emscripten-core/emsdk "$WORK/emsdk"
"$WORK/emsdk/emsdk" install  3.1.6
"$WORK/emsdk/emsdk" activate 3.1.6          # no --permanent: profile untouched

# 2. build-time python deps, in a venv (Mbed-TLS needs Jinja2; see below)
python3 -m venv "$WORK/buildpy"
"$WORK/buildpy/bin/pip" install jinja2==3.1.6 markupsafe==3.0.3

# 3. pinned CA bundle (sha256 checked by the prep script)
curl -fsSL https://curl.se/ca/cacert.pem -o "$WORK/cacert.pem"

# 4. stage pristine upstream + 0002/0003/0004 and pin every dependency
./prepare-build-tree.sh "$WORK/stage" "$WORK/cacert.pem"

# 5. build, with BOTH the toolchain and the venv on PATH
source "$WORK/emsdk/emsdk_env.sh"
export PATH="$WORK/buildpy/bin:$PATH"
cd "$WORK/stage/libcurl.js/client" && ./build.sh all
```

Outputs `client/out/libcurl_full.mjs` (the `libcurl.js/bundled` entry),
`client/out/libcurl.mjs` and `client/out/libcurl.wasm`.

## Wrapper

```sh
# pinned commit, fetched by SHA rather than a moving master
git init "$WORK/CurlTransport"
git -C "$WORK/CurlTransport" remote add origin https://github.com/MercuryWorkshop/CurlTransport
git -C "$WORK/CurlTransport" fetch --depth=1 origin 7daea4a6a87a78f77e003fe4134f8eec749552f0
git -C "$WORK/CurlTransport" checkout --detach FETCH_HEAD

cd "$WORK/CurlTransport"
# Deterministic: npm ci installs exactly the committed package-lock.json that
# ships at this commit, which already contains the typescript 5.7.3 that
# dts-bundle-generator needs. Do NOT use `npm install` here -- it ignores that
# lock and, on this commit, does not bring typescript in at all.
#
# `pnpm install --frozen-lockfile` does NOT work: the repository ships both
# lockfiles and its pnpm-lock.yaml disagrees with package.json over typescript,
# so pnpm refuses (exit 1, "1 dependencies were added: typescript@5.7.3").
npm ci --ignore-scripts

# copy esbuild.bundle.mjs and add ONE alias entry to both build() calls:
#   alias: { "libcurl.js/bundled": "<WORK>/stage/libcurl.js/client/out/libcurl_full.mjs" }
node esbuild.bundle.local.mjs
```

`dist/index.js` (+ `index.mjs`, `index.d.ts`) is the `LibcurlClient` bundle that
`--libcurl-dist` consumes. No WASM is spliced by hand; esbuild inlines our
single-file libcurl build.

`prepare-build-tree.sh` stages `upstream/` into `$WORK`, copies the patches to
`$WORK/patches` and applies them, then rewrites the **staged** copies of
upstream's scripts. It writes nothing outside `$WORK`, reads `upstream/` only,
and runs no compiler.

## What the prep rewrites, and why

| rewrite | reason |
| --- | --- |
| each `git clone -b <ref> --depth=1` → `git init` + `git fetch --depth=1 origin <commit>` + `checkout --detach FETCH_HEAD` | upstream clones a **moving branch** for curl and tags for the rest. Pre-populating `build/` does not work: every script does `rm -rf <dir>` and re-clones, so the pin has to live in the script. mbedtls additionally gets `submodule update --init --recursive --depth=1`. |
| `CORE_COUNT=$(nproc --all)` → `CORE_COUNT=2` in all six scripts | `nproc` does not exist on macOS, and every script passes `-j$CORE_COUNT` to make. Setting the variable is what actually enforces `-j2`; `MAKEFLAGS` would be overridden by those explicit `-j` flags. |
| `sed -i ` → `sed -i.bak ` (16 sites in `build.sh`, plus `cjson.sh`, `curl.sh`) | GNU in-place form; BSD `sed` requires a suffix. GNU accepts the suffixed form too. |
| `generate_cert.sh`: `wget` → copy of the pinned bundle, and the header is generated unconditionally | `wget` is absent here, the bundle is a moving download, and upstream's `if [ ! -f "$CACERT_FILE" ]` guard skips **header generation** too whenever the pem already exists — so pre-placing the pem alone would break the build. |

### Ordering — why the CA header is not generated early

`build.sh` already runs `tools/all_deps.sh` → `tools/generate_cert.sh` → compile.
That is the only correct order, because `generate_cert.sh` writes
`build/curl-wasm/include/cacert.h` and that prefix does not exist until the deps
are built. The prep therefore leaves the order alone and does **not** pre-create
`build/curl-wasm`: `all_deps.sh` treats an existing prefix as "already built" and
would skip `curl.sh` entirely, and `curl.sh` does `rm -rf $PREFIX` when it does
run, which would delete a header written beforehand. (An earlier draft of this
file got both of these wrong.)

## Pinned inputs

Upstream libcurl.js: commit `a641cdd857356db6b8ed46c5341cc8f85c4190ba`, v0.7.4,
LGPL-3.0-or-later, `client/wisp_client` vendored in the archive.

Resolved `2026-09-20T11:22:55Z` by `git ls-remote`, and baked into the prep:

| component | upstream ref | pinned commit | licence |
| --- | --- | --- | --- |
| curl (ading2210 fork) | `8.17.0-patched` (**branch**) | `a15072369578a37ce314ea4d8b06f30c2762ebcc` | curl (MIT-like) |
| mbedtls | `mbedtls-3.6.5` | `e185d7fd85499c8ce5ca2a54f5cf8fe7dbe3f8df` | Apache-2.0 OR GPL-2.0-or-later |
| zlib | `v1.3.1` | `51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf` | zlib |
| nghttp2 | `v1.68.0` | `534b74b72524e962c18c7146470914632ca7eb2d` | MIT |
| brotli | `v1.2.0` | `028fb5a23661f123017c060daa546b55cf4bde29` | MIT |
| cJSON | `v1.7.19` | `c859b25da02955fef659d658b8f324b5cde87be3` | MIT |

CA bundle, **pinned before the build rather than fetched during it**:

| field | value |
| --- | --- |
| source | `https://curl.se/ca/cacert.pem` |
| fetched | 2026-09-20 |
| sha256 | `f66dff1bdf8f96060b8177976f8b7d9254bc89bc4db933d769f7384d28480bc9` |
| size | 188900 bytes |
| content | "Certificate data from Mozilla as of: Thu Aug 13 03:12:01 2026 GMT" |
| licence | MPL-2.0 (Mozilla CA list, per curl.se/docs/caextract.html) |

`prepare-build-tree.sh` verifies that hash and refuses to stage on a mismatch.
`tools/gen_cert.py` was run against this exact file as a check: it produces a
631699-byte `cacert.h`.

These dependency licences and revisions **are** recorded in `THIRD_PARTY.md`, and
their texts are written beside the built artifact in `dist/licenses/`. That is a
provenance record, not a compliance certification.

## Toolchain

| item | state |
| --- | --- |
| emscripten | **3.1.6** — the version this build used and the one whose glue matches the published 0.7.4. Installed standalone under the workspace; the shared emsdk (5.0.7) was not activated or modified, and no shell profile was written. On darwin/arm64 `emsdk install 3.1.6` first tried `wasm-binaries-arm64.tar.xz`, got a 404, and succeeded on the `.tbz2` for the same SDK hash; expect that retry in the log rather than a failure |
| python | task-owned venv with `Jinja2 3.1.6` and `MarkupSafe 3.0.3`; no system packages installed |
| host | darwin/arm64. Upstream documents Linux as the only supported build OS, so `prepare-build-tree.sh` carries the portability rewrites (`nproc`, GNU `sed -i`, `wget`, `realpath`, zlib's archiver). No Linux host was used; `limactl` is installed with no instance, and Parallels is present, if a Linux builder is ever preferred |
| disk | not monitored continuously during the build. Free space was read at a few points and stayed at 24-26 GiB against the ~20 GiB floor; treat the floor as a pre-stage check, not a measured guarantee |
| static checks | all rewritten scripts pass `bash -n`; staged `http.c` compiles `-fsyntax-only` against the pinned curl headers with 0 errors; staged `http.js` passes `node --check` |

Before a rebuild, check free space against the floor prior to the toolchain
install, the dependency build and the client build. That is a manual check in
this recipe; nothing here monitors it.

## Wrapper provenance

Source: `https://github.com/MercuryWorkshop/CurlTransport`. The registry
metadata has **no `gitHead`** and the repository has **no tags**; the pinned
commit `7daea4a6a87a78f77e003fe4134f8eec749552f0` declares `version 2.0.5`,
which is the only available correspondence and is **not** proof of
byte-identity with the published tarball.

Its devDependencies are installed under the build workspace only. Nothing in
this repository's `node_modules` is touched, and nothing is republished.

The earlier `make-local-transport.py`, which transformed the published bundle
instead of building it, has been removed now that this build is verified. Its
outputs and logs are retained outside the repository as history.

## Build result (executed 2026-09-20)

Artifact identity. These sha256 values were computed by reading the retained
files when this section was written; they were not captured by the build itself
and nothing here verifies them automatically.

| file | sha256 |
| --- | --- |
| `client/out/libcurl.wasm` | `45d234ccc98bb8e3ec83fc7ece908dab5e92e9dc19f0a97ee2a48ed12c376d32` |
| `client/out/libcurl_full.mjs` | `85e811d5fb4ab21128d3761c8f4ffd33f0379693ba9e2bc12e8d92c8e6096d5c` |
| wrapper `dist/index.js` | `0c7abdabcbbc156ec60fa762caf5c9d1c6f2d0a7f2f4e7e878c68e98452c65fa` |
| wasm embedded in that bundle | `a10b9370a754440566bddd45386f243f87b9676355d27f5ad4fb148e438e9ab2` (len 1839200) |
| same blob in the **published** 2.0.5 | `6bb7508074ccfc7b1119af88429d6757084475c6dbef7259626e79a84355ecdf` (len 1875452) |

The last two differ, which is what shows the wasm is compiled here rather than
copied from the published bundle. A rebuild is not expected to reproduce these
byte for byte; emscripten output is not pinned to be reproducible.

The artifact in `dist/index.js` is that build's output: its sha256 is the
`wrapper dist/index.js` value above, re-read from the file rather than taken from
the build log.


Built on darwin/arm64 with a task-owned emsdk. Two findings worth keeping:

1. **jinja2 is a hard build dependency.** Mbed-TLS's `no_test` target generates
   `test_certs.h` with a Jinja template; without it the build dies after the
   libraries are archived, leaving an EMPTY `build/mbedtls-wasm` prefix that
   `all_deps.sh` then treats as "already built". Installed into a task-owned
   virtualenv.
2. **emcc 3.1.6, not 3.1.72.** Both are listed as tested upstream, but with
   3.1.72 the `SINGLE_FILE` glue never assigns `wasmBinaryFile`; the data URI
   goes to a local instead. `fragments/load_later.js` gates initialisation on
   `wasmBinaryFile && isDataURI(wasmBinaryFile)`, so with 3.1.72 that guard is
   permanently false, `createWasm()` and `run()` never execute, and libcurl
   never initialises — every request hangs with no error. 3.1.6 emits
   `wasmBinaryFile="data:application/octet-stream;base64,…"`, which is also what
   the published 0.7.4 artifact contains, so 3.1.6 is what upstream shipped
   with. This is a genuine incompatibility in the fragment, not a toolchain
   preference: `build.sh all` exits 0 either way, and only the runtime differs.

`prepare-build-tree.sh` also had to fix one more portability defect: `realpath
build/<x>-wasm` is evaluated before those prefixes exist, which GNU realpath
allows and BSD realpath rejects (18 sites), and zlib's configure selects Apple's
`libtool` as archiver on macOS, which silently produces a 96-byte `libz.a` from
wasm objects ("not a mach-o") — `AR=emar ARFLAGS=rc` fixes it.

## Where the built artifact goes

`dist/` in this directory holds the reviewed build, with its licences,
`SOURCES.md`, `BUILD.md` and `source.tar.gz`. It is the source of truth for the
artifact:

- running Runway from this repository resolves it directly at
  `vendor/libcurl.js/dist`
- `packages/runway/build.mjs` copies it to `packages/runway/dist/assets/libcurl`,
  so `pnpm pack` carries it and an installed consumer resolves it
  package-relatively

`dist/` is **gitignored**: it exists only where a build has been run. A fresh
clone carries this recipe, the pristine source and the patches, but no artifact
and no `source.tar.gz`/`licenses/` — those are produced by the build — so the
commands above must be run before Runway can build or pack.

Rebuild with the commands above and copy the wrapper's `dist/` over
`vendor/libcurl.js/dist`, keeping the licence files and refreshing `SOURCES.md`.
The Runway build **fails** if the artifact is absent; it never falls back to the
published package.

### The GPL-3.0 text, and who copies it where

LGPL-3.0 incorporates the terms and conditions of GPL-3.0 and only supplements
them, and upstream ships the supplement alone, so `LICENSE.GPL-3.0` is kept in
this directory. `PROVENANCE.md` records its source and checksum. This is material
completeness, not a compliance certification.

Two destinations, and only one of them is automatic:

- **The packaged Runway asset — done by the build.** `packages/runway/build.mjs`
  copies `vendor/libcurl.js/LICENSE.GPL-3.0` to
  `dist/assets/libcurl/LICENSE.GPL-3.0`, beside the artifact's own
  `LICENSE.libcurl.js-LGPL-3.0-or-later` (the artifact-level texts sit there;
  `licenses/` holds the native components'). It reads the tracked file, so this
  does not depend on the built artifact carrying one, and the build fails if that
  file is absent.
- **The artifact and its source archive — packaging, done with the commands
  below.** `dist/` is not in git, so each build produces its own; a `dist/` packaged
  before this text was retained does not contain it. The Runway build does not fix
  that: it copies `source.tar.gz` as one opaque file and never opens it.

A fresh build should place the text in `dist/` directly. For a `dist/` that already
exists, the same result is reached without recompiling anything — no emsdk, no
libcurl, Mbed-TLS or wrapper rebuild, and no change to `index.js`, `index.mjs` or
the embedded WebAssembly.

What is preserved is the **content** of every file already in the archive, byte for
byte, along with each member's mode and order. What changes is the member list, the
`source/` directory entry's mtime, and — because gzip is not reproducible here — the
archive bytes as a whole.

Run it as one `bash` block. Any failure in validation, extraction or archive
creation leaves the existing `dist/source.tar.gz` exactly as it was: the new archive
is built at a staging path of our own inside `dist/` and only replaces the original
by rename, as the last step that can fail. The two steps after that rename — copying
the adjacent `dist/LICENSE.GPL-3.0` and editing `dist/SOURCES.md` — are separate and
are not covered by it, so if one of them fails the archive is already updated and
the other has to be finished by hand. This is a single-operator packaging step, not
a concurrent-safe transaction:

```sh
bash -euo pipefail -c '
cd vendor/libcurl.js                       # fail closed if run from elsewhere
root=$PWD
archive=$root/dist/source.tar.gz
licence=$root/LICENSE.GPL-3.0
staged=$root/dist/source.tar.gz.new        # ours, adjacent, never a live path
test -f "$archive" && test -f "$licence"

# Refuse any leftover at the staging path, including a dangling symlink, which
# test -e does not see. Checked before the trap is armed, so something we did not
# create is never removed.
if test -e "$staged" || test -L "$staged"; then
	echo "refusing: $staged already exists; inspect and remove it yourself" >&2
	exit 1
fi

work=$(mktemp -d)
trap "rm -rf -- \"$work\"; rm -f -- \"$staged\"" EXIT   # only these two

# Listings run as their own commands and are saved first, so a tar failure aborts
# here. Never put tar in the condition of an if: its exit status is then ignored.
tar -tzf "$archive" > "$work/names.txt"
tar -tvzf "$archive" > "$work/types.txt"

# Names: one source/ root, nothing else, and a conservative character set. A
# line-oriented listing cannot represent a newline in a name, so anything outside
# this set is rejected rather than interpreted.
#
# Every search below is written `|| test "$?" -eq 1`, never `|| true`: grep exits 1
# for "no match" but 2 for a read error, and only 1 may be tolerated.
LC_ALL=C grep -vE "^source/([A-Za-z0-9._@+-]+/)*[A-Za-z0-9._@+-]*$" \
	"$work/names.txt" > "$work/bad-names.txt" || test "$?" -eq 1
LC_ALL=C grep -E "(^|/)\.\.(/|$)" "$work/names.txt" \
	>> "$work/bad-names.txt" || test "$?" -eq 1
if test -s "$work/bad-names.txt"; then
	echo "refusing: unexpected member name" >&2; cat "$work/bad-names.txt" >&2; exit 1
fi

# Types: regular files and directories only, from the saved listing.
LC_ALL=C grep -vE "^[-d]" "$work/types.txt" > "$work/bad-types.txt" || test "$?" -eq 1
if test -s "$work/bad-types.txt"; then
	echo "refusing: link, device or other special entry" >&2
	cat "$work/bad-types.txt" >&2; exit 1
fi

# Expected layout: exactly one anchor to insert beside, and not already licensed.
# Each count is its own checked assignment, so a grep error cannot read as a count.
anchors=$(LC_ALL=C grep -cx "source/BUILD\.md" "$work/names.txt") || test "$?" -eq 1
licences=$(LC_ALL=C grep -cx "source/LICENSE\.GPL-3\.0" "$work/names.txt") \
	|| test "$?" -eq 1
test "$anchors" -eq 1
if test "$licences" -ne 0; then
	echo "archive already carries source/LICENSE.GPL-3.0; nothing to do" >&2; exit 1
fi

tar -xzpf "$archive" -C "$work"
install -m 644 "$licence" "$work/source/LICENSE.GPL-3.0"
cmp -s "$licence" "$work/source/LICENSE.GPL-3.0"

# Original order, new name beside BUILD.md, inserted exactly once.
awk "{ print } \$0 == \"source/BUILD.md\" { print \"source/LICENSE.GPL-3.0\" }" \
	"$work/names.txt" > "$work/order.txt"
test "$(wc -l < "$work/order.txt")" -eq "$(( $(wc -l < "$work/names.txt") + 1 ))"

( cd "$work" && tar -czf "$staged" --no-recursion \
	--uid 0 --gid 0 --uname "" --gname "" -T order.txt )

# Validate the staged archive before it can replace anything.
tar -tzf "$staged" > "$work/new-names.txt"
diff "$work/order.txt" "$work/new-names.txt"
mkdir "$work/check"
tar -xzpf "$staged" -C "$work/check" source/LICENSE.GPL-3.0
cmp -s "$licence" "$work/check/source/LICENSE.GPL-3.0"

mv -f -- "$staged" "$archive"               # atomic rename, last step
cp -- "$licence" "$root/dist/LICENSE.GPL-3.0"
'
```

Then add `LICENSE.GPL-3.0` to the licence table in `dist/SOURCES.md` and list
`source/LICENSE.GPL-3.0` among its corresponding-source contents.

Flags are bsdtar 3.5.3 (libarchive), the `tar` on macOS; `--uid`/`--gid` keep the
uid/gid 0 the existing members carry. GNU tar spells that `--owner=0 --group=0
--numeric-owner`, which has not been exercised here. `touch -r` the `source/`
directory from an untouched extraction before packing if you want that entry's mtime
to match the previous archive too.

The archive is **not** reproducible byte for byte: this gzip stream sets no `FNAME`
flag but does carry a non-zero `MTIME` in its header, so repacking identical
contents still yields a different `source.tar.gz` hash. Compare member lists and
per-file hashes, not archive hashes.

### Where this has and has not been applied

The `dist/` artifact used for development here has been updated by the commands
above: its `source.tar.gz` carries `source/LICENSE.GPL-3.0`, the text sits beside it
as `dist/LICENSE.GPL-3.0`, and `dist/SOURCES.md` records both. `index.js`,
`index.mjs`, `index.d.ts` and the eight texts in `licenses/` were not touched.

Not done, and not to be assumed:

- `packages/runway/dist` was **not** rebuilt afterwards, so a Runway asset built
  before this still carries the pre-licence `source.tar.gz`. Re-run the Runway build
  to refresh it.
- No `pnpm pack`, `npm pack` or installed-consumer check has been run against the
  licence-bearing archive. Earlier packaging and `check-package` evidence in this
  repository refers to the **pre-licence** artifact and says nothing about this one.

## Status

Runway now defaults to this artifact, so its own runs no longer use the
published 2.0.5. That is a local default, not a release: nothing is published,
and any other consumer of `@mercuryworkshop/libcurl-transport` (bootstrap, demo)
still gets the unfixed upstream build. Landing the fixes upstream, or publishing
a maintained fork, remains open.
