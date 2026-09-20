# libcurl.js — vendored optional transport source

## What this is

The source for the **optional** libcurl transport, vendored so a scoped per-session
CA trust option can be added. It is not part of the default SDK bundle and is not
imported statically by any shipped package.

## Exact provenance

| field | value |
| --- | --- |
| upstream | https://github.com/ading2210/libcurl.js |
| commit | `a641cdd857356db6b8ed46c5341cc8f85c4190ba` |
| commit date | 2025-12-01T14:25:28-05:00 |
| commit subject | bump package version and update submodules |
| version at commit | 0.7.4 (`client/package.json`) |
| matches installed | yes — npm `libcurl.js@0.7.4` reports `gitHead a641cdd857356db6b8ed46c5341cc8f85c4190ba` |
| submodule | `client/wisp_client` @ `455b9186bfbd0915ed7082c9d356af2157ab014f` |
| license | LGPL-3.0-or-later (GNU LGPL v3, 29 June 2007) |

Acquired by `git clone` of the official repository followed by
`git archive` of that exact commit, so `upstream/` contains the upstream bytes
and no VCS metadata. **No sibling checkout on this machine was used as a source**;
several exist in unrelated projects and were deliberately not copied.

## Layout

- `upstream/` — pristine upstream bytes. Do not edit.
- `upstream.sha256` — per-file manifest of `upstream/`, so drift from the
  archived commit is detectable. Verify with:
  `(cd upstream && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256) | diff - ../upstream.sha256`
- scoped CA trust (historically patch `0001`) — **not vendored in this
  repository**, not applied, not built, and not used by any artifact here. The
  patch file is deliberately absent; only the description below is kept.
- `patches/0002-null-body-304-and-header-callback-settlement.patch` — the 304
  fix below. Applies to pristine `upstream/` on its own (`git apply -p1`),
  independently of 0001.
- `LICENSE` — upstream license text, verbatim.

## Scoped per-session CA trust — historically patch 0001 (NOT vendored, NOT applied, NOT built)

Described here for history only. The patch file itself is **not vendored in this
repository**, so nothing can apply it by accident; it is excluded from every
staged tree and every artifact, and `prepare-build-tree.sh` aborts if its content
appears. Nothing below is in the built transport.

One patch, six files, no build-system change (`build.sh` globs `client/libcurl/*.c`
and reads `client/exported_funcs.txt`):

| file | change |
| --- | --- |
| `client/libcurl/certs.c` | immutable scoped trust-profile registry |
| `client/libcurl/types.h` | `RequestInfo.trust_profile` |
| `client/libcurl/request.c` | `request_set_trust_profile()`; per-handle `CURLOPT_CAINFO_BLOB` |
| `client/exported_funcs.txt` | exports the two new entry points |
| `client/javascript/session.js` | `cacert` / `cacert_hosts` session options; exact-host scope test |
| `client/javascript/http.js` | applies the profile per request, after `http_set_options` |

No verification is weakened: `CURLOPT_CAINFO_BLOB` substitutes the trust anchor
set only. `CURLOPT_SSL_VERIFYPEER` and `CURLOPT_SSL_VERIFYHOST` are untouched, and
mbedTLS still builds the chain, enforces validity and matches hostname/SNI.

## Patch 0002 — null body status 304, and header-callback settlement

Two edits, one file (`client/javascript/http.js`), pure JavaScript:

| change | why |
| --- | --- |
| `create_response` nulls the body for `304` as well as `204`/`205` | `304` is a null body status, and the `Response` constructor throws if a body is supplied for one. A `304` also arrives with no body bytes, so the empty stream still threw. `101`/`103` are null body statuses too but the constructor rejects those status codes outright, so they are deliberately not forced. |
| `headers_callback` wraps response construction in `try`/`catch`, then `reject(e)` and returns | That callback runs inside a native data/end callback, so an exception unwound into wasm and the promise was never settled. The catch settles it and **returns without tearing the request down**. That is deliberate: `active_requests` and `request_callbacks` are decremented and deleted only by `CurlSession.end_callback`, keyed by *request id*, while `remove_request` works on the *request pointer* and touches neither. Calling `remove_request` from here on the first-chunk path (`real_data_callback` runs `headers_callback` before the native end) would free the handle while the session still counted and retained the request. Deferring to the native end callback keeps teardown exactly once and identical to a normal finish; rejecting an already settled promise there is a no-op. **This is not an unconditional guarantee**: it holds only if the native transfer actually completes and delivers that callback. A transfer that never finishes leaves the request allocated — which is precisely the HEAD bug patch `0003` addresses, and the reason 0003 belongs with 0002. |

