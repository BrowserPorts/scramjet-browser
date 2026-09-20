# WPT suite: current integration

This describes how the WPT suite in this directory is wired **as it exists on this
branch**, and what still cannot be qualified. It is a reference for readers of the
code, not a task list: registration, discovery, dispatch, the fixture server
lifecycle and the host/frame attachment are all in place.

It deliberately names symbols rather than line numbers.

---

## 1. Selection and configuration

`WPT_SUITE_NAME` (`"wpt"`) is part of `KNOWN_SUITES` in `src/config/resolve.ts`, so
`--suites wpt` resolves like any other suite.

The consumer-facing flags are defined in `src/cli/program.ts`:

- `--wpt-manifest <file>` — required with `--suites wpt`. The manifest **is** the
  denominator and is never inferred.
- `--wpt-root <dir>` and `--wpt-server-config <file>` — the upstream checkout to
  serve cases from and the wptserve config to start it with. `resolve.ts` requires
  them together.
- `--wpt-allow-incomplete` — diagnosis only. It widens what may be *read*, never what
  may execute.

These land on `WptPlan` (`src/core/plan.ts`) as `manifestPath`, `allowIncomplete`,
`wptRoot` and `serverConfigPath`, and `resolve.ts` rejects `--wpt-manifest` when the
suite was not selected.

## 2. Suite ids come from the manifest

There is no `WPT_SUITE_PREFIX` constant and there should not be one. The selection the
consumer names is `wpt`; the *entries* carry per-manifest ids produced by
`wptSuiteId(manifest.suite)` — `wpt/url`, `wpt/serviceworker`,
`wpt/crossspec-sw-affecting` — because the label is chosen by whoever generated the
manifest. `wptSuiteId` rejects a label that is not a usable id rather than sanitizing
it, so two labels can never collapse into one suite.

Dispatch therefore matches the `wpt/` namespace, not a fixed id.

## 3. Discovery

`prepareRun` finds the `wpt` selection alongside the native one and calls
`discoverWptCases` (`suite.ts`); a plan is rejected only when *neither* suite is
selected. `discoverWptCases` reads the manifest and fails — with a remedy naming
`scripts/generate-serviceworker-wpt.py` — rather than returning a partial inventory.
`buildWptInventory` retains every unsupported case with its reason, so the denominator
does not shrink.

## 4. Fixture server lifecycle

When the plan carries `wptRoot` and `serverConfigPath`, `executeRun` starts the
official server with `startWptServer` (`server.ts`) and registers it with the run's
single cleanup owner, so the run's `finally` releases it and nothing else does.

- `handle.origin` becomes the adapter's `serverOrigin`.
- `handle.provenance` goes into `fixtureProvenance` for every record, including
  `identity.listenerProofs` and `tlsEstablished`.
- A start that cannot prove its listeners throws instead of returning a handle, so the
  handle itself is the capability. A readiness fetch or a config path is not.
- When the plan wanted a WPT server and none came up, that is recorded against the
  pairs the plan already promised rather than thrown over the run.

## 5. Dispatch

`executeRun` routes entries whose suite is in the `wpt/` namespace to
`dispatchWptCase`, which calls `executeWptCase`. The scheduler, recorder, verification
and browser owner are the ones the native suite already uses: this is a second
*suite*, not a second runner.

`dispatchWptCase` reads the upstream URL and harness timeout back from the plan's own
snapshot, so the case that runs is the case that was planned, and emits a setup
failure when the snapshot records no usable timeout. It also emits a setup failure,
rather than executing, when the WPT server is absent.

## 6. Host attachment and frame designation

`executeWptCase` requires a `WptHostAttachment` and refuses to produce a record
without one. `run.ts` supplies it per attempt:

- **Reference lane** — the attachment opens a page in the attempt's own context and
  uses the **identity** mapping. That is a statement of fact, not a placeholder: on
  the reference lane the browser really does load the upstream URL unchanged, so
  `observedUrl === physicalUrl` is the correct verification.
- **Candidate lane** — `candidateCaseFrame` requires the lane's own
  `attempt.hostIntegration()` capability and throws
  `fixtures/capability-unavailable` when the lane exposes none or reports it
  unavailable. A downgrade guard is applied for the whole attempt, before anything is
  navigated.

The case frame is designated **before** navigation and its identity retained for the
attempt. Binding arrivals are attributed by comparing the Playwright-supplied
`source.frame` and `source.page` against those retained objects, so a helper iframe,
the outer document or a frame that has navigated elsewhere is refused even when it
reports the same URL. There is no token in the page for a document to echo.

`HarnessAdmissionEvidence.locationVerdict` is set by the attachment that owns the
mapping; the adapter itself performs no URL comparison and makes no route claim. The
converter requires `match`, and `unverified` is not an admission. No payload field may
drive the verdict.

## 7. Completion delivery

The adapter installs an init script before any navigation and exposes one binding. The
script registers with upstream's own `add_result_callback` / `add_completion_callback`:
it defines no harness, wraps no test and reads nothing from the URL. Because the
script runs before the document's scripts, it intercepts those two globals on their
way in, installs upstream's value unchanged and registers alongside it, restoring
upstream's `expose()` shape so the globals enumerate as they would have.

