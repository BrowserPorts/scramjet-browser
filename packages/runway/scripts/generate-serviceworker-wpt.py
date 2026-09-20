"""Discover tracked upstream cases with WPT's own manifest parser.

The inventory produced here is consumed by Runway, which is the only WPT runner and browser
host: a Playwright-managed, consumer-specified pinned browser, run both bare and with the
Scramjet plugin. This script starts no server, launches no browser and produces no results, so
it deliberately has no browser option; the browser executable/channel is the consumer's choice
and its resolved version is recorded by the runner with each result. Browser build identity and
Chromium source-port identity are separate IDs and are never merged into the revision field.

The upstream WPT checkout is always an explicit argument. Nothing is discovered from home
directories, sibling repositories or a repository layout, and the scripts run from any working
directory: the selection config is resolved next to this script and every upstream path is
resolved against the supplied checkout root. A Chromium-embedded ``external/wpt`` tree is a
valid source snapshot but is not a prerequisite and usually cannot be used directly, because
its tools live outside the tests root; any independently pinned complete upstream checkout with
its vendored ``tools`` works.

Manifest identifiers are portable: upstream-relative paths, revisions, hashes and counts. Host
paths appear only under ``provenance.runLocal`` in generated output, which is run-local
evidence and not tracked source.

Every test item, type and variant comes from WPT's ``manifest.sourcefile.SourceFile``; this
script adds no parser of its own and does not reinterpret fixture semantics. On top of the
original inventory it records source-pinned provenance so a manifest can be tied back to the
exact upstream files it was produced from: the canonical checkout, its revision and dirty
state, the resolved selection, and a git-blob-sha1 per selected source file.

Existing fields keep their meaning and shape: ``revision``, ``suite``, ``paths``, ``tests``
entries (``url``, ``timeout``, ``testdriver``), ``otherCases`` entries (``path``, ``type``)
and ``counts`` are unchanged, so consumers of older manifests keep working and new fields are
purely additive. Manifest item types are labelled against the declared runner support contract
(``runnerSupportedType``, ``supportedTypes``), never against execution: this inventory records no
execution and no result, so nothing here may be read as a pass, a failure or a skip.

Only files tracked by git in the supplied checkout are inventoried. Ignored files are excluded on
purpose and untracked files are reported rather than inventoried, so an inventory is a statement
about the pinned tracked sources of the selection and is not a closure over the checkout's
contents.
"""
import sys

sys.dont_write_bytecode = True  # keep the repository free of __pycache__ from these scripts

import argparse
import hashlib
import json
from pathlib import Path
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wpt_selection

SCHEMA_VERSION = 2
# An inventory cannot observe execution, so it records none. What it can record is the producer
# side of the contract with the runner: the manifest item types the runner declares it can drive
# meaningfully. Everything else is inventory only. Support here means "the runner has a defined
# way to drive this type", never "this case ran" and never "this case passed".
SUPPORTED_TYPES = ("testharness", "crashtest", "reftest")

# Per-test flags recorded for every testharness entry, read from WPT's own
# URLManifestItem properties. Declared in the manifest so a consumer can tell a
# recorded False from a flag this producer never recorded.
RECORDED_TEST_FLAGS = ("https", "subdomain", "h2")
SUPPORT_CONTRACT_NOTE = (
    "Declared producer/runner support contract, not observation. This inventory records no "
    "execution and no result: executionRecorded is false and no field here means a case ran, "
    "passed, or was skipped. Supported types are the ones the runner has a defined way to drive "
    "(testharness, crashtest, reftest). Inventory-only types (manual, print-reftest, support and "
    "any other type) have no such handling. A runner that plain-loads an inventory-only type and "
    "reports it as a pass is wrong; fail-closed handling of unsupported types is owned by the "
    "runtime/packaging work, not by this generator.")
# Machine-specific and run-specific fields. Everything else in a manifest is portable:
# upstream-relative paths, revisions, hashes and counts, so two machines produce the same
# manifest for the same checkout and selection.
VOLATILE_FIELDS = (
    "provenance.generatedAt",
    "provenance.generator.durationSeconds",
    "provenance.generator.python",
    "provenance.runLocal",
    "provenance.output.replaced",
)

parser = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("source", help="Upstream WPT checkout")
parser.add_argument("output", help="Runway manifest JSON destination")
parser.add_argument("--path", action="append", dest="paths",
                    help="Upstream file or subtree; repeat to combine selections (default: service-workers)")
parser.add_argument("--suite", default=None,
                    help="Runway suite label (default: the preset's label, otherwise serviceworker)")
