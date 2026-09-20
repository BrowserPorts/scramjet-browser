# Runway WPT inventory: provenance and selections

This describes what `generate-serviceworker-wpt.py` records and how the cross-spec selection is
chosen. It is an inventory contract only. Nothing here asserts that a case passes, that a spec
area is implemented, or that any milestone is complete.

**An inventory cannot observe execution, so it records none.** `provenance.inventory.executionRecorded`
is always `false`, and no manifest field says a case ran, passed or was skipped. What the manifest
does record is the producer side of the contract with the runner: `supportedTypes` /
`runnerSupportedType` mark the manifest item types the runner has a defined way to drive.

Runway is the only WPT runner and browser host — a Playwright-managed, consumer-specified pinned
browser, run both bare and with the Scramjet plugin. There is no alternate runner and no custom
browser build in this tooling. Runway is also consumed externally by Scramjet plugin projects, so
these scripts take every location as an explicit argument, resolve their own config next to
themselves, run from any working directory, and reference no host path, sibling checkout or
repository layout.

## Files

| File | Role |
| --- | --- |
| `generate-serviceworker-wpt.py` | Produces a Runway inventory manifest from an upstream WPT checkout using WPT's own `manifest.sourcefile.SourceFile`. |
| `wpt-crossspec-selection.json` | Named path groups and presets for service-worker-affecting areas. |
| `check-wpt-selection.py` | Readiness check: resolves a selection against a checkout and optionally verifies WPT's manifest tooling, without producing an inventory. |
| `wpt_selection.py` | Shared config loading and git-index path resolution for the two scripts above. |

No custom test parser exists in any of these. Item types, URLs, timeouts, testdriver flags,
references and variants come from WPT's parser; `wpt_selection.py` only reads the checkout's git
index and never interprets upstream file contents.

## Readiness check first

```sh
# WPT_ROOT and OUT are supplied by the consumer; nothing is discovered.
python3 "$SCRIPTS/check-wpt-selection.py" "$WPT_ROOT" --preset crossspec-sw-affecting \
  --check-tooling --json "$OUT/readiness.json"
```

`$SCRIPTS` is wherever this directory is installed and `$WPT_ROOT` is any complete standalone
upstream checkout with its vendored `tools`. The working directory does not matter.

It reports the checkout revision, whether the working tree and the selected paths are dirty, the
tracked file count per group and per path, selection overlap, unresolved paths, and whether WPT's
`SourceFile` is importable with the attributes the generator uses. `--check-tooling` verifies the
per-file hash empirically by comparing `SourceFile.hash` for a selected file against
`git hash-object` for the same file rather than assuming the algorithm. It exits non-zero when any
selection is unresolved, when the tooling is unusable, or, with `--require-clean`, when selected
files have uncommitted changes.

## Generating an inventory

```sh
# Historical default selection, unchanged behaviour
python3 "$SCRIPTS/generate-serviceworker-wpt.py" "$WPT_ROOT" "$OUT/manifest.json"

# A named cross-spec selection
python3 "$SCRIPTS/generate-serviceworker-wpt.py" "$WPT_ROOT" "$OUT/crossspec.json" \
  --preset crossspec-sw-affecting

# Individual groups, or raw paths as before
python3 "$SCRIPTS/generate-serviceworker-wpt.py" "$WPT_ROOT" "$OUT/storage.json" \
  --group storage --group cookies
python3 "$SCRIPTS/generate-serviceworker-wpt.py" "$WPT_ROOT" "$OUT/workers.json" \
  --path workers --suite workers

# Pin the expected upstream revision, and acknowledge replacing a baseline from another one
python3 "$SCRIPTS/generate-serviceworker-wpt.py" "$WPT_ROOT" "$OUT/manifest.json" \
  --require-revision "$WPT_REVISION"
```

Both entry points — `generate-serviceworker-wpt.py` and `check-wpt-selection.py` — set
`sys.dont_write_bytecode` before importing anything, which also covers the `wpt_selection` module
they import, so running them adds no `__pycache__`; passing `PYTHONDONTWRITEBYTECODE=1` as well is
harmless. Neither entry point creates, updates nor deletes an existing bytecode directory.

`--path` cannot be combined with `--group`/`--preset`. A preset supplies the suite label unless
`--suite` overrides it; with no selection arguments the suite is `serviceworker`, exactly as before.

## What is inventoried: tracked files only

Selection resolves through `git ls-files`, so an inventory covers exactly the files **tracked** in
the supplied checkout:

- **Ignored files are intentionally excluded.** Build output, bytecode and local scratch inside a
  checkout are not upstream sources, and including them would make an inventory depend on local
  state instead of the pinned revision.
