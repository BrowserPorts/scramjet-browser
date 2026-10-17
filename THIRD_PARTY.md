# Third-party runtime components

This file records what each component is and where it came from. It is a
provenance record, not a legal compliance certification.

## @mercuryworkshop/libcurl-transport (optional transport wrapper)

The published package that wraps libcurl.js in the `BareTransport` shape and
inlines it. It is a **separate work under a different licence** from libcurl.js
itself, so it is listed separately.

| field | value |
| --- | --- |
| component | @mercuryworkshop/libcurl-transport |
| version | 2.0.5 |
| license | **AGPL-3.0-only** (same as this repository's root licence) |
| license text | shipped in the package as `LICENSE`, copied into any local artifact |
| upstream source | not vendored here; built from the pinned commit `7daea4a6a87a78f77e003fe4134f8eec749552f0` (declares 2.0.5; **not** claimed byte-equivalent to the published tarball) |
| local modifications | none to the installed package, which stays the published 2.0.5 |
| local artifact | built from that source against our source-built libcurl.js (`BUILD-RECIPE.md`); the wrapper's own source ships inside `source.tar.gz`. Build-time only, not shipped as code: `typescript 5.7.3` (Apache-2.0), `Jinja2 3.1.6` / `MarkupSafe 3.0.3` (BSD-3-Clause), Emscripten 3.1.6 (MIT/UIUC) |
| bundled into the default SDK | **no** |
| shipped in the Runway package | **yes** — `dist/assets/libcurl/`, built from `vendor/libcurl.js/dist`. Ships with `SOURCES.md`, `BUILD.md`, both licence texts, the native licence texts in `licenses/`, and the corresponding source as `source.tar.gz` (pristine libcurl.js + the three applied patches + wrapper source + the exact CA bundle) |
| inclusion mode | optional transport: only the scramjet harness page loads it, the bare lane never does, and no Runway module imports it. Runway serves it by default; `--libcurl-dist` still overrides. Other packages here (bootstrap, demo) still use the published 2.0.5 |

Note: this wrapper inlines libcurl.js (LGPL-3.0-or-later) into an AGPL-3.0-only
distribution, in both the published bundle and our local build. Both licences
are recorded here; their interaction is not assessed, and nothing in this file
is a compliance guarantee.

## libcurl.js (optional transport)

| field | value |
| --- | --- |
| component | libcurl.js |
| version | 0.7.4 |
| upstream commit | `a641cdd857356db6b8ed46c5341cc8f85c4190ba` |
| upstream | https://github.com/ading2210/libcurl.js |
| license | **LGPL-3.0-or-later** |
| license text | `vendor/libcurl.js/LICENSE` |
| vendored source | `vendor/libcurl.js/upstream/` (pristine) |
| local modifications | `patches/0002-…`, `patches/0003-…`, `patches/0004-…` — all three applied in the local source build. `patches/0001-scoped-per-session-ca-trust.patch` is **not applied and not built** |
| provenance | `vendor/libcurl.js/PROVENANCE.md` |
| bundled into the default SDK | **no** |
| inclusion mode | optional, dynamically imported |

### Components compiled into the WebAssembly artifact

Fetched at build time by `vendor/libcurl.js/upstream/client/tools/*.sh`. The
revisions below are the ones `vendor/libcurl.js/prepare-build-tree.sh` pins and
the ones actually consumed by the local source build. Sources are not vendored
here; each is re-fetchable by the exact commit, and the checkouts are retained
in the build workspace.

| component | commit | licence |
| --- | --- | --- |
| curl (`ading2210/curl`, branch `8.17.0-patched`) | `a15072369578a37ce314ea4d8b06f30c2762ebcc` | curl (MIT-like) |
| *(licence texts for the six below ship in `packages/runway/dist/assets/libcurl/licenses/`)* | | |
| Mbed-TLS | `e185d7fd85499c8ce5ca2a54f5cf8fe7dbe3f8df` | Apache-2.0 OR GPL-2.0-or-later |
| zlib | `51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf` | zlib |
| nghttp2 | `534b74b72524e962c18c7146470914632ca7eb2d` | MIT |
| brotli | `028fb5a23661f123017c060daa546b55cf4bde29` | MIT |
| cJSON | `c859b25da02955fef659d658b8f324b5cde87be3` | MIT |
| wisp_client (submodule, vendored in `upstream/`) | `455b9186bfbd0915ed7082c9d356af2157ab014f` | as distributed with libcurl.js |
| CA bundle (`curl.se/ca/cacert.pem`, Mozilla data 2026-08-13) | sha256 `f66dff1bdf8f96060b8177976f8b7d9254bc89bc4db933d769f7384d28480bc9` | MPL-2.0 |

Build-time only, not shipped: Emscripten SDK (MIT/UIUC, toolchain 3.1.6), and
the Python packages `Jinja2 3.1.6` and `MarkupSafe 3.0.3` (both BSD-3-Clause),
needed by Mbed-TLS's generator. Installed into a task-owned virtualenv, never
system-wide.

This table records provenance and the licence each project declares. It is not a
legal compliance certification.

| component | upstream | licence |
| --- | --- | --- |
| curl | github.com/ading2210/curl (fork of curl/curl) | curl licence (MIT/X-derivative) |
| mbedTLS | github.com/Mbed-TLS/mbedtls | Apache-2.0 (dual Apache-2.0 / GPL-2.0-or-later upstream) |
| cJSON | github.com/DaveGamble/cJSON | MIT |
| brotli | github.com/google/brotli | MIT |
| zlib | github.com/madler/zlib | zlib |
| nghttp2 | github.com/nghttp2/nghttp2 | MIT |

`cJSON` and `brotli` were missing from the first version of this file; they are
linked by `client/build.sh` (`-lcjson -lbrotlidec -lbrotlicommon`) and cJSON is
used directly by `client/libcurl/http.c`.

**Not yet satisfied.** The LGPL source-offer and relink obligations are only
fully met once the artifact is actually built and the exact fetched revisions and
licences of the six components above are captured alongside it. Until that build
runs, this file records intent and the audit performed on the build scripts, not
a discharged obligation. The pinned revisions must be recorded at build time.

### LGPL obligations: status

- **Optional and dynamically imported.** The transport is not linked into the
  default bundle; consumers opt in, and the import is dynamic. This keeps the
  copyleft boundary at the optional component.
- **Source offer, partial.** The shim source for the version used is in this
  repository at `vendor/libcurl.js/upstream/` at the exact upstream commit
  above, with the patch applied to it. This is NOT yet the complete
  corresponding source: the six components in the table are fetched at build
  time and their exact revisions are not captured here. The offer is only
  dischargeable once a build records them.
- **Modifications are identified.** Every local change is carried as a separate
  patch file rather than folded into the upstream bytes, and is listed in
  `PROVENANCE.md`.
- **Relinking, pending.** The artifact is produced by upstream's own
  `client/build.sh` and the invocation is recorded in `vendor/libcurl.js/BUILD-RECIPE.md`, but no
  artifact has been built yet, so relink instructions are untested.
- **License text** is distributed verbatim at `vendor/libcurl.js/LICENSE`.