parser.add_argument("--selection", help="Selection config JSON (default: the config next to this script)")
parser.add_argument("--group", action="append", dest="groups",
                    help="Selection group from the config; repeat to combine")
parser.add_argument("--preset", help="Named preset from the selection config")
parser.add_argument("--allow-unresolved", action="store_true",
                    help="Record unresolved selections in the manifest and warn instead of failing")
parser.add_argument("--allow-duplicate-urls", action="store_true",
                    help="Record duplicate test URLs and keep the first instead of failing")
parser.add_argument("--no-clobber", action="store_true",
                    help="Fail instead of replacing an existing manifest at the destination")
parser.add_argument("--require-revision",
                    help="Expected upstream WPT revision; fail if the checkout is at another one. "
                         "This is the WPT source revision, not a browser build or Chromium "
                         "source-port revision")
parser.add_argument("--allow-revision-change", action="store_true",
                    help="Permit replacing an existing manifest that records a different upstream "
                         "revision; the change is warned about and recorded either way")
parser.add_argument("--allow-unparsable-sources", action="store_true",
                    help="Record selected files that WPT's parser cannot read and continue, "
                         "instead of failing; the aggregate hash is withheld either way")
parser.add_argument("--no-source-inventory", action="store_true",
                    help="Omit the per-source-file inventory; the aggregate hash and coverage "
                         "counts are still recorded, and their absence is stated in the manifest")
args = parser.parse_args()


def warn(message):
    print(f"warning: {message}", file=sys.stderr)


root = Path(args.source).resolve()
if not root.is_dir():
    parser.error(f"{root} is not a directory")

# Resolve the selection before importing WPT tooling so a bad selection fails cheaply.
config = None
config_path = None
groups = []
preset_suite = None
try:
    if args.paths:
        if args.groups or args.preset:
            parser.error("--path cannot be combined with --group or --preset")
        paths = [wpt_selection.validate_selection_path(entry, "--path")
                 for entry in dict.fromkeys(args.paths)]
        selection_source = "explicit --path selection"
    else:
        names = list(args.groups or [])
        if args.preset or names:
            config_path = (Path(args.selection).resolve() if args.selection
                           else wpt_selection.default_config_path())
            config = wpt_selection.load_config(config_path)
            if args.preset:
                preset_suite = config["presets"][args.preset]["suite"] \
                    if args.preset in config.get("presets", {}) else None
                names = wpt_selection.preset_groups(config, args.preset) + names
            groups = wpt_selection.group_records(config, names)
            paths = wpt_selection.ordered_paths(groups)
            selection_source = f"config {config_path}"
        else:
            paths = list(wpt_selection.DEFAULT_PATHS)
            selection_source = "historical default selection"
    if args.selection and config is None:
        parser.error("--selection requires --group or --preset")
    selected_files, resolution = wpt_selection.resolve_paths(root, paths)
    unresolved = wpt_selection.unresolved_paths(resolution)
    source_state = wpt_selection.repo_state(root, paths)
except wpt_selection.SelectionError as error:
    parser.error(str(error))

suite = args.suite or preset_suite or "serviceworker"

if args.require_revision and args.require_revision != source_state["revision"]:
    parser.error(f"--require-revision {args.require_revision} does not match the checkout's WPT "
                 f"revision {source_state['revision']} at {root}. This compares WPT source "
                 "revisions only; browser build and Chromium source-port IDs are separate")

if unresolved:
    detail = "; ".join(f"{entry['path']} ({entry['reason']})" for entry in unresolved)
    if not args.allow_unresolved:
        parser.error("the selection does not resolve completely: " + detail
                     + ". Fix the selection, or pass --allow-unresolved to record it in the manifest")
    warn("unresolved selections recorded in the manifest: " + detail)
if not selected_files:
    parser.error("The selection does not contain any tracked WPT files")
if source_state["selectedPathsDirty"]:
    warn(f"{source_state['selectedChangedTrackedFileCount']} changed tracked and "
         f"{source_state['selectedUntrackedFileCount']} untracked file(s) inside the selected "
         f"paths, so revision {source_state['revision']} alone does not identify the inventoried "
         "sources; the manifest records this")
elif source_state["repositoryDirty"]:
    # Reported, not silenced: the selection is clean but the containing repository is not.
    warn(f"the selected paths are clean but the containing repository has "
         f"{source_state['repositoryChangedTrackedFileCount']} changed tracked and "
         f"{source_state['repositoryUntrackedFileCount']} untracked file(s); the inventory "
         "depends only on the selected paths and does not claim the repository is clean")

