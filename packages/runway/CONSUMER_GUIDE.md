# Runway consumer guide

Runway is a Playwright-driven conformance runner for Scramjet. This is v2: a
clean break from the previous CLI, environment variables, result files and test
authoring API. There is no compatibility layer.

## Installing

Runway is an ordinary npm package: one tarball, standard `bin`, `exports` and
`files`, compiled JavaScript with declarations. Nothing on the consumer side
needs pnpm, a workspace, a checkout of this repository, or any Runway-specific
release tooling.

```
npm install runway            # once the package and its dependencies are published
npx runway --help
```

### Not published yet

That command is what the package is built for; it does not work today, and this
guide will not pretend otherwise. Runway depends on
`@mercuryworkshop/scramjet` and `@mercuryworkshop/scramjet-controller`, and the
versions currently on the registry cannot run it:

- published `@mercuryworkshop/scramjet@2.0.67-alpha.2` contains a `(?i:…)` regex
  that Node 22 cannot parse, so `runway list` throws on load.

`npm` and `npx` cannot repair a broken published payload, and this package does
not try to. Its two sibling dependencies are declared `workspace:*` — an exact
policy, not a range: `pnpm pack` resolves each one to the sibling's current
version, so the packed tarball names `@mercuryworkshop/scramjet 2.0.67-alpha.2`
and `@mercuryworkshop/scramjet-controller 0.0.14`, which are exactly the broken
registry payloads. The current tarball therefore stays registry-blocked even
though every dependency is concrete.

The fix is upstream and cannot reuse those numbers: publish NEW core and
controller versions whose payloads match what Runway is tested against, bump the
workspace siblings to them, and repack Runway so its tarball references the new
versions. Those new versions must also carry the two declaration fixes `What you
get` calls out — extensioned relative imports throughout the sibling `.d.ts`
trees, and `@mercuryworkshop/rpc` as a real (not dev-only) dependency of the
controller — because repacking Runway against still-broken sibling types would
not unblock strict consumers. Until then a consumer install has to supply those
two packages itself (below). The name `runway` is also unclaimed as far as this
repository knows:
nothing here checks or reserves it, and no script publishes.
If the name turns out to be taken, the package gets renamed before any release,
and a scoped name is a decision for whoever publishes, not an assumption made
here.

### Trying it before then

Pack each package with plain `pnpm pack` and install the three files together.
This is a **test setup**, not a distribution format — there is no bundle, no
release manifest and nothing to keep:

```
cd packages/core       && pnpm pack --pack-destination /tmp/rw
cd ../controller       && pnpm pack --pack-destination /tmp/rw
cd ../runway           && pnpm pack --pack-destination /tmp/rw

cd <your project>
npm install /tmp/rw/mercuryworkshop-scramjet-*.tgz \
            /tmp/rw/mercuryworkshop-scramjet-controller-*.tgz \
            /tmp/rw/runway-*.tgz
npx runway --help
```

`pnpm` is the packer for a checkout, not a preference: Runway depends on its two
siblings through `workspace:*` and on `@mercuryworkshop/wisp-js` and
`@mercuryworkshop/libcurl-transport` through `catalog:`. `pnpm pack` resolves all
four to concrete versions in the packed manifest. `npm pack` copies them
verbatim, and nothing outside this workspace can resolve `workspace:` or
`catalog:`.

A cold `npx runway` — no install, everything fetched on demand — cannot work
while those two dependencies are unpublished or broken, because `npx` resolves
dependencies from the registry. With the dependencies already installed in the
project, `npm exec --package=/tmp/rw/runway-2.0.0.tgz -- runway --version` runs
the packed CLI directly.

Alternatively, keep the registry dependencies and point the runner at local
browser payloads with `--scramjet-dist` / `--controller-dist` (see below). That
is an explicit override for someone who has those builds; it does not hide the
fact that the published payload is broken.

### What you get

`runway`, `runway/testkit` and `runway/plugin-api` resolve to `dist/*.js` with
matching declarations, and the `runway` binary is `dist/cli/bin.js`. The package
is ESM only and needs Node >= 22.6; nothing in it imports TypeScript source, and
no command writes inside `node_modules`. Everything a run produces goes under the
directory the command was invoked from (`--output-dir`, default `runway-output/`).

One honest limitation on "matching declarations". `attw` is green: every entry
point resolves and its types follow its JavaScript. But a full transitive
typecheck of `runway/plugin-api` under strict NodeNext with `skipLibCheck: false`
does **not** pass today, and entry resolution passing is not the same thing as
that check. The failure is in the siblings' declaration trees, not in Runway's:
extensionless relative imports run through core's and controller's `.d.ts` files
(the same class of defect Runway already rewrites for itself at build time), and
controller's public `Controller.rpc` field is typed via `@mercuryworkshop/rpc`,
which controller declares only as a *dev*Dependency — so a consumer that installs
the published packages never gets the module those declarations name. The new
sibling releases the previous section requires must fix both the declaration
trees and that public-types dependency; Runway is then repacked against their
exact versions. This guide does not recommend `skipLibCheck: true` as the answer:
that would silence the consumers' check without fixing the declarations it checks.

The runtime dependencies are small and ordinary: `commander` 14 for the CLI, and
Node's own `http` plus `serve-static` and `send` for the harness server —
there is no framework in the request path. `ws` provides the WebSocket lane.

`playwright` is pinned to exactly `1.61.0`, not a range. It is the automation
driver every browser lane runs through, so the version that gets installed
decides which browser builds are accepted and how CDP is spoken; a caret range
would have let this workspace be qualified on one driver while a consumer
installed another (`^1.61.0` admitted 1.61.0 through 1.63.0 when the pin was
made). Upgrading it is a deliberate change with its own qualification run.

