"""Selection-config loading and upstream path resolution for Runway's WPT inventory scripts.

No WPT tooling is imported here: resolution only reads the upstream checkout's git index,
so a readiness check stays cheap and does not require WPT's vendored Python dependencies.
The scripts that need real manifest items import WPT's own ``manifest.sourcefile`` instead
of parsing upstream files here; this module never interprets test content.
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
from typing import Any, Dict, List, Tuple

# The historical default selection of generate-serviceworker-wpt.py. Kept here so the
# generator and the readiness helper agree on what "no selection given" means.
DEFAULT_PATHS: List[str] = ["service-workers"]
DEFAULT_CONFIG_NAME = "wpt-crossspec-selection.json"
TIERS = ("primary", "supporting", "inventory-only")
DIRTY_LIST_LIMIT = 100
# Rejected in selection entries. Git pathspec magic and glob characters could silently widen or
# redirect a selection, and traversal could leave the checkout, so all of it is refused up front
# and every git call additionally passes --literal-pathspecs.
GLOB_CHARACTERS = "*?[]"


class SelectionError(Exception):
    """A selection config, upstream checkout or path selection cannot be used as given."""


def validate_selection_path(entry: object, origin: str) -> str:
    """Accept only a plain, relative, non-widening upstream path.

    Applied to config entries and to command-line --path values alike, so neither can introduce
    pathspec magic (``:``-prefixed), traversal (``..``), an absolute path or a glob that would
    resolve to something other than the literal path named.
    """
    if not isinstance(entry, str) or not entry.strip():
        raise SelectionError(f"{origin} records {entry!r}; paths must be non-empty strings")
    if entry != entry.strip():
        raise SelectionError(f"{origin} records {entry!r}; paths must not have surrounding whitespace")
    if entry.startswith(":"):
        raise SelectionError(f"{origin} records {entry!r}; git pathspec magic is not accepted")
    if entry.startswith("/") or (len(entry) > 1 and entry[1] == ":"):
        raise SelectionError(f"{origin} records {entry!r}; paths must be relative to the checkout")
    if entry.startswith("\\") or "\\" in entry:
        raise SelectionError(f"{origin} records {entry!r}; use forward slashes in upstream paths")
    parts = entry.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise SelectionError(
            f"{origin} records {entry!r}; empty, '.' and '..' path segments are not accepted")
    found = [character for character in GLOB_CHARACTERS if character in entry]
    if found:
        raise SelectionError(
            f"{origin} records {entry!r}; glob characters ({''.join(found)}) are not accepted "
            "because a selection must name literal upstream paths")
    return entry


def default_config_path() -> Path:
    """The cross-spec selection config shipped next to these scripts."""
    return Path(__file__).resolve().parent / DEFAULT_CONFIG_NAME


def load_config(path: Path) -> Dict[str, Any]:
    """Read and structurally validate a selection config.

    Every failure is raised, never defaulted away: an unreadable, malformed or internally
    inconsistent config must stop a run instead of silently narrowing the inventory.
    """
    try:
        document = json.loads(path.read_text())
    except OSError as error:
        raise SelectionError(f"selection config {path} is unreadable: {error}") from error
    except json.JSONDecodeError as error:
        raise SelectionError(f"selection config {path} is not valid JSON: {error}") from error
    if not isinstance(document, dict):
        raise SelectionError(f"selection config {path} is not a JSON object")
    if document.get("version") != 1:
        raise SelectionError(
            f"selection config {path} records version {document.get('version')!r}; "
            "this tooling only understands version 1")
    groups = document.get("groups")
    if not isinstance(groups, dict) or not groups:
        raise SelectionError(f"selection config {path} records no groups object")
    for name, group in groups.items():
        if not isinstance(group, dict):
            raise SelectionError(f"selection config {path} group {name!r} is not an object")
        paths = group.get("paths")
        if not isinstance(paths, list) or not paths:
            raise SelectionError(f"selection config {path} group {name!r} records no paths list")
        for entry in paths:
            validate_selection_path(entry, f"selection config {path} group {name!r}")
        if group.get("tier") not in TIERS:
            raise SelectionError(
                f"selection config {path} group {name!r} records tier {group.get('tier')!r}; "
                f"expected one of {', '.join(TIERS)}")
        if not isinstance(group.get("rationale"), str) or not group["rationale"].strip():
            raise SelectionError(
                f"selection config {path} group {name!r} records no rationale; a selection "
                "without a stated reason cannot be reviewed")
    presets = document.get("presets")
    if not isinstance(presets, dict) or not presets:
        raise SelectionError(f"selection config {path} records no presets object")
    for name, preset in presets.items():
        if not isinstance(preset, dict):
            raise SelectionError(f"selection config {path} preset {name!r} is not an object")
        members = preset.get("groups")
        if not isinstance(members, list) or not members:
            raise SelectionError(f"selection config {path} preset {name!r} records no groups list")
        missing = [member for member in members if member not in groups]
        if missing:
            raise SelectionError(
                f"selection config {path} preset {name!r} references undefined groups: "
                f"{', '.join(map(str, missing))}")
        if not isinstance(preset.get("suite"), str) or not preset["suite"].strip():
            raise SelectionError(f"selection config {path} preset {name!r} records no suite label")
    return document


def preset_groups(config: Dict[str, Any], name: str) -> List[str]:
    """Group names for a preset, or a listing error naming the available presets."""
    preset = config.get("presets", {}).get(name)
    if preset is None:
        available = ", ".join(sorted(config.get("presets", {})))
        raise SelectionError(f"unknown preset {name!r}; the config defines {available}")
    return list(preset["groups"])


def group_records(config: Dict[str, Any], names: List[str]) -> List[Dict[str, Any]]:
    """Config records for the requested groups, in request order, rejecting unknown names."""
    groups = config.get("groups", {})
    records = []
    seen = set()
    for name in names:
        if name not in groups:
            available = ", ".join(sorted(groups))
            raise SelectionError(f"unknown group {name!r}; the config defines {available}")
        if name in seen:
            continue
        seen.add(name)
        group = groups[name]
        records.append({
            "name": name,
            "tier": group["tier"],
            "rationale": group["rationale"],
            "paths": list(group["paths"]),
        })
    return records


def ordered_paths(records: List[Dict[str, Any]]) -> List[str]:
    """Selected upstream paths in group order with repeated entries collapsed once."""
    paths: List[str] = []
    for record in records:
        for path in record["paths"]:
            if path not in paths:
                paths.append(path)
    return paths


def git_output(root: Path, arguments: List[str]) -> str:
    """Run git in the upstream checkout, turning any failure into a SelectionError.

    ``--literal-pathspecs`` is always passed so a selection entry is matched as the literal path
    it names: no pathspec magic, no glob expansion, no widening.
    """
    try:
        return subprocess.check_output(["git", "--literal-pathspecs", "-C", str(root), *arguments],
                                       text=True, stderr=subprocess.PIPE)
    except FileNotFoundError as error:  # pragma: no cover - depends on the host
        raise SelectionError("git is required to resolve an upstream WPT selection") from error
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or "").strip() or f"exit status {error.returncode}"
        raise SelectionError(f"git {' '.join(arguments)} failed in {root}: {detail}") from error


def _split(payload: str) -> List[str]:
    return [entry for entry in payload.split("\0") if entry]


def resolve_paths(root: Path, paths: List[str]) -> Tuple[Dict[str, str], List[Dict[str, Any]]]:
    """Resolve selected paths to tracked upstream files.

    Returns the tracked files (upstream-relative path to the selection entry that first
    claimed it) and one resolution record per requested path. Overlap between selections is
    reported rather than silently duplicated, and a path that resolves to nothing is reported
    as unresolved instead of being dropped.
    """
    files: Dict[str, str] = {}
    resolution: List[Dict[str, Any]] = []
    for path in paths:
        target = root / path
        tracked = _split(git_output(root, ["ls-files", "-z", "--", path]))
        untracked = _split(git_output(
            root, ["ls-files", "-z", "--others", "--exclude-standard", "--", path]))
        overlapping = 0
        for relative in tracked:
            if relative in files:
                overlapping += 1
            else:
                files[relative] = path
        resolution.append({
            "path": path,
            "existsOnDisk": target.exists(),
            "isDirectory": target.is_dir(),
            "trackedFiles": len(tracked),
            "untrackedFiles": len(untracked),
            "filesAlreadyClaimedByAnEarlierSelection": overlapping,
            "resolved": bool(tracked),
        })
    return files, resolution


def unresolved_paths(resolution: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Selections that matched no tracked file, with the reason recorded per entry."""
    problems = []
    for record in resolution:
        if record["resolved"]:
            continue
        if not record["existsOnDisk"]:
            reason = "the path does not exist in the checkout"
        elif record["isDirectory"]:
            reason = ("the directory exists but contains no tracked files"
                      + (f"; {record['untrackedFiles']} untracked file(s) were ignored"
                         if record["untrackedFiles"] else ""))
        else:
            reason = "the file exists but is not tracked by git"
        problems.append({"path": record["path"], "reason": reason})
    return problems


