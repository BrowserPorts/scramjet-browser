"""Report whether an upstream WPT checkout can serve a Runway inventory selection.

This is a readiness check, not an inventory: it resolves the selection through the upstream
checkout's git index, reports unresolved paths, selection overlap and working-tree dirt, and
optionally verifies that WPT's own manifest tooling is importable with the attributes the
generator uses. It never parses upstream test content and never reports a result for a test.

Runway, with its Playwright-managed consumer-specified pinned browser, is the only WPT runner and
browser host, bare and with the Scramjet plugin; this check neither starts a server nor launches a
browser and has no browser option. The upstream checkout is always an explicit argument: nothing is
discovered from home directories or sibling repositories, the selection config is resolved next to
this script, and the check runs from any working directory. Any independently pinned complete
upstream checkout with vendored tools is acceptable. A Chromium-embedded external/wpt tree is a
valid source snapshot but keeps its tools outside the tests root, so it is not a prerequisite and
usually fails --check-tooling. The revision reported here is the WPT source revision only; browser
build and Chromium source-port identifiers are separate and are not compared against it. The report
contains host paths because it is run-local evidence, never tracked source.
"""
import sys

sys.dont_write_bytecode = True  # keep the repository free of __pycache__ from these scripts

import argparse
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wpt_selection

parser = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("source", help="Upstream WPT checkout")
parser.add_argument("--selection", help="Selection config JSON (default: the config next to this script)")
parser.add_argument("--group", action="append", dest="groups",
                    help="Selection group; repeat to combine")
parser.add_argument("--preset", help="Named preset from the selection config")
parser.add_argument("--path", action="append", dest="paths",
                    help="Upstream file or subtree, bypassing the config; repeat to combine")
parser.add_argument("--check-tooling", action="store_true",
                    help="Import WPT's manifest tooling from the checkout and report the "
                         "SourceFile attributes the generator relies on")
parser.add_argument("--require-clean", action="store_true",
                    help="Fail when the selected paths have uncommitted changes")
parser.add_argument("--expect-revision",
                    help="Expected upstream WPT source revision; a mismatch is reported as a "
                         "problem instead of being accepted silently")
parser.add_argument("--compare-manifest",
                    help="Existing Runway manifest to compare against; reports a revision "
                         "mismatch so a recorded baseline is never replaced unknowingly")
parser.add_argument("--json", dest="json_output", help="Write the full report to this JSON file")
args = parser.parse_args()

root = Path(args.source).resolve()
if not root.is_dir():
    parser.error(f"{root} is not a directory")

report = {"source": None, "selection": {}, "tooling": None, "comparison": None,
          "interpreter": sys.version.split()[0], "problems": [],
          "identityNote": "The revision below is the upstream WPT source revision. Browser build "
                          "and Chromium source-port identifiers are separate and are recorded by "
                          "Runway's results and the source-port docs, not here.",
          "runner": "Runway (Playwright-managed consumer-specified pinned browser, bare and "
                    "with the Scramjet plugin); this check never launches it"}
try:
    config_path = Path(args.selection).resolve() if args.selection else wpt_selection.default_config_path()
    config = None
    groups = []
    if args.paths:
        if args.groups or args.preset:
            parser.error("--path cannot be combined with --group or --preset")
        paths = [wpt_selection.validate_selection_path(entry, "--path")
                 for entry in dict.fromkeys(args.paths)]
        source_of_selection = "explicit --path selection"
    else:
        config = wpt_selection.load_config(config_path)
        names = list(args.groups or [])
        if args.preset:
            names = wpt_selection.preset_groups(config, args.preset) + names
        if not names:
            paths = list(wpt_selection.DEFAULT_PATHS)
            source_of_selection = "default URL selection"
        else:
            groups = wpt_selection.group_records(config, names)
            paths = wpt_selection.ordered_paths(groups)
            source_of_selection = f"config {config_path}"
    files, resolution = wpt_selection.resolve_paths(root, paths)
    unresolved = wpt_selection.unresolved_paths(resolution)
    state = wpt_selection.repo_state(root, paths)
except wpt_selection.SelectionError as error:
    parser.error(str(error))

report["source"] = state
report["selection"] = {
    "selectionSource": source_of_selection,
    "config": str(config_path) if config is not None else None,
    "preset": args.preset,
    "groups": groups,
    "requestedPaths": paths,
    "resolution": resolution,
    "unresolvedPaths": unresolved,
    "trackedFileCount": len(files),
    "scope": (config or {}).get("scope"),
}

