#!/bin/bash
# Stage a buildable libcurl.js tree: pristine upstream + patches 0002, 0003, 0004.
# Patch 0001 (scoped CA trust) is NEVER applied.
#
# Prepares only. It runs no compiler and downloads nothing: the CA bundle must
# already be pinned on disk and is passed in.
#
#   ./prepare-build-tree.sh <work-dir> <pinned-cacert.pem>
#
# Nothing outside <work-dir> is written, and `upstream/` is only ever read.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WORK_IN="${1:?usage: prepare-build-tree.sh <work-dir> <pinned-cacert.pem>}"
CACERT_IN="${2:?usage: prepare-build-tree.sh <work-dir> <pinned-cacert.pem>}"

# This script never deletes anything. It only ever creates a staging directory
# that did not exist, so a mistaken or symlinked argument cannot destroy a tree.
#
# Canonicalise both arguments through their PHYSICAL parents before any `cd`, so
# a symlinked component cannot make a later relative path land somewhere else.
canonical_parent() {
  local p="$1" dir base
  dir="$(dirname "$p")"; base="$(basename "$p")"
  [ -d "$dir" ] || { echo "no such directory: $dir" >&2; exit 1; }
  printf '%s/%s\n' "$(cd "$dir" && pwd -P)" "$base"
}

# An EXISTING work directory has to be resolved through itself, not through its
# parent: a symlinked work directory whose parent sits outside the repository
# would otherwise pass the scope check below and still be written inside it.
# A work directory that does not exist yet has no such indirection, so resolving
# its existing parents is enough.
if [ -L "$WORK_IN" ]; then
  echo "refusing: the work directory is a symlink: $WORK_IN" >&2
  echo "pass the real directory, so the scope check sees where writes land" >&2
  exit 1
elif [ -d "$WORK_IN" ]; then
  WORK="$(cd "$WORK_IN" && pwd -P)"
elif [ -e "$WORK_IN" ]; then
  echo "refusing: the work directory exists and is not a directory: $WORK_IN" >&2
  exit 1
else
  WORK="$(canonical_parent "$WORK_IN")"
fi

CACERT="$(canonical_parent "$CACERT_IN")"

# Pinned as of 2026-09-20T11:22:55Z. Upstream's scripts clone a branch or tag;
# these are the exact commits those refs pointed at, fetched by SHA so a moving
# ref cannot silently change what is built.
CACERT_SHA256="f66dff1bdf8f96060b8177976f8b7d9254bc89bc4db933d769f7384d28480bc9"

[ -f "$CACERT" ] || { echo "missing pinned CA bundle: $CACERT" >&2; exit 1; }
have="$(shasum -a 256 "$CACERT" | awk '{print $1}')"
[ "$have" = "$CACERT_SHA256" ] || {
  echo "CA bundle hash mismatch:" >&2
  echo "  expected $CACERT_SHA256" >&2
  echo "  found    $have" >&2
  exit 1
}

SRC="$HERE/upstream"
TREE="$WORK/libcurl.js"
PATCHDIR="$WORK/patches"