def parse_porcelain(payload: str) -> List[Dict[str, str]]:
    """Parse ``git status --porcelain -z`` records.

    NUL separated so paths containing spaces, quotes or newlines survive intact; rename and copy
    records carry a second path field, which is consumed rather than mistaken for a new entry.
    """
    fields = payload.split("\0")
    records: List[Dict[str, str]] = []
    index = 0
    while index < len(fields):
        field = fields[index]
        index += 1
        if not field:
            continue
        if len(field) < 4:  # not a status record
            continue
        code, path = field[:2], field[3:]
        origin = ""
        if code[0] in ("R", "C") or code[1] in ("R", "C"):
            if index < len(fields):
                origin = fields[index]
                index += 1
        records.append({"code": code, "path": path, "originPath": origin})
    return records


def repo_state(root: Path, paths: List[str]) -> Dict[str, Any]:
    """Revision and working-tree state of the upstream checkout, nested-root aware.

    ``git status`` reports repository-root-relative paths while ``git ls-files`` run inside the
    checkout reports checkout-relative paths, so when the WPT tests root is a subdirectory of a
    larger repository the status paths are normalised with ``--show-prefix`` before use. The
    whole-repository state and the selected-path state are reported as separate facts: a clean
    selection never implies a clean repository, and untracked files are counted with ``-uall`` so
    a collapsed directory entry cannot understate them.
    """
    revision = git_output(root, ["rev-parse", "HEAD"]).strip()
    prefix = git_output(root, ["rev-parse", "--show-prefix"]).strip()
    repository = parse_porcelain(git_output(root, ["status", "--porcelain", "-z", "-uall"]))
    selected = parse_porcelain(git_output(
        root, ["status", "--porcelain", "-z", "-uall", "--", *paths]))

    def relative(record: Dict[str, str]) -> str:
        # status paths are repository-root relative; make them checkout relative when nested.
        path = record["path"]
        return path[len(prefix):] if prefix and path.startswith(prefix) else path

    def untracked(records: List[Dict[str, str]]) -> List[Dict[str, str]]:
        return [record for record in records if record["code"] == "??"]

    selected_untracked = untracked(selected)
    selected_tracked_changes = [record for record in selected if record["code"] != "??"]
    selected_paths_listed = sorted({relative(record) for record in selected})
    repository_untracked = untracked(repository)
    return {
        "path": str(root),
        "topLevel": git_output(root, ["rev-parse", "--show-toplevel"]).strip(),
        "wptRootIsRepositoryRoot": prefix == "",
        "repositoryRootRelativePrefix": prefix,
        "revision": revision,
        "committerDate": git_output(root, ["log", "-1", "--format=%cI"]).strip(),
        # Whole-repository facts. When the WPT tests root is nested these cover files outside the
        # tests root as well, so they must not be read as statements about the selection.
        "repositoryDirty": bool(repository),
        "repositoryChangedTrackedFileCount": len(repository) - len(repository_untracked),
        "repositoryUntrackedFileCount": len(repository_untracked),
        # Selected-path facts. These are what the inventory depends on.
        "selectedPathsDirty": bool(selected),
        "selectedChangedTrackedFileCount": len(selected_tracked_changes),
        "selectedUntrackedFileCount": len(selected_untracked),
        "selectedDirtyFileCount": len(selected),
        "selectedDirtyFiles": selected_paths_listed[:DIRTY_LIST_LIMIT],
        "selectedDirtyFilesTruncated": len(selected_paths_listed) > DIRTY_LIST_LIMIT,
        "revisionIdentifiesSelectedSources": not selected,
        "note": "repository* fields describe the whole repository containing the checkout and "
                "selected* fields describe only the selected paths; neither implies the other.",
    }