destination = Path(args.output)
replaced = None
if destination.exists():
    if args.no_clobber:
        parser.error(f"{destination} already exists and --no-clobber was given")
    replaced = {"bytes": destination.stat().st_size, "revision": None, "suite": None,
                "testCount": None, "parsedAsManifest": False, "revisionMismatch": False}
    try:
        previous = json.loads(destination.read_text())
    except (OSError, json.JSONDecodeError) as error:
        replaced["unreadable"] = f"{type(error).__name__}: {error}"
    else:
        if isinstance(previous, dict):
            replaced["parsedAsManifest"] = isinstance(previous.get("tests"), list)
            replaced["revision"] = previous.get("revision")
            replaced["suite"] = previous.get("suite")
            replaced["testCount"] = len(previous["tests"]) if isinstance(previous.get("tests"), list) else None
    replaced["revisionMismatch"] = bool(replaced["revision"]
                                       and replaced["revision"] != source_state["revision"])
    warn(f"replacing the existing manifest at {destination} "
         f"(revision {replaced['revision']}, suite {replaced['suite']}, "
         f"{replaced['testCount']} tests, {replaced['bytes']} bytes); copy it first if it is "
         "evidence, or use --no-clobber to refuse replacement")
    if replaced["revisionMismatch"]:
        # A baseline manifest must never be replaced by an inventory of a different upstream
        # revision without the operator saying so; the mismatch is recorded either way.
        message = (f"revision mismatch: {destination} records upstream WPT revision "
                   f"{replaced['revision']} but this checkout is at {source_state['revision']}")
        if not args.allow_revision_change:
            parser.error(message + ". Write to a new destination, or pass "
                         "--allow-revision-change to replace the recorded baseline on purpose")
        warn(message + "; replacing it because --allow-revision-change was given")

sys.path.insert(0, str(root / "tools"))
try:
    import localpaths  # noqa: F401  WPT's vendored Python dependencies
    from manifest.sourcefile import SourceFile
except Exception as error:
    parser.error(f"WPT manifest tooling is not importable from {root / 'tools'}: "
                 f"{type(error).__name__}: {error}. A complete standalone upstream checkout with "
                 "its vendored tools is required; a Chromium-embedded external/wpt snapshot keeps "
                 "its tools outside the tests root and does not satisfy this on its own")
for attribute in ("manifest_items", "hash", "type", "test_variants"):
    if not hasattr(SourceFile, attribute):
        parser.error(f"the checkout's SourceFile has no {attribute}; this WPT revision is not "
                     "compatible with this generator")

started = time.monotonic()
tests = []
other_cases = []
sources = []
counts = {}
hash_lines = []
hash_failures = []
duplicate_urls = {}
seen_urls = {}
unparsable = []


def optional(mapping, key, value):
    """Record a manifest-item property only when the item actually carries one."""
    if value not in (None, [], {}, ()):
        mapping[key] = value


for relative in sorted(selected_files):
    try:
        source_file = SourceFile(str(root), relative, "/")
        kind, entries = source_file.manifest_items()
    except Exception as error:
        # A selected file WPT cannot read or parse is never dropped quietly: it is recorded and,
        # by default, fails the run, because an inventory missing a selected file is not an
        # inventory of that selection.
        unparsable.append({"path": relative, "error": f"{type(error).__name__}: {error}"})
        continue
    counts[kind] = counts.get(kind, 0) + len(entries)
    try:
        digest = source_file.hash
    except Exception as error:
        digest = None
        hash_failures.append({"path": relative, "error": f"{type(error).__name__}: {error}"})
    else:
        hash_lines.append(f"{relative}\t{digest}")
    variants = []
    if kind not in ("support", "spec"):
        try:
            # WPT's own variant enumeration; nothing is derived from the URL or file name here.
            variants = [variant for variant in source_file.test_variants if variant]
        except Exception as error:  # a malformed variant declaration is upstream's, not ours
            variants = []
            warn(f"{relative}: WPT could not enumerate variants: {type(error).__name__}: {error}")
    record = {
        "path": relative,
        "type": kind,
        "hash": digest,
        "itemCount": len(entries),
        "runnerSupportedType": kind in SUPPORTED_TYPES,
        "selectedBy": selected_files[relative],
    }
    optional(record, "variants", variants)
    sources.append(record)
    if kind == "testharness":
        for entry in entries:
            case = {"url": entry.url, "timeout": entry.timeout, "testdriver": entry.testdriver,
                    # entry.path is the source WPT generated this URL from; it is not inferred
                    # from the URL, so .any.js-style generated variants map back correctly.
                    "source": entry.path.replace("\\", "/"),
                    # entry.h2 is a sibling of entry.https/entry.subdomain on WPT's own
                    # URLManifestItem: all three read the same `_flags` set. It is recorded
                    # unconditionally (not via optional()) so that `false` is a recorded fact
                    # and a consumer can tell it apart from "this producer never looked".
                    "https": entry.https, "subdomain": entry.subdomain,
                    "h2": bool(entry.h2)}
            optional(case, "testdriverFeatures", getattr(entry, "testdriver_features", None))
            optional(case, "scriptMetadata",
                     [list(pair) for pair in (getattr(entry, "script_metadata", None) or [])])
            optional(case, "pac", getattr(entry, "pac", None))
            if getattr(entry, "jsshell", None):  # as upstream records it: only when set
                case["jsshell"] = True
            if entry.url in seen_urls:
                duplicate_urls.setdefault(entry.url, [seen_urls[entry.url]])
                duplicate_urls[entry.url].append(case["source"])
                continue
            seen_urls[entry.url] = case["source"]
            tests.append(case)
    elif kind != "support":
        # One entry per source file, as before, with the item detail added alongside it.
        items = []
        for entry in entries:
            item = {"type": kind}
            optional(item, "url", getattr(entry, "url", None))
            optional(item, "timeout", getattr(entry, "timeout", None))
            optional(item, "references",
                     [list(reference) for reference in (getattr(entry, "references", None) or [])])
            items.append(item)
        case = {"path": relative, "type": kind, "items": items, "itemCount": len(entries),
                "runnerSupportedType": kind in SUPPORTED_TYPES}
        optional(case, "variants", variants)
        other_cases.append(case)

