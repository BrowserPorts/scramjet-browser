# Runway consumer guide

Runway is a Playwright-driven conformance runner for Scramjet. This is v2: a
clean break from the previous CLI, environment variables, result files and test
authoring API. There is no compatibility layer, and no environment variable
configures a run.

## Lanes, and what a result means

Every selected test runs on two lanes (`--lanes`, default both):

- **`bare`** — the reference lane, role `reference`. Runway serves the page from
  its own plain static harness; nothing of Scramjet is loaded, no service worker
  is installed and no proxy transport is used. It records what the browser does on
  its own.
- **`scramjet`** — the candidate lane, role `candidate`. The harness page loads
  `scramjet.js` and `controller.api.js` from the directories Runway serves,
  registers the harness service worker, and carries traffic over the wisp
  endpoint and the libcurl transport Runway also serves. It is the generic
  Scramjet configuration — not a tuned, instrumented or emulated build.

A **raw pass** means the subject's own assertions held. A **qualified pass** is a
separate verdict computed from evidence, and the requirements are individual
(`src/core/verification.ts`): the per-attempt nonce echoed back from the page,
host-owned fixture evidence, host-side route observation on a candidate lane when
the run wants route evidence, an owner attestation when the suite declares one,
and an explicitly selected browser. Missing evidence never turns a failure into a
pass and never promotes a raw pass; it is recorded and it changes the exit code.
Identical failures in both lanes are **shared failures**, never parity success.

Nothing a run produces establishes transport, service-worker, cache or
secure-context parity. Owner attestation fails closed: a plugin's self-report and
a native host pass are not owner receipts and are not substituted for one.

## Installing

Runway is an ordinary npm package: one tarball, standard `bin`, `exports` and
`files`, compiled JavaScript with declarations. A consumer needs no pnpm, no
workspace and no checkout of this repository.

### Not published

`npm install runway` does not work today, and this guide will not pretend
otherwise. Runway's two sibling dependencies are declared `workspace:*`, so
`pnpm pack` writes the siblings' *current* versions into the packed manifest —
`@mercuryworkshop/scramjet 2.0.67-alpha.2` and
`@mercuryworkshop/scramjet-controller 0.0.14` — and the registry payloads at those
numbers were observed unable to run Runway: core shipped a `(?i:…)` regex Node 22
cannot parse, and the controller build had no `controller.native-sw.js`, which the
harness serves with `Service-Worker-Allowed: /`. That was an observation made when
those versions were checked; nothing here re-verifies the registry, and `npm`
cannot repair a published payload.

Unblocking this is upstream work and cannot reuse those version numbers: publish
new core and controller versions whose payloads match what Runway is tested
against, bump the workspace siblings, repack Runway. The name `runway` is also
unclaimed as far as this repository knows — nothing here checks or reserves it,
and no script publishes.

`--scramjet-dist` and `--controller-dist` point the runner at local builds of
those two packages. That is all they do: they change which directory the harness
serves. They do not fix the published packages, and a run that uses them is not
evidence that an installed consumer would work.

### Running it from this repository

The CLI runs from source through Node's type stripping:

```sh
cd packages/runway
pnpm cli --help    # node --experimental-strip-types --no-warnings src/cli/bin.ts
pnpm list          # inventory only, no browser and no servers
```

**Prerequisite, not optional:** the libcurl transport asset must already be built
at `vendor/libcurl.js/dist`. Runway serves its own transport instead of the
published `@mercuryworkshop/libcurl-transport@2.0.5`, whose build hangs on a 304
and on any HEAD, and `src/fixtures/assets.ts` resolves that directory with no
second candidate and no fallback — a missing one is fatal for `run`, `list`,
`preflight` and `inspect` alike, and `pnpm build` refuses to finish without it.
It is a build output and is **not** in git: build it with
`vendor/libcurl.js/prepare-build-tree.sh` and the commands in
`vendor/libcurl.js/BUILD-RECIPE.md` (a pinned Emscripten toolchain is required),
or pass `--libcurl-dist <dir>` at an artifact you already have. The scramjet and
controller assets likewise have to be built in the workspace, or supplied with
their flags.