Upstream calls the completion callback once per document with the full test array and
harness status, so one arrival carries every subtest's name, status, message and stack
as upstream produced them, sent as one JSON string with per-field text bounded in the
page.

**Declared limit.** In a Window the harness cannot complete before its load gate
fires, so registration is always in time. In upstream's `ShellTestEnvironment` (no
`document`) `all_loaded` is set on the first microtask, so a body running
synchronously in the same script as `testharness.js` could complete before
registration. The consequence is no completion at all: the attempt reaches its
deadline and is recorded as a **timeout**. It can never be recorded as a pass.

A missing completion is a timeout, never a pass. There is no seal handshake and no
cutoff reconciliation: one document produces one completion, and the frame it came
from decides whether it counts.

## 8. Incomplete manifests

`assertExecutable` returns `setupError` — not `notRun` — for any entry with
`meta.manifestIncomplete === true`, because the case was not declined, the
*denominator* is unsound. `buildWptInventory` sets that flag from
`manifest.incompleteness`. Reading such a manifest at all requires `allowIncomplete`.

---

## What still cannot be qualified

### Route instrumentation is the open gap

`routeInstrumentation` is a **separate** qualification requirement in
`src/core/verification.ts`, required for candidate-role lanes when a run wants route
evidence, and a record carrying no route observation fails it. Frame attribution does
not substitute for it: dropping a nonce echo in favour of host-side frame identity
covers *attribution*, not the network path.

There is no authoritative WPT route observation today, for structural reasons rather
than missing plumbing:

1. **Nothing feeds the observer for WPT traffic.** `RouteObserver.http()` is called
   from one place in the tree, `src/testkit.ts`, which is Runway's own in-process
   fixture HTTP server. The official wptserve is a separate Python process, so its
   requests never reach the observer.
2. **`matchedTarget` is gated to local-http.** `src/fixtures/route.ts` computes it as
   `mode === "local-http" && httpOnAcceptedStream > 0`, with the comment that
   remote-stream is connectivity only and never a `proxyRoute` proof.
3. **The match is strict and plaintext-dependent.** It requires a request whose
   method, pathname and search equal the watch's expected values, arriving on the
   attempt's own accepted connection to the watched port. Over a TLS transport the
   proxy cannot see the request line, so it cannot match without terminating TLS.

So `src/fixtures/servers.ts` exposing `routeObservation(nonce)` is **not** a WPT route
owner. Closing this needs either an ingress correlation hook at the official server
(per request: peer endpoint, method, path+query — an open question to research against
the pinned checkout, without modifying upstream fixtures or server code) or a
transport-side receipt naming the actual target request carried for the attempt.

None of these may be substituted: a guest or page self-report, a CONNECT/handshake
count, or an HTTPS downgrade performed to make the request observable.

Until one exists, a candidate-lane WPT case cannot be a qualified pass under a
requirement set demanding `proxyRoute`. That is the correct outcome, not something to
relax.

### Keep these three facts separate

| Fact | What proves it | What it does **not** prove |
| --- | --- | --- |
| **Frame attribution** — the completion came from the designated case frame | host-observed binding `source.frame` vs the retained frame identity | nothing about the network path |
| **Document identity** — that frame is at the expected case document | host-observed frame URL plus the mapping owner's logical→physical verdict | not that the bytes travelled the candidate route |
| **Route proof** — the request took the candidate path | an ingress/transport receipt that does not exist yet | — |

`locationVerdict` is the second of these only.

### Owner receipts

`requireOwner` fails closed. A plugin's own self-report and a native host pass are not
an owner receipt and must not be substituted for one.

### TLS

`fixtures/tls` is unsatisfied for WPT. Upstream's own runner
(`tools/wptrunner/.../browsers/chrome.py` in the pinned checkout) uses a **narrow SPKI
pin** plus host-resolver rules rather than blanket trust, and adopting that approach
carries consequences that must be recorded with it:

- use upstream's logical hostnames with the resolver rules, so the certificate matches
  and there is no hostname mismatch to bypass; substituting `localhost` would change
  the origin/site/subdomain semantics cases depend on;
- such a lane may produce ordinary **functional** results only — explicitly not
  certificate-validation conformance, and the receipt must say so;
- no `ignoreHTTPSErrors`, no added system trust, no hosts-file edit, and the scheme is
  never downgraded to HTTP to make a case load.

The certificate and fingerprint values live in the pinned upstream checkout and are
not restated here, because a value copied into this file goes stale silently.

### Cases retained as unsupported

testdriver, h2, https, subdomain and non-testharness item types stay inventoried with
their reason and keep recording `notRun`. The denominator does not shrink.

### Not a parity claim

Nothing here establishes transport or secure-context parity, and nothing in this
directory records that a WPT case has been observed passing in a browser. A larger
inventory is a more accountable denominator, not evidence of parity.