# Refuse to stage anywhere inside this tree: the staging directory must never be
# able to collide with `upstream/`, the patches, or anything else shipped next to
# this script -- in a checkout or in an extracted package alike.
case "$WORK/" in
  "$HERE"/*|"$(cd "$HERE/../.." && pwd -P)"/*)
    echo "refusing to stage inside this source tree: $WORK" >&2; exit 1;;
esac

# The staging target must not already exist, in any form. -e is false for a
# dangling symlink, so -L is tested too; otherwise a dangling link would be
# followed on write.
for target in "$TREE" "$PATCHDIR"; do
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "refusing: staging target already exists: $target" >&2
    echo "use a fresh work directory; this script deletes nothing" >&2
    exit 1
  fi
done

mkdir -p "$WORK"
# Atomic: mkdir without -p fails if the directory appeared in the meantime, so
# two runs cannot silently merge into one tree.
mkdir "$TREE"
mkdir "$PATCHDIR"
# Copy into the directory just created, rather than letting cp choose a name.
cp -R "$SRC"/. "$TREE"/

# The patches travel with the tree so the staged source is self-describing.
cp "$HERE/patches/0002-null-body-304-and-header-callback-settlement.patch" \
   "$HERE/patches/0003-head-requests-set-curlopt-nobody.patch" \
   "$HERE/patches/0004-head-responses-have-a-null-body.patch" \
   "$WORK/patches/"

cd "$TREE"
for p in 0002-null-body-304-and-header-callback-settlement \
         0003-head-requests-set-curlopt-nobody \
         0004-head-responses-have-a-null-body; do
  git apply -p1 --check "$WORK/patches/$p.patch"
  git apply -p1 "$WORK/patches/$p.patch"
  echo "applied $p"
done

# Refuse to continue if 0001 ever leaks in.
if grep -rq "trust_profile\|cacert_hosts" client/libcurl client/javascript; then
  echo "patch 0001 content present in the staged tree, refusing" >&2
  exit 1
fi

# Rewrites to the STAGED copies of upstream's build scripts. Three classes:
# pinned checkouts, a fixed -j2, and enough portability to run off Linux.
# Upstream's own build behaviour is not otherwise changed.
CACERT_ABS="$(cd "$(dirname "$CACERT")" && pwd)/$(basename "$CACERT")"
CACERT_ABS="$CACERT_ABS" python3 - <<'PY'
import os, pathlib, re

tools = pathlib.Path("client/tools")

# dir, url, commit, recursive
PINS = {
    "mbedtls.sh": ("mbedtls",  "https://github.com/Mbed-TLS/mbedtls",   "e185d7fd85499c8ce5ca2a54f5cf8fe7dbe3f8df", True),
    "cjson.sh":   ("cjson",    "https://github.com/DaveGamble/cJSON",   "c859b25da02955fef659d658b8f324b5cde87be3", False),
    "zlib.sh":    ("zlib",     "https://github.com/madler/zlib",        "51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf", False),
    "brotli.sh":  ("brotli",   "https://github.com/google/brotli",      "028fb5a23661f123017c060daa546b55cf4bde29", False),
    "nghttp2.sh": ("nghttp2",  "https://github.com/nghttp2/nghttp2",    "534b74b72524e962c18c7146470914632ca7eb2d", False),
    "curl.sh":    ("curl",     "https://github.com/ading2210/curl",     "a15072369578a37ce314ea4d8b06f30c2762ebcc", False),
}

def pinned_clone(d, url, commit, recursive):
    lines = [
        f"# pinned by prepare-build-tree.sh: fetch the exact commit, not a moving ref",
        f"git init -q {d}",
        f"git -C {d} remote add origin {url}",
        f"git -C {d} fetch -q --depth=1 origin {commit}",
        f"git -C {d} checkout -q --detach FETCH_HEAD",
    ]
    if recursive:
        lines.append(f"git -C {d} submodule update --init --recursive --depth=1")
    return "\n".join(lines)

for name, (d, url, commit, rec) in PINS.items():
    p = tools / name
    text = p.read_text()

    clone = [l for l in text.splitlines() if l.startswith("git clone")]
    assert len(clone) == 1, (name, clone)
    text = text.replace(clone[0], pinned_clone(d, url, commit, rec), 1)

    assert text.count("CORE_COUNT=$(nproc --all)") == 1, name
    text = text.replace("CORE_COUNT=$(nproc --all)", "CORE_COUNT=2", 1)

    # zlib's configure picks the host archiver, and on macOS that is Apple's
    # libtool, which rejects wasm objects ("not a mach-o") and silently produces
    # an empty libz.a. emar is the correct archiver for these objects.
    if name == "zlib.sh":
        old = "emmake make -j$CORE_COUNT"
        assert text.count(old) == 1, name
        text = text.replace(old, "emmake make AR=emar ARFLAGS=rc -j$CORE_COUNT", 1)

    # BSD sed needs a suffix for -i; GNU accepts one too.
    text = text.replace("sed -i 's/", "sed -i.bak 's/")
    text = text.replace("sed -i '/", "sed -i.bak '/")
    p.write_text(text)
    print(f"pinned {name} -> {commit[:12]} (-j2)")

# `realpath build/<x>-wasm` is evaluated before those prefixes exist. GNU
# realpath allows a missing final component; BSD realpath does not and fails
# outright, so every dep script aborts on the first line. `build/` itself always
# exists by then (all_deps.sh and each script mkdir it), so resolving the parent
# physically and appending the name is equivalent and portable.
# realpath, inside the same block (it is Python, not shell).
total = 0
for sh in sorted(pathlib.Path("client/tools").glob("*.sh")):
    t = sh.read_text()
    new, n = re.subn(
        r'\$\(realpath build/([A-Za-z0-9._-]+)\)',
        lambda m: '"$(cd build && pwd -P)/%s"' % m.group(1),
        t,
    )
    if n:
        sh.write_text(new)
        total += n
print(f"realpath: {total} use(s) made portable")

# build.sh: portable in-place edits only.
b = pathlib.Path("client/build.sh")
t = b.read_text()
n = t.count("sed -i ")
t = t.replace("sed -i ", "sed -i.bak ")
b.write_text(t)
print(f"build.sh: {n} in-place edits made portable")

# generate_cert.sh runs from build.sh AFTER all_deps.sh, which is the only point
# where build/curl-wasm/include exists. Upstream fetches the bundle with wget at
# that moment, and its guard skips header generation whenever the pem is already
# present. Both are replaced: the pinned bundle is copied in, and the header is
# always generated.
g = pathlib.Path("client/tools/generate_cert.sh")
t = g.read_text()
old = t[t.index('if [ ! -f "$CACERT_FILE" ]; then'):]
new = (
    'cp "%s" "$CACERT_FILE"\n'
    'python3 tools/gen_cert.py "$CACERT_FILE" > "$CACERT_HEADER"\n'
    % os.environ["CACERT_ABS"]
)
g.write_text(t.replace(old, new, 1))
print("generate_cert.sh: pinned bundle, header always generated")
PY

cat <<EOF

staged: $TREE
patches: $WORK/patches (0002, 0003, 0004; 0001 excluded)

Next, with emcc 3.1.6 and the build venv on PATH — NOT run by this script.
Use 3.1.6: with 3.1.72 the build succeeds but the artifact never initialises.
See BUILD-RECIPE.md.

  cd "$TREE/client" && ./build.sh all

build.sh already orders this correctly: tools/all_deps.sh (which creates
build/curl-wasm) runs first, then tools/generate_cert.sh writes cacert.h into
that prefix, then the client is compiled. Do not pre-create build/curl-wasm:
all_deps.sh treats an existing prefix as "already built" and skips curl, and
curl.sh deletes the prefix when it does run.

Outputs: client/out/libcurl.mjs, client/out/libcurl_full.mjs (= libcurl.js/bundled),
client/out/libcurl.wasm
EOF