Installing downloads no browser. Playwright's published package has no install
script, so nothing is fetched, and a run has to name a browser explicitly (see
*Browser selection*). Get one with
`npx --prefix <your project> playwright install chromium`, or point both lanes at
a binary you already have via `--browser-executable` / `--browser-channel`.
Runway never downloads or builds a browser itself.

### Author checks

```
cd packages/runway
pnpm build                   # tsc → dist/, plus the declaration rewrite below
pnpm check-package           # pnpm pack, then publint and attw on the tarball
pnpm pack                    # the tarball itself
```

`check-package` is a thin wrapper over two standard linters: `publint` for
packaging mistakes that only appear after publishing, and
`@arethetypeswrong/cli` for entry points whose types do not follow their
JavaScript. `attw` runs against the packed tarball rather than through its own
`--pack`, because that would shell out to `npm pack` and reproduce the
`workspace:`/`catalog:` problem above. It runs in the `esm-only` profile, which is
what this package is.

The one non-`tsc` build step is a declaration rewrite. TypeScript 5.9 rewrites
`.ts` import specifiers in JavaScript emit but not in declaration emit
(microsoft/TypeScript#61037), and Runway's sources import each other with
explicit `.ts` extensions because that is what Node's type stripping needs when
the CLI runs from a checkout. Without the rewrite the published `.d.ts` files
would name `.ts` files the package does not contain, so `scripts/declaration-extensions.mjs`
rewrites them from the TypeScript AST and the build fails if any survive.

A precision about "no TypeScript source": the package ships no `.ts` source
*modules* — nothing imports a `.ts` file, and every module specifier names a
shipped file. The `.js.map` sidecars do embed the original sources through
`inlineSources`, which is what makes a consumer's stack trace readable. That is
deliberate, not a leak, and shrinking the maps is a possible future change, not
something this build hides.

Browser payloads are resolved through Node's resolver from Runway's own
dependencies. To serve a different build instead, pass `--scramjet-dist`,
`--controller-dist` or `--libcurl-dist` with the directory holding
`scramjet.js`, `controller.api.js` or `index.js`; a directory that lacks its
entry file is refused with the flag to fix it.

## Commands

```
runway run [filters…] [flags]
runway list [filters…] [flags]
runway preflight [flags]
runway compare <run-directory> [flags]
runway inspect <filter> [flags]
runway --help | --version | help <command>
```

Flags are the only run input. Nothing in Runway reads `process.env` as
configuration. Unknown flags and unknown commands are usage errors (exit 2).
`--help` and `--version` print to stdout and exit 0. Runtime and test failures
exit 1. `--json` puts exactly one JSON document on stdout; diagnostics and
errors go to stderr.

Relative paths (assets, manifests, expectations, `--output-dir`, the compare
directory) resolve against the directory the command was invoked from.

## Browser selection

Pass `--browser-executable <path>` or `--browser-channel <name>`. Both lanes
(`bare` and `scramjet`) use that same binary. A run that did not name a browser
is recorded, and labelled *not selection proof*; it is never conformance
evidence.

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

External plugin projects can export their own tests from ESM modules and use
`--test-root ./tests --plugin-manifest ./plugin.json`. The test root replaces the
builtin native directory and is recorded in the plan; no repository changes are
required. See [PLUGIN_TESTING.md](PLUGIN_TESTING.md) for a complete example.

## Results

A run directory contains:

- `plan.json` — the immutable plan, hashed. It embeds the inventory snapshot:
  the exact tests, lanes, requirements and verdict sources the run was planned
  against. The plan hash covers this denominator.
- `events.jsonl` — append-only records. Every record carries the run id and plan
  hash; a log from another run or plan is refused.
- `report.json` — the run's own summary, written once.
- `artifacts/` — bytes the records named, verified by size and SHA-256.

`runway compare <run-directory>` recomputes the verdict offline from these files
only: no tests are re-discovered, no server starts, no browser launches. The
derived report is written to a new `compare-<timestamp>.json` (or to `--output`,
which must not be existing evidence and must not already exist). It never
overwrites the original evidence. The run's own summary and a later offline
comparison share one verdict pipeline.

A raw pass is not a qualified pass. Qualification is per test and requires the
attempt nonce, host-side route observation on the candidate lane when the test
declares a proxy route, and an explicit browser. Missing evidence changes the
exit code. Records must also agree on the browser binary they ran on; mixed
identities are an integrity failure, not comparable results.

Expectations (`--expectations`) explain assertion failures only. They never
create passes, never cover timeouts, crashes, missing or invalid records,
cancellations, setup failures or broken artifacts, and a qualification miss
still fails the exit code. Equal failures in both lanes are shared failures,
not parity success.

Every planned pair gets exactly one terminal outcome: a cancelled, timed-out or
failed test still records `cancelled`, `timeout`, `setupError` or
`infrastructureError` for each of its pairs. A late result that arrives after
its pair was closed is reported as an orphan, never as a second outcome.

## Diagnostics

`--coverage` writes raw V8 JS coverage per attempt as an artifact.
`--trace-console` writes a capped page console transcript, with truncation
recorded. `runway inspect` opens one test on one lane and keeps the browser
open; it is not a recorded run.

## Upstream WPT

Select an upstream inventory using `--suite wpt --wpt-manifest <file>` and
provide `--wpt-root` with `--wpt-server-config` to start official wptserve.
The generic producer is `scripts/generate-wpt.py`; consumers choose paths and
may supply their own selection config. Unsupported case types remain explicit
non-executed outcomes, not passes. Legacy material under `migration/` is not
part of the installed runner.