- **Untracked files are visible but not inventoried.** They are counted per path
  (`provenance.selection.resolution[].untrackedFiles`), counted for the selection
  (`source.selectedUntrackedFileCount`), listed in `source.selectedDirtyFiles`, and they set
  `revisionIdentifiesSelectedSources` to false. This differs from ignored files, which are not
  reported at all because git does not list them as untracked.
- **Therefore an inventory is not a content closure over the checkout.** It is a statement about
  the tracked sources of the named selection at the recorded revision and hashes. A path resolving
  to zero tracked files fails rather than being treated as empty.

## Failure and protection behaviour

- A selection that matches no tracked file fails, naming each unresolved path and why (missing on
  disk, present but untracked, or a directory with no tracked files). `--allow-unresolved`
  downgrades this to a stderr warning plus `provenance.selection.unresolvedPaths` in the manifest.
  Unresolved selections are never dropped silently.
- Selection entries must name literal, relative upstream paths. Git pathspec magic (`:`-prefixed),
  absolute paths, `.`/`..`/empty segments, backslashes, surrounding whitespace and glob characters
  (`*?[]`) are rejected in both configs and `--path` values, and every git call passes
  `--literal-pathspecs`, so a selection cannot be widened or redirected by pathspec interpretation.
- A selected file that WPT's parser cannot read or parse fails the run, naming the file and the
  error, instead of being dropped from the inventory. `--allow-unparsable-sources` records them in
  `provenance.selection.unparsableSources`, sets `validation.allSelectedFilesParsed` to false, and
  withholds the aggregate hash.
- Duplicate generated test URLs fail, naming each URL and the source files that produced it.
  `--allow-duplicate-urls` keeps the first occurrence, warns, and records the collision in
  `provenance.validation.duplicateTestUrls`. `counts` still reflects what WPT produced, so a
  dropped duplicate stays visible as a difference between `counts` and `tests`.
- Replacing an existing manifest that records a **different** upstream WPT revision fails, naming
  both revisions, so a recorded baseline is never silently replaced by an inventory of another
  revision. `--allow-revision-change` performs it deliberately and records the decision.
  `--require-revision <sha>` fails when the checkout is not at the expected WPT source revision.
- Writing over an existing manifest warns on stderr and records the replaced file's revision,
  suite, test count and size in `provenance.output.replaced`, so replacing evidence is never
  silent. `--no-clobber` refuses to replace an existing destination. Overwrite remains the default
  so the commands already documented in `SERVICE_WORKER_AUDIT.md` and `PLUGIN_TESTING.md` keep
  working; copy an existing manifest before regenerating if it is evidence for a recorded run.
- A dirty selected path warns and sets `provenance.source.revisionIdentifiesSelectedSources` to
  false: the revision alone does not identify the inventoried sources in that case. A clean
  selection inside a dirty repository also warns, and is never reported as a clean repository.
- If WPT's manifest tooling is not importable, or its `SourceFile` lacks a required attribute, the
  generator fails instead of falling back to a parser of its own.

## Manifest schema

Existing fields keep their meaning, shape and values, so older consumers and
`summarize-serviceworker-wpt.py` keep working:

- `revision`, `suite`, `paths`
- `tests[]` with `url`, `timeout`, `testdriver`
- `otherCases[]` with `path`, `type`, one entry per non-testharness source file as before
- `counts` per manifest item type, including `support`

Additive fields:

