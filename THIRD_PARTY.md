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
| license text | `vendor/libcurl.js/LICENSE` — upstream's LGPLv3 text verbatim, byte-identical to `upstream/LICENSE` |
| vendored source | `vendor/libcurl.js/upstream/` (pristine) |
| local modifications | `patches/0002-…`, `patches/0003-…`, `patches/0004-…` — all three applied in the local source build. A scoped CA-trust patch (historically `0001`) is **not vendored here, not applied and not built**; see `PROVENANCE.md` |
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
| *(licence texts for the six below — plus `wisp_client` and the CA bundle — are written beside the built artifact in `vendor/libcurl.js/dist/licenses/` and copied to `packages/runway/dist/assets/libcurl/licenses/`; both are build outputs, not tracked in git)* | | |
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

**Build status.** The artifact was built from this source on 2026-09-20, and the
exact revisions of every fetched component are recorded: in the table above, in
`vendor/libcurl.js/prepare-build-tree.sh`, which pins them, and in the `BUILD.md`
that the build writes beside the artifact. An earlier version of this file said
no artifact had been built and that the fetched revisions were not captured —
both statements are obsolete, and the six commits above are the ones the executed
build consumed.

### Source, licence and relink materials: what exists, and where

Nothing in this section is a legal conclusion or a compliance guarantee. It
records which materials exist, which are in git, and which have been checked.

- **Optional, and not in the default bundle.** Neither libcurl.js nor the AGPL
  wrapper is linked into the default SDK bundle. No Runway module imports the
  transport statically, only the scramjet harness page loads it, and the bare
  lane never does. Runway resolves the local artifact by default for its own
  runs, and `--libcurl-dist` overrides that. Other packages here (bootstrap,
  demo) still consume the published 2.0.5 from the registry.
- **In git: the source, not the binary.** This repository tracks the pristine
  upstream tree (`vendor/libcurl.js/upstream/`), its per-file `upstream.sha256`
  manifest, the three patches, `prepare-build-tree.sh`, `BUILD-RECIPE.md` and the
  LGPL text. It does **not** track the built artifact: `vendor/libcurl.js/dist/`
  is gitignored, so a fresh clone carries the materials to rebuild but no binary,
  and no `source.tar.gz` or `licenses/` tree — those are build outputs.
- **Beside the built artifact: the corresponding source.** The local build
  carries `source.tar.gz` (pristine `upstream/`, `upstream.sha256`, the three
  patches, `prepare-build-tree.sh`, the wrapper source at its pinned commit, the
  exact `cacert.pem`, `licenses/` and `BUILD.md`), the two artifact licence
  texts, and the native licence texts unpacked in `licenses/`. A packed Runway
  tarball was inspected and contained all of it under `dist/assets/libcurl/`.
- **Modifications are identified.** Every local change is a separate patch file
  rather than a folded-in edit to the upstream bytes: `0002`, `0003` and `0004` —
  **three** patches, all applied to the built artifact and each described in
  `PROVENANCE.md`. The scoped CA-trust patch (historically `0001`) is not
  vendored here, not applied and in no artifact, and `prepare-build-tree.sh`
  refuses to stage a tree containing its content.
- **Rebuild and relink materials, partly exercised.** `prepare-build-tree.sh`
  reproduces the staged build tree from the shipped corresponding source: it was
  run against the archive extracted from a packed tarball and against an
  installed consumer's copy, applying the three patches and pinning all six
  dependency revisions, without invoking a compiler. The compile and bundle steps
  were executed once, from this repository, and produced the artifact in use;
  they have **not** been re-executed from the shipped archive. Emscripten output
  is not pinned to be reproducible, so a rebuild is not expected to be
  byte-identical.
- **Licence texts.** `vendor/libcurl.js/LICENSE` is upstream's LGPL-3.0 text
  verbatim — byte-identical to `upstream/LICENSE`, sha256
  `a5681bf9b05db14d86776930017c647ad9e6e56ff6bbcfdf21e5848288dfaf1b` — and the
  same bytes ship beside the artifact as
  `LICENSE.libcurl.js-LGPL-3.0-or-later`. The wrapper's AGPL-3.0 text ships as
  `LICENSE.wrapper-AGPL-3.0-only`. LGPL-3.0 is written as a supplement to
  GPL-3.0 and the GPL-3.0 text itself is in neither tree; that is recorded here,
  not resolved.