## Patch 0003 — HEAD requests must set `CURLOPT_NOBODY`

One edit, one file (`client/libcurl/http.c`). `CURLOPT_CUSTOMREQUEST` only
replaces the method string; it does not tell curl that no response body follows.
A HEAD response advertises `Content-Length` but sends no body, so curl waited for
bytes that never came, the transfer never completed, and no end callback was ever
delivered — the JS promise hung and the request stayed allocated.

- The method test is exact `strcmp(..., "HEAD")`: HTTP methods are case sensitive.
- The flag is recorded during the JSON walk and applied **after** the body
  options, because `CURLOPT_POSTFIELDS` puts the handle back into a body-bearing
  request — and because `item->valuestring` does not outlive `cJSON_Delete`.
- No reset for other methods: `create_request()` calls `curl_easy_init()` per
  request (`client/libcurl/request.c:31`), so each handle is fresh and
  `CURLOPT_NOBODY` is already 0. If easy handles are ever pooled, this must
  become an unconditional set of both 1 and 0.
- The `setopt` return is unchecked, like all ~15 of its neighbours:
  `http_set_options` is `void` with its ABI fixed in `exported_funcs.txt`, there
  is no pre-start error channel to JS (`end_callback` only carries a `CURLcode`
  from a transfer that already started), and `CURLOPT_NOBODY` with a `long`
  cannot fail on a valid handle in a build with HTTP enabled. Propagating it
  would mean changing that ABI plus the JS binding — deliberately out of scope.

## Patch 0004 — a HEAD response has a null body

**Applies on top of 0002** (it edits lines 0002 introduces); 0003 is independent
of both. `create_response` gains a third argument, `method`, passed from
`request_async`, which already has `params.method` in scope — **no C ABI change,
and no new plumbing**. When the method is exactly `"HEAD"` the body is `null`.

Per Fetch, a HEAD response has no body, whatever its status says and whatever
`Content-Length` it advertises, so an empty `ReadableStream` is wrong there. A
GET that merely returned zero bytes is a different case and keeps its (empty)
stream, so the two remain distinguishable — this patch *preserves* that
distinction rather than erasing it.

An earlier packet argued against this change on the grounds that bare Chrome
also returns a non-null stream for HEAD in our harness. That reasoning was
wrong: the reference lane is not the specification. The bare discrepancy is
recorded as **unresolved** in the packet notes, and is not a reason to make the
source behave incorrectly.

## Local source build

libcurl.js is built from `upstream/` + `0002` + `0003` + `0004` by
`prepare-build-tree.sh`, and the `@mercuryworkshop/libcurl-transport` wrapper is
built from its pinned commit against that output. See `BUILD-RECIPE.md` for the
commands, the pinned dependency revisions, and the toolchain (Emscripten
**3.1.6** — 3.1.72 builds cleanly but yields an artifact that never initialises).

The result is kept in `dist/` here and is what **Runway serves by default**:
`packages/runway` resolves it from this directory when run from the repository,
and from its own `dist/assets/libcurl` once packed and installed. The
`--libcurl-dist` override still works, and Runway no longer depends on the
published `@mercuryworkshop/libcurl-transport` at all.

This is a local default, not a release. Nothing has been published, and other
packages in this repository that depend on the registry build (bootstrap, demo)
are untouched and still get the unfixed 0.7.4 behaviour.

An earlier packet produced the same fixes by transforming the published bundle
instead of building it. That utility has been removed now that the source build
exists; its output and logs are retained outside the repository as history.
## Rebuild

`BUILD-RECIPE.md` holds the executed commands, pinned inputs and toolchain. The
transport installed in `node_modules` is still the unpatched published 0.7.4 —
the source-built artifact is used only via `--libcurl-dist`.