| Field | Meaning |
| --- | --- |
| `tests[].source` | Upstream file WPT generated this URL from, taken from the manifest item, not inferred from the URL. Generated `.any.js` variants therefore map back to their single source. |
| `tests[].https`, `tests[].subdomain` | Item flags from WPT, so a runner need not infer the scheme or host from the URL text. |
| `tests[].testdriverFeatures`, `tests[].scriptMetadata`, `tests[].pac`, `tests[].jsshell` | Recorded only when the item carries them. |
| `otherCases[].items[]` | Per-item `type`, `url`, `timeout` and reftest `references`, as WPT produced them. |
| `otherCases[].itemCount`, `otherCases[].runnerSupportedType` | Item count and whether this type is in the declared runner support contract. It is not an execution or result claim. |
| `otherCases[].variants`, `sources[].variants` | WPT's own variant enumeration, recorded only when non-empty. Never synthesised. |
| `sources[]` | One entry per successfully parsed selected file: `path`, `type`, `hash`, `itemCount`, `runnerSupportedType`, `selectedBy`, optional `variants`. Support files are included so nothing is dropped from the inventory. Omit with `--no-source-inventory`, which states the omission in the manifest. |
| `provenance.source` | Revision, committer date, `wptRootIsRepositoryRoot`, `repositoryRootRelativePrefix`, and two separate sets of facts: `repositoryDirty`/`repositoryChangedTrackedFileCount`/`repositoryUntrackedFileCount` for the whole repository containing the checkout, and `selectedPathsDirty`/`selectedChangedTrackedFileCount`/`selectedUntrackedFileCount`/`selectedDirtyFiles` for the selected paths only, plus `revisionIdentifiesSelectedSources`. Neither set implies the other, and a clean selection is never reported as a clean repository. |
| `provenance.selection` | Selection source, config path, preset, group records with tier and rationale, requested paths, per-path resolution, unresolved paths, tracked file count and the config's scope statement. |
| `provenance.hashes` | `perFileAlgorithm` (`git-blob-sha1`, WPT's `SourceFile.hash`), whether per-file hashes are recorded, coverage counts with any failures, and a `sha256` aggregate over the sorted `path<TAB>hash` lines. The aggregate is published **only when every selected file was parsed and hashed**; otherwise `value` is `null` with `complete: false` and a `withheldReason`, and `identity.wptSourceAggregateHash` is `null` with `wptSourceAggregateHashComplete: false`. A partial digest is never published, because it would look like a pin while omitting files. |
| `provenance.validation` | Whether paths resolved and URLs were unique, any duplicates, the ordering rule, and `volatileFields`. |
| `provenance.inventory` | `executionRecorded: false`, `supportedTypes`/`supportedTypeNames`, `inventoryOnlyTypes`, `supportFiles`, `inventoriedSourceFileCount`, `unparsableSourceFileCount` and item counts, with the support-contract note in full. |
| `provenance.manifestTooling` | Which WPT parser produced the items and that no custom parser was used. |
| `provenance.output` | Destination and the replaced manifest's identifying fields, if any. |
| `provenance.identity` | Portable identity: `wptSourceRevision`, `wptSourceAggregateHash`, explicit `browserBuild: null` and `chromiumSourcePortRevision: null`, plus a note that these are distinct IDs and that no inventory field describes a browser or a result. |
| `provenance.runLocal` | The only host-specific block: checkout path, tools path, selection config path, output path, argv and cwd for that run. Generated manifests are run-local evidence; nothing in tracked source contains a host path. |
| `provenance.schemaVersion` | `2` for the fields above. Manifests without it predate them. |

### Determinism

`tests` is sorted by URL, `otherCases` and `sources` by upstream path, and `counts` by type. Two
runs over the same checkout and selection produce identical output apart from the fields listed in
`provenance.validation.volatileFields`: `provenance.generatedAt`,
`provenance.generator.durationSeconds`, `provenance.generator.python`, `provenance.runLocal` and
`provenance.output.replaced`.
Compare manifests by stripping exactly those. Because everything else is portable — upstream
relative paths, revisions, hashes, counts — two different machines produce byte-identical
manifests for the same checkout and selection.

## Nested checkouts and working-tree facts

`git ls-files` run inside the checkout reports checkout-relative paths, while `git status` reports
repository-root-relative paths. When the WPT tests root is a subdirectory of a larger repository —
a vendored or embedded tests tree — those two do not agree, so status paths are normalised with
`git rev-parse --show-prefix` before being recorded, and `provenance.source.repositoryRootRelativePrefix`
states the prefix that was stripped. `selectedDirtyFiles` is therefore always checkout-relative,
matching every other upstream path in the manifest.

Working-tree state is read with `git status --porcelain -z -uall`: NUL-separated so paths containing
spaces or quotes survive, with rename/copy records consumed as single entries rather than split, and
`-uall` so an untracked directory cannot understate the untracked file count. Whole-repository counts
and selected-path counts are recorded separately; the inventory depends only on the selected paths
and makes no claim about the rest of the repository.

## Cross-spec selection

`wpt-crossspec-selection.json` groups upstream paths by the area they cover, with a tier and a
written rationale per group, and defines presets:

| Preset | Contents |
| --- | --- |
| `serviceworker` | The historical default: the `service-workers` subtree only. |
| `crossspec-sw-affecting` | Service workers, workers, HTML clients/navigation/history, origins and cross-origin isolation, messaging and structured clone, fetch, CSP and upgrade-insecure-requests, Trusted Types, secure contexts and mixed content, referrer/permissions/document policy, SRI, storage (Storage, IndexedDB, File System, File API, Web Locks, Storage Access), cookies, Clear-Site-Data, WebAssembly JS/web/serialization APIs, and timing. |
| `crossspec-sw-affecting-with-extensions` | The above plus Background Fetch, Background Sync, Periodic Background Sync, Push, Notifications and Payment Handler. |
| `m7-incoming-dependencies` | Inventory only: `websockets`, `webtransport`, `streams`, `xhr`. Listing them records incoming dependencies for later M7 work and claims no implementation or execution. |

This is a bounded selection, not a closure over WPT. The config's `excluded` list gives reasons for
notable omissions and states that it is illustrative rather than exhaustive. Selecting every group
does not cover WPT and does not prove that these are all the service-worker-affecting areas.
Upstream renames directories, so run `check-wpt-selection.py` against the checkout in use; the paths
in the config were verified to resolve against a checkout at revision
`3c26d25d7935b6027410da3aedffa81c9c78f674`.

## Support contract vs execution

| Manifest item type | In the declared support contract | Recorded as executed |
| --- | --- | --- |
| `testharness`, `crashtest`, `reftest` | yes — the runner has a defined way to drive them | never; this tooling records no execution |
| `manual`, `print-reftest`, `support`, and any other type | no — inventory only | never |

`supportedTypes` is a producer-side declaration so an inventory and a runner can be compared
against one contract. It is not an observation: a type being listed does not mean any case of that
type ran, and a type being absent does not mean the runner refused it.

That gap matters today: a runner that plain-loads an inventory-only type — the current special
suite does this for `print-reftest` — and records it as a pass is reporting something the contract
does not support. Fail-closed handling of unsupported types is forthcoming and is owned by the
runtime/packaging work, not by this generator; nothing in this tooling was changed to hide it, and
nothing here can make such a result correct.

## Identity: three separate IDs

| ID | Recorded by | Recorded here |
| --- | --- | --- |
| Upstream WPT source revision (and content hash) | this inventory | yes |
| Browser executable, channel and resolved version | the runner, per result | no |
| Chromium source-port revision | source-port documentation | no |

They must not be conflated. `revision` in a manifest is only the WPT source revision. When a
recorded baseline manifest and the checkout in use disagree, the generator fails rather than
replacing it, and `check-wpt-selection.py --compare-manifest`/`--expect-revision` reports the
mismatch. A known example: existing repository evidence pins a WPT revision whose checkout is not
present on every machine, so regenerating those artifacts against a different checkout is a
deliberate, recorded revision change, not an in-place refresh.

Verified interpreters for this tooling: Python 3.12 and 3.14, both producing identical manifests
from the same checkout and selection using only WPT's vendored `tools`, with no `pip install`. The
recorded interpreter is `provenance.generator.python`, which is in the volatile list precisely
because two interpreters must otherwise compare equal.

## Delivery seam (identified, not implemented here)

Runway is consumed externally by Scramjet plugin projects, and these scripts are not yet packaged
for that consumption. Open items, none of which are changed by this tooling:

- `package.json` has no `files`/`bin` entry covering `scripts/`, so an installed Runway does not
  necessarily ship `generate-serviceworker-wpt.py`, `check-wpt-selection.py`, `wpt_selection.py` or
  `wpt-crossspec-selection.json`. Consumers currently need the repository or a vendored copy.
  Deciding the packaged asset contract, including where the selection config lives once installed,
  is a packaging change outside this scope.
- `--selection` already lets a consumer supply its own selection config, so the bundled config is a
  default asset resolved next to the script rather than a required repository path.
- Browser executable/channel selection and recording the resolved version stay with the runner. The
  generator has no browser option on purpose; wiring a consumer-specified browser and its recorded
  version into results is a separate, unassigned integration.
- These scripts require Python and git on the consumer's machine, and an upstream WPT checkout that
  the consumer pins and supplies.
- A packaged asset contract must exclude `__pycache__`. Both entry points set
  `sys.dont_write_bytecode` so they do not create it themselves, but any bytecode directory that
  already exists next to them is a pre-existing local artefact: it is untracked, is not created or
  removed by this tooling, and is not covered by an ignore rule. Deciding whether to ignore it
  belongs to the packaging change, not here.

## What this does not do

- It does not run a browser, start wptserve, or produce results.
- It does not select, download or record a browser; that is the consumer's and the runner's job.
- It does not discover checkouts from home directories, sibling repositories or a repository
  layout, and it does not require any particular working directory.
- It does not change WPT sources, expectations or browser profiles.
- It does not execute anything and records no execution or result. Support-contract fields describe
  declared runner capability, never observed behaviour, and inventory-only entries (including
  support files) must never be reported as passes or as skips-that-pass.
- It establishes no transport or secure-context parity. Harness runs elsewhere have used an expired
  upstream certificate with certificate errors ignored, so no TLS or secure-context conclusion may
  be drawn from an inventory or from results collected that way.
- A larger inventory is a more accountable denominator, not evidence of parity.