### Packing it for a test install

Pack each package with `pnpm` and install the three files together. This is a
**test setup**, not a distribution format:

```sh
cd packages/core       && pnpm pack --pack-destination /tmp/rw
cd ../controller       && pnpm pack --pack-destination /tmp/rw
cd ../runway           && pnpm pack --pack-destination /tmp/rw

cd <your project>
npm install /tmp/rw/mercuryworkshop-scramjet-*.tgz \
            /tmp/rw/mercuryworkshop-scramjet-controller-*.tgz \
            /tmp/rw/runway-*.tgz
npx runway --help
```

`pnpm` is the packer for a checkout, not a preference: Runway depends on its
siblings through `workspace:*` and on `@mercuryworkshop/wisp-js` through
`catalog:`, and only `pnpm pack` resolves those to concrete versions. `npm pack`
copies them verbatim and the result is uninstallable. Each `pnpm pack` runs that
package's own `prepack` build first, so the sibling builds have their own
toolchain requirements (core's `prepack` also rebuilds the wasm rewriter).

Runway's tarball carries its libcurl asset at `dist/assets/libcurl`, so an
installed consumer resolves that one package-relatively without a checkout. The
scramjet and controller assets are still resolved from the installed sibling
packages, so a test install is only as good as the sibling tarballs it was given.

A cold `npx runway` with nothing installed cannot work while the siblings are
unpublished, because `npx` resolves from the registry. With the dependencies
already in the project,
`npm exec --package=/tmp/rw/runway-2.0.0.tgz -- runway --version` runs the packed
CLI directly.

## What the package exposes

| entry | resolves to |
| --- | --- |
| `runway` | `dist/public.js` (+ `dist/public.d.ts`) |
| `runway/testkit` | `dist/testkit.js` |
| `runway/plugin-api` | `dist/plugin-api.js` |
| `runway` binary | `dist/cli/bin.js` |

ESM only, Node >= 22.6. Nothing in the package imports TypeScript source and no
command writes inside `node_modules`; everything a run produces goes under the
directory the command was invoked from (`--output-dir`, default `runway-output/`).

Entry-point types resolve (`attw`, `esm-only` profile), but a full transitive
typecheck of `runway/plugin-api` under strict NodeNext with
`skipLibCheck: false` does **not** pass today, and entry resolution is not that
check. The failures are in the siblings' declaration trees: extensionless relative
imports through core's and controller's `.d.ts` files, and controller's public
`Controller.rpc` typed via `@mercuryworkshop/rpc`, which controller declares only
as a devDependency. Those are fixed in the siblings, not here; this guide does not
propose `skipLibCheck: true` as the answer.

Runtime dependencies are small: `commander` for the CLI, Node's `http` with
`serve-static` and `send` for the harness, and `ws` for the WebSocket lane.
`playwright` is pinned to exactly `1.61.0`, not a range, because the driver
version decides which browser builds are accepted and how CDP is spoken;
upgrading it is a deliberate change with its own qualification run.

## Browser selection

Installing downloads no browser: Playwright's published package has no install
script, and Runway never downloads or builds one.

| flag | effect |
| --- | --- |
| `--browser-executable <path>` | launch that binary; validated before anything starts |
| `--browser-channel <name>` | launch that installed channel |
| `--browser-bundled` | use Playwright's bundled Chromium |
| `--headed` | visible window |

Exactly one selector may be given. **Both lanes always use the same browser**,
and records must agree on the binary they ran on — mixed identities are an
integrity failure, not comparable results.

A run with no selector, or with `--browser-bundled`, uses Playwright's bundled
Chromium and is recorded as **not selection proof**: it still runs, but it fails
the per-pair `explicitBrowser` requirement *and* the plan records itself as not
conformance-eligible, with that reason stored in the plan. Get a bundled browser
with `npx playwright install chromium`, or name one you already have.

## Commands

```
runway run [filters…] [flags]
runway list [filters…] [flags]
runway preflight [flags]
runway compare <run-directory> [flags]
runway inspect <filter> [flags]
runway --help | --version | help <command>
```

Flags are the only run input. Unknown flags and unknown commands are usage errors
(exit 2); runtime and test failures exit 1; `--help` and `--version` exit 0.
`--json` puts exactly one JSON document on stdout, with diagnostics and errors on
stderr. Relative paths resolve against the directory the command was invoked from.

Common flags: `--lanes <list>`, `--suite <list>` (`native`, `wpt`),
`--scramjet-dist`, `--controller-dist`, `--libcurl-dist`, `--plugin-manifest`,
`--harness-port`, `--wisp-port`, `--bare-port` (`0` allocates). `run` adds
`--concurrency`, `--deadline-ms`, `--expectations`, `--output-dir`, `--coverage`,
`--trace-console` and `--insecure-diagnostics` (labelled: results are never
counted as verified). `compare` takes `--expectations` and `--output`.

## The WPT suite

`--suite wpt` is implemented on this branch; it is not an error and not a silent
skip. It needs its inventory manifest, which **is** the denominator and is never
inferred:

```sh
pnpm cli run --suite wpt --wpt-manifest <manifest.json> \
             --wpt-root <upstream-checkout> --wpt-server-config <config.json> \
             --browser-executable <binary>
```

- `--wpt-manifest <file>` is required with the suite. Generate one against the
  upstream checkout you intend to run with `scripts/generate-serviceworker-wpt.py`.
- `--wpt-root` and `--wpt-server-config` must be given together; with them the run
  starts the official wptserve, without them the inventory is planned but no case
  executes.
- `--wpt-allow-incomplete` widens what may be *read*, never what may execute; such
  cases still record `setupError`, because the denominator is unsound.
- Cases the manifest covers but this build cannot run (testdriver, h2, https,
  subdomain, non-testharness item types) stay inventoried with their reason and
  record `notRun`. The denominator does not shrink.

**A candidate-lane WPT case cannot be a qualified pass today.** Route
instrumentation is a separate requirement, and there is no authoritative route
observation for WPT traffic: the official wptserve is a separate process that
never reaches Runway's in-process observer, and `matchedTarget` is gated to
`local-http`. Frame attribution and document identity are recorded, and neither
substitutes for a route proof. `src/suites/wpt/INTEGRATION.md` describes the wiring
and the gap in detail.

## Plugin profiles

`--plugin-manifest <file>` loads managed Scramjet plugins on the candidate lane
before the test frame is created; the flag is ignored for the reference lane.
`examples/plugins/` ships two profiles, and `runway/plugin-api` exports the types:
a factory receives `{ scramjet, controller, options, assets }` and returns
`{ plugins, configure?, report?, verify? }`.

Every hook after `plugins` is optional, and `verify` is **not** verification of
the candidate: it asserts the plugin's own behaviour for one navigated URL,
throwing fails the attempt, and returning cleanly is recorded as the plugin
speaking about itself — it never qualifies a pass. Whether a module declared
`verify` is recorded when the profile initializes, so a declared verifier that
later goes missing fails the attempt instead of reading as a profile with nothing
to check.

## Authoring tests

Import factories from `runway/testkit` (or `runway`):

- `scriptTest` — a page that loads a script through the in-page helpers
- `documentTest` — a page served as HTML
- `originTest` / `fixtureTest` — a test that owns its origin
- `pageTest` — Playwright control of the harness
- `nodeTest` — in-process, no browser
- `frameTreeTest` — several origins as nested frames

There is no `basicTest` / `htmlTest` / `serverTest` / `playwrightTest` /
`directTest` / `multiFrameTest`. Those names belonged to the previous API.

## Results

A run directory contains:

- `plan.json` — the immutable plan, hashed. It embeds the inventory snapshot: the
  exact tests, lanes, requirements and verdict sources the run was planned
  against. The plan hash covers this denominator.
- `events.jsonl` — append-only records. Every record carries the run id and plan
  hash; a log from another run or plan is refused.
- `report.json` — the run's own summary, written once.
- `artifacts/` — bytes the records named, verified by size and SHA-256.

`runway compare <run-directory>` recomputes the verdict offline from those files
only: nothing is re-discovered, no server starts, no browser launches. The derived
report is written to a new `compare-<timestamp>.json`, or to `--output`, which
must not already exist and must not be existing evidence. The original evidence is
never overwritten, and a run's own summary and a later comparison share one
verdict pipeline.

Expectations (`--expectations`, shape in `expectations.json`) explain assertion
failures only. They never create passes, never cover timeouts, crashes, missing or
invalid records, cancellations, setup failures or broken artifacts, and a
qualification miss still fails the exit code.

Every planned pair gets exactly one terminal outcome: a cancelled, timed-out or
failed test still records `cancelled`, `timeout`, `setupError` or
`infrastructureError` for each of its pairs. A late result arriving after its pair
closed is reported as an orphan, never as a second outcome.

## Diagnostics

`--coverage` writes raw V8 JS coverage per attempt as an artifact.
`--trace-console` writes a capped page console transcript, with truncation
recorded. `runway inspect <filter>` opens one test on one lane and keeps the
browser open; it is not a recorded run.

## Author checks

```sh
cd packages/runway
pnpm typecheck                 # tsc --noEmit
pnpm build                     # tsc → dist/, asset copy, declaration rewrite
pnpm check-package             # pnpm pack, then publint and attw on the tarball
pnpm pack                      # the tarball itself
```

`check-package` is a wrapper over two standard linters — `publint` for packaging
mistakes that only appear after publishing, and `@arethetypeswrong/cli` for entry
points whose types do not follow their JavaScript — plus a list of paths that may
never be inside the tarball (`scripts/package-content.mjs`: run output, Python
bytecode, `migration/`, parked WPT content, `.ts` sources, and similar). The
runner's own compiled `dist/suites/wpt/` adapter is exempt from the WPT rule,
because it is product code that has to ship for `--suite wpt` to be usable by an
installed consumer. `attw` runs against the packed tarball rather than its own
`--pack`, which would shell out to `npm pack` and reproduce the
`workspace:`/`catalog:` problem.

`pnpm test` is not a unit suite: it runs `runway run --suite native`, so it needs
the assets and a browser like any other run. The native suite's cases live in
`src/tests/`; this package ships no unit tests and no unit-test runner.

The one non-`tsc` build step is a declaration rewrite. TypeScript 5.9 rewrites
`.ts` import specifiers in JavaScript emit but not in declaration emit
(microsoft/TypeScript#61037), and Runway's sources import each other with explicit
`.ts` extensions because that is what Node's type stripping needs when the CLI
runs from a checkout. Without the rewrite the published `.d.ts` files would name
`.ts` files the package does not contain, so `scripts/declaration-extensions.mjs`
rewrites them from the TypeScript AST and the build fails if any survive.

A precision about "no TypeScript source": the package ships no `.ts` source
*modules* — every module specifier names a shipped file — but the `.js.map`
sidecars do embed the original sources through `inlineSources`, deliberately, so
a consumer's stack traces stay readable.

## Limits of this build

- The unmigrated upstream producers under `migration/` are excluded from every
  tarball and are not wired into any suite.
- A candidate-lane WPT case cannot reach a qualified pass until a route receipt
  exists; see `src/suites/wpt/INTEGRATION.md`.
- TLS for WPT is unsatisfied, so `https` cases stay inventoried rather than run.
- No part of Runway proves service-worker, cache or transport parity, and no
  recorded run in this repository is offered as such evidence.