if unparsable:
    detail = "; ".join(f"{entry['path']} ({entry['error']})" for entry in unparsable[:10])
    if len(unparsable) > 10:
        detail += f"; and {len(unparsable) - 10} more"
    if not args.allow_unparsable_sources:
        parser.error(f"WPT's parser could not read {len(unparsable)} selected file(s): {detail}. "
                     "Fix the checkout, or pass --allow-unparsable-sources to record them and "
                     "continue with an explicitly incomplete inventory")
    warn(f"{len(unparsable)} selected file(s) could not be parsed by WPT and are recorded as "
         f"unparsable rather than inventoried: {detail}")

if duplicate_urls:
    detail = "; ".join(f"{url} from {', '.join(paths)}" for url, paths in sorted(duplicate_urls.items()))
    if not args.allow_duplicate_urls:
        parser.error("the selection produces duplicate test URLs: " + detail
                     + ". Narrow the selection, or pass --allow-duplicate-urls to keep the first "
                       "occurrence and record the collision")
    warn("duplicate test URLs kept once and recorded in the manifest: " + detail)

tests.sort(key=lambda entry: entry["url"])
other_cases.sort(key=lambda entry: entry["path"])
# The aggregate pins the selection only if every selected file was hashed. A partial digest
# would look like a pin while silently omitting files, so it is withheld instead.
hashes_complete = (bool(hash_lines) and not hash_failures and not unparsable
                   and len(hash_lines) == len(selected_files))
aggregate = (hashlib.sha256("\n".join(sorted(hash_lines)).encode()).hexdigest()
             if hashes_complete else None)
aggregate_reason = None if hashes_complete else (
    f"withheld: {len(hash_lines)} of {len(selected_files)} selected files hashed"
    + (f", {len(hash_failures)} hash failure(s)" if hash_failures else "")
    + (f", {len(unparsable)} unparsable file(s)" if unparsable else "")
    + "; a partial digest would not pin the selection")
# The manifest body keeps only portable identifiers; host paths move to provenance.runLocal.
portable_source = {key: value for key, value in source_state.items()
                   if key not in ("path", "topLevel")}
supported_counts = {kind: total for kind, total in sorted(counts.items())
                    if kind in SUPPORTED_TYPES}
inventory_only_counts = {kind: total for kind, total in sorted(counts.items())
                         if kind not in SUPPORTED_TYPES}