if args.check_tooling:
    tooling = {"toolsPath": str(root / "tools"), "importable": False, "missingAttributes": [],
               "sourceFileHashAlgorithm": None, "error": None}
    try:
        sys.path.insert(0, str(root / "tools"))
        import localpaths  # noqa: F401  WPT's vendored Python dependencies
        from manifest.sourcefile import SourceFile

        tooling["importable"] = True
        required = ("manifest_items", "hash", "type", "test_variants", "url", "rel_path_parts")
        tooling["missingAttributes"] = [name for name in required if not hasattr(SourceFile, name)]
        # Verified against git rather than assumed: hash a real selected file with WPT's own
        # SourceFile and compare it with the checkout's git object id for the same file.
        probe = next(iter(sorted(files)), None)
        if probe is not None:
            computed = SourceFile(str(root), probe, "/").hash
            recorded = wpt_selection.git_output(root, ["hash-object", "--", probe]).strip()
            tooling["hashProbe"] = {"file": probe, "sourceFileHash": computed,
                                    "gitHashObject": recorded, "match": computed == recorded}
            tooling["sourceFileHashAlgorithm"] = ("git-blob-sha1 (verified against git hash-object)"
                                                 if computed == recorded else
                                                 "unverified: SourceFile.hash does not match git hash-object")
            if computed != recorded:
                report["problems"].append(
                    f"SourceFile.hash {computed} does not match git hash-object {recorded} for {probe}")
    except Exception as error:  # the checkout may lack WPT's Python dependencies
        tooling["error"] = f"{type(error).__name__}: {error}"
    report["tooling"] = tooling
    if not tooling["importable"]:
        report["problems"].append(f"WPT manifest tooling is not importable: {tooling['error']}")
    elif tooling["missingAttributes"]:
        report["problems"].append(
            "WPT SourceFile lacks attributes the generator uses: "
            + ", ".join(tooling["missingAttributes"]))

if args.expect_revision and args.expect_revision != state["revision"]:
    report["problems"].append(
        f"expected WPT source revision {args.expect_revision} but the checkout is at "
        f"{state['revision']}")
if args.compare_manifest:
    manifest_path = Path(args.compare_manifest)
    comparison = {"path": str(manifest_path), "recordedRevision": None, "recordedSuite": None,
                  "matchesCheckout": None, "readable": False}
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        comparison["error"] = f"{type(error).__name__}: {error}"
        report["problems"].append(f"--compare-manifest {manifest_path} is not readable JSON")
    else:
        comparison["readable"] = True
        if isinstance(manifest, dict):
            comparison["recordedRevision"] = manifest.get("revision")
            comparison["recordedSuite"] = manifest.get("suite")
            comparison["matchesCheckout"] = manifest.get("revision") == state["revision"]
            if not comparison["matchesCheckout"]:
                report["problems"].append(
                    f"{manifest_path} records upstream WPT revision "
                    f"{manifest.get('revision')!r} but this checkout is at {state['revision']}; "
                    "regenerating into that path would replace a baseline from another revision")
        else:
            report["problems"].append(f"--compare-manifest {manifest_path} is not a JSON object")
    report["comparison"] = comparison

for entry in unresolved:
    report["problems"].append(f"unresolved selection {entry['path']}: {entry['reason']}")
if args.require_clean and state["selectedPathsDirty"]:
    report["problems"].append(
        f"{state['selectedChangedTrackedFileCount']} changed tracked and "
        f"{state['selectedUntrackedFileCount']} untracked file(s) inside the selected paths, so "
        f"revision {state['revision']} does not identify the selected sources")

print(f"checkout   {state['path']}")
print(f"revision   {state['revision']} ({state['committerDate']})")
nesting = ("the WPT root is the repository root" if state["wptRootIsRepositoryRoot"]
           else f"the WPT root is nested at {state['repositoryRootRelativePrefix']!r} in its repository")
print(f"layout     {nesting}")
print(f"repo state {'dirty' if state['repositoryDirty'] else 'clean'}: "
      f"{state['repositoryChangedTrackedFileCount']} changed tracked, "
      f"{state['repositoryUntrackedFileCount']} untracked (-uall, whole repository)")
print(f"sel state  {'dirty' if state['selectedPathsDirty'] else 'clean'}: "
      f"{state['selectedChangedTrackedFileCount']} changed tracked, "
      f"{state['selectedUntrackedFileCount']} untracked (selected paths only; this says nothing "
      "about the rest of the repository)")
print(f"selection  {source_of_selection}")
if groups:
    for group in groups:
        counts = sum(record["trackedFiles"] for record in resolution if record["path"] in group["paths"])
        print(f"  [{group['tier']}] {group['name']}: {counts} tracked file(s) across "
              f"{len(group['paths'])} path(s)")
for record in resolution:
    marker = "ok " if record["resolved"] else "MISSING"
    extra = []
    if record["filesAlreadyClaimedByAnEarlierSelection"]:
        extra.append(f"{record['filesAlreadyClaimedByAnEarlierSelection']} already selected")
    if record["untrackedFiles"]:
        extra.append(f"{record['untrackedFiles']} untracked ignored")
    print(f"  {marker} {record['path']}: {record['trackedFiles']} tracked file(s)"
          + (f" ({'; '.join(extra)})" if extra else ""))
print(f"total      {len(files)} distinct tracked file(s) selected")
if report["tooling"]:
    tooling = report["tooling"]
    print(f"tooling    {'importable' if tooling['importable'] else 'NOT importable'} from "
          f"{tooling['toolsPath']}"
          + (f"; SourceFile.hash is {tooling['sourceFileHashAlgorithm']}" if tooling["importable"]
             else f"; {tooling['error']}"))

if args.json_output:
    destination = Path(args.json_output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"report     {destination}")

for problem in report["problems"]:
    print(f"problem    {problem}", file=sys.stderr)
if report["problems"]:
    sys.exit(1)
print("ready      the selection resolves completely against this checkout")