result = {
    # Unchanged fields, in their original meaning.
    "revision": source_state["revision"],
    "suite": suite,
    "paths": paths,
    "tests": tests,
    "otherCases": other_cases,
    "counts": dict(sorted(counts.items())),
    # Additive provenance.
    "provenance": {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "generator": {
            "script": Path(__file__).name,
            "python": sys.version.split()[0],
            "durationSeconds": None,
        },
        "manifestTooling": {
            "provider": "wpt manifest.sourcefile.SourceFile",
            "customParser": False,
            "note": "Item types, URLs, timeouts, testdriver flags, references and variants are "
                    "reported exactly as WPT's own parser produces them.",
        },
        "identity": {
            "wptSourceRevision": source_state["revision"],
            "wptSourceAggregateHash": aggregate,
            "wptSourceAggregateHashComplete": hashes_complete,
            "browserBuild": None,
            "chromiumSourcePortRevision": None,
            "runner": "Runway (Playwright-managed, consumer-specified pinned browser, run bare "
                      "and with the Scramjet plugin) is the only WPT runner and browser host.",
            "note": "These are distinct identifiers and must not be conflated. This inventory "
                    "pins the upstream WPT source revision and content hash only; the resolved "
                    "browser executable, channel and version are recorded per result by the "
                    "runner, and any Chromium source-port revision is recorded separately. No "
                    "inventory field describes a browser or a result. All identifiers here are "
                    "portable: no host path is needed to compare two manifests.",
        },
        "source": portable_source,
        "selection": {
            "selectionSource": selection_source,
            "config": config_path.name if config_path else None,
            "preset": args.preset,
            "groups": groups,
            "requestedPaths": paths,
            "resolution": resolution,
            "unresolvedPaths": unresolved,
            "unresolvedAllowed": bool(args.allow_unresolved),
            "unparsableSources": unparsable,
            "unparsableSourcesAllowed": bool(args.allow_unparsable_sources),
            "trackedFileCount": len(selected_files),
            "scope": (config or {}).get("scope",
                                        "Bounded selection of upstream paths; no closure over "
                                        "WPT is claimed."),
        },
        "hashes": {
            "perFileAlgorithm": "git-blob-sha1",
            "perFileAlgorithmNote": "SourceFile.hash: sha1 of git's blob framing, so it equals "
                                    "git hash-object for the same file.",
            "perFileRecorded": not args.no_source_inventory,
            "coverage": {
                "selectedFiles": len(selected_files),
                "hashed": len(hash_lines),
                "failed": hash_failures,
                "complete": hashes_complete,
            },
            "aggregate": {
                "algorithm": "sha256",
                "input": "sorted '<upstream path>\\t<git-blob-sha1>' lines, newline joined",
                "value": aggregate,
                "complete": hashes_complete,
                "withheldReason": aggregate_reason,
            },
        },
        "validation": {
            "selectedPathsResolved": not unresolved,
            "allSelectedFilesParsed": not unparsable,
            "testUrlsUnique": not duplicate_urls,
            "duplicateTestUrls": {url: paths for url, paths in sorted(duplicate_urls.items())},
            "duplicatesAllowed": bool(args.allow_duplicate_urls),
            "requiredRevision": args.require_revision,
            "revisionChangeAllowed": bool(args.allow_revision_change),
            "ordering": "tests sorted by url, otherCases and sources sorted by upstream path, "
                        "counts sorted by type",
            "deterministic": "Identical inputs produce an identical manifest apart from the "
                             "volatileFields listed below.",
            "volatileFields": list(VOLATILE_FIELDS),
        },
        "inventory": {
            "executionRecorded": False,
            "supportedTypes": supported_counts,
            "supportedTypeNames": list(SUPPORTED_TYPES),
            "inventoryOnlyTypes": inventory_only_counts,
            "supportFiles": counts.get("support", 0),
            "note": SUPPORT_CONTRACT_NOTE,
            "inventoriedSourceFileCount": len(sources),
            "unparsableSourceFileCount": len(unparsable),
            # Which per-test flags this producer actually recorded. A consumer must not
            # read an absent flag as False; this list is how it tells the difference
            # between "recorded and false" and "never recorded".
            "recordedTestFlags": list(RECORDED_TEST_FLAGS),
            "testItemCount": len(tests),
            "otherCaseFileCount": len(other_cases),
            "otherCaseItemCount": sum(entry["itemCount"] for entry in other_cases),
        },
        "output": {"replaced": replaced},
        "runLocal": {
            "note": "Host-specific values for this run only. They are never needed to interpret "
                    "or compare a manifest; every portable identifier is recorded above.",
            "wptSourcePath": source_state["path"],
            "wptSourceTopLevel": source_state["topLevel"],
            "toolsPath": str(root / "tools"),
            "selectionConfigPath": str(config_path) if config_path else None,
            "outputPath": str(destination),
            "argv": sys.argv[1:],
            "cwd": str(Path.cwd()),
        },
    },
}
if args.no_source_inventory:
    result["provenance"]["hashes"]["perFileOmitted"] = (
        "--no-source-inventory was given, so the per-file hashes and the source-to-item mapping "
        "are not in this manifest; only the aggregate hash and coverage counts are.")
else:
    result["sources"] = sources
result["provenance"]["generator"]["durationSeconds"] = round(time.monotonic() - started, 3)

destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result["counts"]))
