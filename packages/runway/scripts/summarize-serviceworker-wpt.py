"""Summarize Runway's raw WPT outcomes without changing expected results.

Recorded statuses are reported verbatim. Nothing is reclassified as a pass:
missing results, manual cases the runner never executes, unreadable or unknown
artifacts, invalid records and duplicates are counted and listed instead of
being dropped from the inventory.

Two separate views are reported and never mixed:

* raw outcomes repeat exactly what a result file recorded, and
* validated outcomes additionally require the recorded metadata that ties a result
  to the supplied inventory: the WPT fixture revision, a matching case type and an
  explicit plugin verification array when a profile was applied.

A record that lacks that metadata is reported as unverified, never as a pass.
Results are grouped by plugin profile identity (name plus configuration digest),
so distinct configurations are never merged into one aggregate.

Scope of "validated" in this report:

* It is a metadata self-consistency check over recorded result files. It is not
  proof that a plugin, engine or source port produced any observed behavior, and
  it is not a conformance or parity claim.
* Plugin verification entries are the profile's own `verify()` self-report as the
  runner recorded it. Their presence records that the hook ran, not who
  implemented the behavior under test.
* The manifest revision identifies the upstream WPT fixture checkout only. It is
  independent of the browser build recorded per result and of any engine or
  source-port reference, which this script reports separately and never merges
  into the fixture revision.
* The `bare` and `scramjet` harness labels are two page paths exercised by the one
  Playwright-managed pinned Chromium that recorded the results. They are not two
  browsers, builds or runners.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument("directory", help="Directory of raw Runway WPT results")
parser.add_argument("output", help="Summary JSON destination")
parser.add_argument("--manifest",
                    help="Runway inventory manifest for full expected-case accounting")
parser.add_argument("--strict", action="store_true",
                    help="Exit 1 when the inventory report records any warning")
args = parser.parse_args()

SUBTEST_LABELS = {0: "passedSubtests", 1: "failedSubtests", 2: "timedOutSubtests",
                  3: "notRunSubtests", 4: "preconditionFailures"}
# `applied` records which harness the profile was installed in, so it is the only
# recorded profile field excluded from a configuration identity. Every other field
# the producer writes (name, plugin URLs, entry SHA-256 values, options, asset
# mounts, host service worker) participates.
HARNESS_SPECIFIC_PROFILE_FIELDS = ("applied",)
UNRECORDED_PROFILE = "(unrecorded)"
# Producer contract, from src/plugin-profile.ts: a profile name uses letters, numbers,
# hyphens or underscores, every plugin carries a URL plus a SHA-256 entry digest and an
# options object, assets are a name to URL map, an optional host service worker is
# classic or module, only the default profile is named "builtin" and it configures
# nothing, and any other profile must configure a plugin or a host service worker.
# src/tests/wpt/serviceworker-{upstream,special}.ts add `applied: harness === "scramjet"`.
PROFILE_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]*$", re.IGNORECASE)
SHA256 = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)
# testharness.js statuses: harness OK/ERROR/TIMEOUT/PRECONDITION_FAILED and subtest
# PASS/FAIL/TIMEOUT/NOTRUN/PRECONDITION_FAILED. Anything else is not a recorded status.
HARNESS_STATUSES = frozenset((0, 1, 2, 3))
SUBTEST_STATUSES = frozenset((0, 1, 2, 3, 4))
warnings = []
directory = Path(args.directory)
if not directory.is_dir():
    parser.error(f"{directory} is not a readable directory")


def warn(message):
    warnings.append(message)


def case_key(url):
    """Manifest-comparable path of a recorded result URL, or None if unparsable."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    return parts.path + (f"?{parts.query}" if parts.query else "")


def recorded_int(value, allowed):
    """True for a real recorded status integer. `bool` is rejected: True == 1 in Python."""
    return type(value) is int and value in allowed


def validate_profile(profile):
    """Check a recorded pluginProfile against the producer schema.

    Returns ("malformed", reason) for anything the producer could not have written,
    ("builtin", None) for the well-formed default profile that configures nothing, or
    ("configured", None) for a well-formed profile that configures plugins or a host
    service worker. A profile that merely omits its configuration is malformed, never
    a well-formed empty profile.
    """
    if not isinstance(profile, dict):
        return "malformed", "pluginProfile is not an object"
    name = profile.get("name")
    if not isinstance(name, str) or not PROFILE_NAME.match(name):
        return "malformed", f"pluginProfile name {name!r} is not a producer-issued profile name"
    if type(profile.get("applied")) is not bool:
        return "malformed", ("pluginProfile has no boolean applied flag, so the harness it was "
                            "installed in cannot be determined")
    plugins = profile.get("plugins")
    if not isinstance(plugins, list):
        return "malformed", "pluginProfile has no plugins array"
    for index, plugin in enumerate(plugins):
        if not isinstance(plugin, dict):
            return "malformed", f"pluginProfile plugin {index} is not an object"
        if not isinstance(plugin.get("url"), str) or not plugin["url"]:
            return "malformed", f"pluginProfile plugin {index} has no url"
        if not isinstance(plugin.get("sha256"), str) or not SHA256.match(plugin["sha256"]):
            return "malformed", f"pluginProfile plugin {index} has no SHA-256 entry digest"
        if not isinstance(plugin.get("options"), dict):
            return "malformed", f"pluginProfile plugin {index} has no options object"
    assets = profile.get("assets")
    if not isinstance(assets, dict) or not all(isinstance(value, str) for value in assets.values()):
        return "malformed", "pluginProfile has no assets URL map"
    worker = profile.get("serviceWorker")
    if worker is not None:
        if not isinstance(worker, dict):
            return "malformed", "pluginProfile serviceWorker is not an object"
        if not isinstance(worker.get("url"), str) or not worker["url"]:
            return "malformed", "pluginProfile serviceWorker has no url"
        if not isinstance(worker.get("sha256"), str) or not SHA256.match(worker["sha256"]):
            return "malformed", "pluginProfile serviceWorker has no SHA-256 entry digest"
        if worker.get("type") not in ("classic", "module"):
            return "malformed", "pluginProfile serviceWorker type is neither classic nor module"
    configured = bool(plugins) or worker is not None
    if name == "builtin":
        if configured:
            return "malformed", ("the builtin profile cannot configure plugins or a host service "
                                "worker, so this record contradicts the producer")
        return "builtin", None
    if not configured:
        return "malformed", (f"profile {name!r} configures no plugin and no host service worker, "
                             "which the producer rejects")
    return "configured", None


def classify(document):
    """Identify a recorded artifact by its own schema, never by file location."""
    if not isinstance(document, dict):
        return "unknown", f"top-level JSON is {type(document).__name__}, not an object"
    if "harness" in document:
        status, tests = document.get("status"), document.get("tests")
        if not isinstance(document.get("harness"), str):
            return "invalid", "result record has no harness label string"
        if not isinstance(document.get("url"), str):
            return "invalid", "result record has no url string"
        if case_key(document["url"]) is None:
            return "invalid", f"result record has an unparsable url {document['url']!r}"
        if "revision" in document and not isinstance(document["revision"], str):
            return "invalid", "result record has a non-string revision"
        if "pluginProfile" in document:
            state, reason = validate_profile(document["pluginProfile"])
            if state == "malformed":
                return "invalid", reason
        if ("pluginVerificationFailures" in document
                and not isinstance(document["pluginVerificationFailures"], list)):
            return "invalid", ("result record has a malformed pluginVerificationFailures field; "
                               "plugin verification evidence must be an array")
        if isinstance(status, dict) and isinstance(tests, list):
            if not recorded_int(status.get("status"), HARNESS_STATUSES):
                return "invalid", (f"testharness record has no recorded harness status "
                                   f"(got {status.get('status')!r})")
            for test in tests:
                if not isinstance(test, dict) or not isinstance(test.get("name"), str):
                    return "invalid", "testharness record has malformed subtest entries"
                if not recorded_int(test.get("status"), SUBTEST_STATUSES):
                    return "invalid", (f"testharness subtest {test['name']!r} has no recorded "
                                       f"status (got {test.get('status')!r})")
            return "testharness", None
        if isinstance(status, str):
            if not isinstance(document.get("type"), str):
                return "invalid", "special record has no case type string"
            return "special", None
        return "invalid", "result record matches neither the testharness nor the special schema"
    if isinstance(document.get("totals"), dict) and isinstance(document.get("cases"), list):
        return "summary", None
    if isinstance(document.get("tests"), list) and ("counts" in document or "otherCases" in document):
        return "manifest", None
    if isinstance(document.get("plugins"), list):
        return "pluginProfile", None
    return "unknown", "no recognized Runway result, manifest, summary or profile schema"


def profile_fingerprint(document):
    """Recorded profile name and a digest of its harness-independent configuration."""
    profile = document.get("pluginProfile")
    if not isinstance(profile, dict):
        return None, None, None
    canonical = {key: value for key, value in profile.items()
                 if key not in HARNESS_SPECIFIC_PROFILE_FIELDS}
    digest = hashlib.sha256(
        json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:12]
    name = profile.get("name")
    name = name if isinstance(name, str) and name else "(unnamed)"
    return name, digest, canonical


def profile_application(document):
    """How a well-formed recorded profile applies to this record's own harness.

    The producer installs a profile only in the scramjet harness and records
    `applied: harness === "scramjet"`, so any other combination is a contradiction
    that cannot be resolved from the recorded data.
    """
    if "pluginProfile" not in document:
        return "absent", None
    profile = document["pluginProfile"]
    state, reason = validate_profile(profile)
    if state == "malformed":
        return "malformed", reason
    expected = document["harness"] == "scramjet"
    if profile["applied"] is not expected:
        return "contradictory", (f"the profile records applied={profile['applied']} for the "
                                 f"{document['harness']} harness, which the producer never writes")
    if state == "builtin":
        return "builtin", None
    return "applied" if profile["applied"] else "notApplied", None


def requires_plugin_evidence(document):
    """True when this record's harness actually had a configured profile installed."""
    return profile_application(document)[0] == "applied"


def verification_state(document):
    """Whether plugin verification evidence exists, is missing, or is not required."""
    application = profile_application(document)[0]
    if application == "absent":
        return "legacyAbsent"
    if application in ("malformed", "contradictory"):
        return application
    if application in ("builtin", "notApplied"):
        return "notApplicable"
    if "pluginVerificationFailures" not in document:
        return "missingEvidence"
    return "failed" if document["pluginVerificationFailures"] else "verified"


scan = {"jsonFiles": 0, "testharnessResults": 0, "specialResults": 0, "artifacts": [],
        "unreadableFiles": [], "invalidResults": [], "unknownFiles": [],
        "nonJsonFiles": [], "locationMismatches": []}
records = {"testharness": [], "special": []}
for group, root in (("results", directory), ("special", directory / "special")):
    if not root.is_dir():
        continue
    for path in sorted(root.iterdir()):
        if path.is_dir():
            continue
        relative = path.relative_to(directory).as_posix()
        if path.suffix != ".json":
            scan["nonJsonFiles"].append(relative)
            continue
        scan["jsonFiles"] += 1
        try:
            document = json.loads(path.read_text())
        except (OSError, ValueError) as error:
            scan["unreadableFiles"].append(
                {"file": relative, "error": f"{type(error).__name__}: {error}"})
            warn(f"{relative} could not be read as JSON and is excluded from every count")
            continue
        kind, reason = classify(document)
        if kind in ("testharness", "special"):
            name, digest, canonical = profile_fingerprint(document)
            records[kind].append({"file": relative, "document": document, "name": name,
                                  "digest": digest, "canonical": canonical,
                                  "case": case_key(document["url"])})
            expected = "results" if kind == "testharness" else "special"
            if expected != group and not (kind == "special" and directory.name == "special"):
                scan["locationMismatches"].append({"file": relative, "schema": kind})
                warn(f"{relative} records a {kind} result outside the {expected} location")
        elif kind == "invalid":
            url = document.get("url") if isinstance(document.get("url"), str) else None
            name, digest, _ = profile_fingerprint(document)
            scan["invalidResults"].append(
                {"file": relative, "reason": reason, "harness": document.get("harness"),
                 "url": url, "case": case_key(url) if url else None,
                 "profile": name, "profileDigest": digest})
            warn(f"{relative} is quarantined as an invalid result record ({reason}); "
                 "it is not a pass and is excluded from every outcome")
        elif kind == "unknown":
            scan["unknownFiles"].append(
                {"file": relative, "reason": reason,
                 "keys": sorted(document) if isinstance(document, dict) else None})
            warn(f"{relative} has an unknown schema ({reason}); it is reported, not scored")
        else:
            scan["artifacts"].append({"file": relative, "schema": kind})
            warn(f"{relative} is a recorded {kind} artifact in the results directory, not a test result")
scan["testharnessResults"] = len(records["testharness"])
scan["specialResults"] = len(records["special"])

unscanned = []
for child in sorted(path for path in directory.iterdir() if path.is_dir() and path.name != "special"):
    count = sum(1 for _ in child.rglob("*.json"))
    relative = child.relative_to(directory).as_posix()
    unscanned.append({"path": relative, "jsonFiles": count})
    if count:
        warn(f"{count} JSON files under {relative}/ were not scanned; "
             "summarize each profile or run directory separately")

# A profile name is only a label. Group by name plus configuration digest so two runs
# that share a name but not their plugin entries, options or assets stay separate.
configurations = {}
for kind in ("testharness", "special"):
    for record in records[kind]:
        if record["name"] is not None:
            configurations.setdefault(record["name"], {})[record["digest"]] = record["canonical"]
for name, digests in sorted(configurations.items()):
    if len(digests) > 1:
        warn(f"profile name {name!r} covers {len(digests)} different recorded configurations "
             f"({', '.join(sorted(digests))}); they are reported as separate identities")
for kind in ("testharness", "special"):
    for record in records[kind]:
        if record["name"] is None:
            record["profile"] = UNRECORDED_PROFILE
        elif len(configurations[record["name"]]) > 1:
            record["profile"] = f"{record['name']}#{record['digest']}"
        else:
            record["profile"] = record["name"]
identities = {}
for kind in ("testharness", "special"):
    for record in records[kind]:
        identity = identities.setdefault(record["profile"], {
            "name": record["name"], "configurationDigest": record["digest"],
            "configuration": record["canonical"], "harnesses": {},
            "requiresPluginEvidence": {}, "application": {}})
        harness = record["document"]["harness"]
        identity["harnesses"][harness] = identity["harnesses"].get(harness, 0) + 1
        identity["requiresPluginEvidence"][harness] = requires_plugin_evidence(record["document"])
        identity["application"].setdefault(harness, Counter())[
            profile_application(record["document"])[0]] += 1
for identity in identities.values():
    identity["application"] = {harness: dict(states)
                               for harness, states in identity["application"].items()}
profiles = {key: value["harnesses"] for key, value in identities.items()}

duplicates = []
kept = {}
for kind in ("testharness", "special"):
    for record in records[kind]:
        document = record["document"]
        identity = (kind, record["profile"], document["url"], document["harness"])
        if identity in kept:
            record["duplicate"] = True
            duplicates.append({"file": record["file"], "kept": kept[identity], "schema": kind,
                               "profile": record["profile"], "url": document["url"],
                               "harness": document["harness"]})
            warn(f"{record['file']} duplicates {kept[identity]}; only {kept[identity]} is counted")
            continue
        kept[identity] = record["file"]

revisions = sorted({record["document"].get("revision") for record in
                    records["testharness"] + records["special"]
                    if isinstance(record["document"].get("revision"), str)})
if len(revisions) > 1:
    warn(f"results record {len(revisions)} different WPT fixture revisions: "
         f"{', '.join(revisions)}")
# Browser build provenance is recorded per result by the runner. It is reported and
# checked for consistency separately from the WPT fixture revision, and it never
# takes part in validation: this script does not decide browser-build policy.
browsers = {}
for kind in ("testharness", "special"):
    for record in records[kind]:
        browser = record["document"].get("browser")
        label = "(unrecorded)" if not isinstance(browser, dict) else "/".join(
            str(browser.get(field)) for field in ("name", "channel", "version"))
        browsers[label] = browsers.get(label, 0) + 1
if len([label for label in browsers if label != "(unrecorded)"]) > 1:
    warn(f"results record {len(browsers)} different browser builds "
         f"({', '.join(sorted(browsers))}); outcomes from different builds are not comparable")
for harness in sorted({record["document"]["harness"] for record in records["testharness"]}
                      - {"scramjet", "bare"}):
    warn(f"testharness results use the unexpected harness label {harness!r}; "
         "it is reported per case and in the inventory but never in totals")


def passed(result):
    """The unchanged raw pass rule: it repeats what the result file recorded."""
    return (result["status"]["status"] == 0 and bool(result["tests"])
            and not result.get("pluginVerificationFailures")
            and all(test["status"] == 0 for test in result["tests"]))


def legacy_summary(subset):
    """Raw testharness totals and cases for one profile identity."""
    results = {}
    for record in subset:
        if record.get("duplicate"):
            continue
        document = record["document"]
        results.setdefault(document["url"], {})[document["harness"]] = document
    totals = {}
    for harness in ("scramjet", "bare"):
        counts = Counter()
        for pair in results.values():
            if harness not in pair:
                continue
            result = pair[harness]
            counts["cases"] += 1
            counts["passedCases"] += passed(result)
            counts["pluginVerificationFailures"] += len(result.get("pluginVerificationFailures", []))
            counts["harnessErrors"] += result["status"]["status"] == 1
            counts["harnessTimeouts"] += result["status"]["status"] == 2
            for test in result["tests"]:
                counts[SUBTEST_LABELS.get(test["status"], f"subtestStatus{test['status']}")] += 1
        totals[harness] = dict(counts)
    cases = []
    for url, pair in sorted(results.items()):
        case = {"url": url}
        for harness, result in pair.items():
            case[harness] = {"passed": passed(result), "status": result["status"],
                             "pluginVerificationFailures": result.get("pluginVerificationFailures", []),
                             "subtests": len(result["tests"]),
                             "failures": [test for test in result["tests"] if test["status"] != 0]}
        if "bare" in pair and "scramjet" in pair:
            native_passes = {test["name"] for test in pair["bare"]["tests"] if test["status"] == 0}
            case["scramjetRegressions"] = [test for test in pair["scramjet"]["tests"]
                                          if test["name"] in native_passes and test["status"] != 0]
        cases.append(case)
    return {"totals": totals, "cases": cases}


# Comparing harnesses only makes sense inside one profile configuration, so the
# aggregate is emitted only when the scanned directory holds a single identity.
testharness_profiles = sorted({record["profile"] for record in records["testharness"]})
summary = {"totals": {}, "cases": []}
if len(testharness_profiles) <= 1:
    profile = testharness_profiles[0] if testharness_profiles else None
    summary.update(legacy_summary(records["testharness"]))
    aggregate = {"available": True, "profile": profile,
                 "note": "totals and cases cover one profile identity; harness comparisons and "
                         "scramjetRegressions never cross identities"}
else:
    aggregate = {"available": False, "profiles": testharness_profiles,
                 "reason": "the scanned directory holds results from more than one profile "
                           "identity, so a merged aggregate would compare unlike configurations; "
                           "see byProfile for per-identity totals and cases"}
    warn(f"totals and cases are unavailable: the scanned directory mixes {len(testharness_profiles)} "
         f"profile identities ({', '.join(testharness_profiles)}); per-identity output is in byProfile")
    summary["byProfile"] = {
        profile: legacy_summary([record for record in records["testharness"]
                                 if record["profile"] == profile])
        for profile in testharness_profiles}
summary["legacyAggregate"] = aggregate


def special_passed(document):
    """The raw special pass rule: recorded "pass" with no recorded verification failure."""
    return document["status"] == "pass" and not document.get("pluginVerificationFailures")


special_by_profile = {}
for record in records["special"]:
    if record.get("duplicate"):
        continue
    document = record["document"]
    if document["status"] not in ("pass", "fail"):
        warn(f"{record['file']} records the unrecognized special status "
             f"{document['status']!r}; it is not counted as a pass")
    special_by_profile.setdefault(record["profile"], {}).setdefault(
        record["case"], {})[document["harness"]] = record
summary["special"] = {"byProfile": {}}
for profile, cases in sorted(special_by_profile.items()):
    totals = {}
    for harness in sorted({harness for case in cases.values() for harness in case}):
        counts = Counter()
        statuses, types, verification = Counter(), Counter(), Counter()
        for case in cases.values():
            record = case.get(harness)
            if record is None:
                continue
            document = record["document"]
            counts["cases"] += 1
            counts["passedCases"] += special_passed(document)
            counts["pluginVerificationFailures"] += len(
                document.get("pluginVerificationFailures", []))
            statuses[document["status"]] += 1
            types[document["type"]] += 1
            verification[verification_state(document)] += 1
        totals[harness] = dict(counts) | {"byRecordedStatus": dict(statuses),
                                          "byType": dict(types),
                                          "byPluginVerification": dict(verification)}
    entries = []
    for key, case in sorted(cases.items()):
        entry = {"case": key,
                 "types": sorted({record["document"]["type"] for record in case.values()})}
        if len(entry["types"]) > 1:
            warn(f"{key} is recorded with conflicting case types: {', '.join(entry['types'])}")
        for harness, record in sorted(case.items()):
            document = record["document"]
            entry[harness] = {"passed": special_passed(document), "status": document["status"],
                              "failure": document.get("failure"),
                              "pluginVerificationFailures":
                                  document.get("pluginVerificationFailures", []),
                              "pluginVerification": verification_state(document),
                              "url": document["url"]}
        entries.append(entry)
    summary["special"]["byProfile"][profile] = {"totals": totals, "cases": entries}

accounting = {"available": False,
              "reason": "no --manifest was supplied, so expected-case accounting is unavailable",
              "recordedResultsOnly": {"testharness": scan["testharnessResults"],
                                      "special": scan["specialResults"]}}
if args.manifest:
    manifest_path = Path(args.manifest)
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError) as error:
        parser.error(f"--manifest {manifest_path} is not readable JSON: "
                     f"{type(error).__name__}: {error}")
    schema, reason = classify(manifest)
    if not isinstance(manifest, dict) or not isinstance(manifest.get("tests"), list):
        parser.error(f"--manifest {manifest_path} records no tests list; its schema reads as "
                     f"{schema} ({reason or 'unexpected shape'})")
    metadata_warnings = []
    for field, description in (("suite", "suite label"), ("paths", "upstream path selection"),
                               ("revision", "WPT fixture revision")):
        if not manifest.get(field):
            metadata_warnings.append(
                f"the manifest records no {description}; it predates that metadata and cannot be "
                "matched to a suite or upstream selection")
    if manifest.get("otherCases") is None:
        metadata_warnings.append("the manifest records no otherCases inventory, so crashtest, "
                                 "reftest and manual cases cannot be accounted")
    for message in metadata_warnings:
        warn(f"--manifest {manifest_path}: {message}")

    expected_tests, expected_other, malformed_entries, manifest_duplicates = {}, {}, [], []
    for entry in manifest["tests"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("url"), str):
            malformed_entries.append({"section": "tests", "entry": repr(entry)[:200]})
            continue
        key = case_key(entry["url"])
        if key is None:
            malformed_entries.append({"section": "tests", "entry": repr(entry["url"])[:200],
                                      "reason": "unparsable url"})
            continue
        if key in expected_tests:
            manifest_duplicates.append({"section": "tests", "case": key})
        expected_tests[key] = entry["url"]
    for entry in manifest.get("otherCases") or []:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            malformed_entries.append({"section": "otherCases", "entry": repr(entry)[:200]})
            continue
        key = "/" + entry["path"].lstrip("/")
        if key in expected_other:
            manifest_duplicates.append({"section": "otherCases", "case": key})
        expected_other[key] = entry.get("type") if isinstance(entry.get("type"), str) else "(untyped)"
    for message in malformed_entries:
        warn(f"--manifest {manifest_path} has a malformed {message['section']} entry: "
             f"{message['entry']}")
    for message in manifest_duplicates:
        warn(f"--manifest {manifest_path} lists {message['case']} more than once in "
             f"{message['section']}; it is accounted once")

    indexed, collisions, ambiguous = {}, [], {}
    for entry in duplicates:
        ambiguous.setdefault((entry["schema"], entry["profile"], entry["harness"],
                              case_key(entry["url"])), []).extend([entry["kept"], entry["file"]])
    for kind in ("testharness", "special"):
        for record in records[kind]:
            if record.get("duplicate"):
                continue
            identity = (kind, record["profile"], record["document"]["harness"], record["case"])
            if identity in indexed:
                collisions.append({"file": record["file"], "kept": indexed[identity]["file"],
                                   "case": identity[3],
                                   "harness": record["document"]["harness"]})
                ambiguous.setdefault(identity, []).extend(
                    [indexed[identity]["file"], record["file"]])
                warn(f"{record['file']} and {indexed[identity]['file']} map to the same manifest "
                     f"case {identity[3]}; neither is accounted as an outcome")
                continue
            indexed[identity] = record
    invalid_index = {}
    for entry in scan["invalidResults"]:
        if entry["case"] and isinstance(entry["harness"], str):
            invalid_index.setdefault(
                (entry["profile"] or UNRECORDED_PROFILE, entry["harness"], entry["case"]),
                []).append(entry["file"])

    manual = {key for key, type_ in expected_other.items() if type_ == "manual"}
    executable_other = {key: type_ for key, type_ in expected_other.items() if type_ != "manual"}
    manifest_revision = manifest.get("revision")
    # Without a usable manifest revision nothing can be validated against this inventory.
    revision_verifiable = isinstance(manifest_revision, str) and bool(manifest_revision.strip())
    if not revision_verifiable:
        warn(f"--manifest {manifest_path} records no usable WPT fixture revision "
             f"({manifest_revision!r}), so no recorded result can be attributed to a fixture "
             "checkout; raw outcomes are retained and every validated pass is withheld")
    profile_keys = sorted(profiles) or [UNRECORDED_PROFILE]
    by_profile = {}
    for profile in profile_keys:
        by_harness = {}
        for harness in sorted(set(profiles.get(profile, {})) | {"scramjet", "bare"}):
            raw_outcomes, outcomes = Counter(), Counter()
            missing = {"testharness": [], "special": [], "manual": []}
            invalid_cases, unexpected, unresolved = [], [], []
            stale, unverified, type_mismatches = [], [], []
            unverifiable, contradictory = [], []

            def raw_outcome(kind, document, is_manual):
                """What the record itself says, with no manifest evidence requirement."""
                if kind == "special":
                    if is_manual:
                        return "manualExecuted"
                    if document.get("pluginVerificationFailures"):
                        return "pluginVerificationFailure"
                    if document["status"] == "pass":
                        return "passed"
                    return "failed" if document["status"] == "fail" else "unrecognizedStatus"
                if document.get("pluginVerificationFailures"):
                    return "pluginVerificationFailure"
                status = document["status"]["status"]
                if status == 1:
                    return "harnessError"
                if status == 2:
                    return "harnessTimeout"
                if status != 0:
                    return f"harnessStatus{status}"
                if not document["tests"]:
                    return "noSubtestsReported"
                if any(test["status"] != 0 for test in document["tests"]):
                    return "failedSubtests"
                return "passed"

            def account(kind, key, expected_type=None):
                is_manual = expected_type == "manual"
                files = ambiguous.get((kind, profile, harness, key))
                if files:
                    unresolved.append({"case": key, "files": sorted(set(files))})
                    return "duplicateRecords", "duplicateRecords"
                record = indexed.get((kind, profile, harness, key))
                if record is None:
                    quarantined = invalid_index.get((profile, harness, key))
                    if quarantined:
                        invalid_cases.append({"case": key, "files": quarantined})
                        return "invalidResult", "invalidResult"
                    missing["manual" if is_manual else kind].append(key)
                    label = "manualNotExecuted" if is_manual else "missingResult"
                    return label, label
                document = record["document"]
                raw = raw_outcome(kind, document, is_manual)
                # The metadata checks below decide whether the raw outcome can be attributed
                # to this inventory entry and profile. They never turn a non-pass into a pass,
                # and they say nothing about which implementation produced the behavior.
                recorded_revision = document.get("revision")
                if not revision_verifiable:
                    unverifiable.append({"case": key, "file": record["file"], "rawOutcome": raw,
                                         "recorded": recorded_revision})
                    return raw, "unverifiedManifestRevision"
                if recorded_revision != manifest_revision:
                    label = "missingRevision" if not recorded_revision else "revisionMismatch"
                    stale.append({"case": key, "recorded": recorded_revision, "file": record["file"],
                                  "rawOutcome": raw, "label": label})
                    return raw, label
                if kind == "special" and expected_type not in (None, "(untyped)") \
                        and document["type"] != expected_type:
                    type_mismatches.append({"case": key, "recorded": document["type"],
                                            "manifest": expected_type, "file": record["file"],
                                            "rawOutcome": raw})
                    return raw, "typeMismatch"
                state = verification_state(document)
                if state == "contradictory":
                    contradictory.append({"case": key, "file": record["file"], "rawOutcome": raw,
                                          "reason": profile_application(document)[1]})
                    return raw, "contradictoryProfileApplication"
                if state == "missingEvidence":
                    # An applied profile without an explicit verification array cannot certify a
                    # pass. A recorded failure stays a failure: it is a non-pass either way.
                    unverified.append({"case": key, "file": record["file"], "rawOutcome": raw,
                                       "demotedFromPass": raw == "passed"})
                    if raw == "passed":
                        return raw, "unverifiedPluginEvidence"
                return raw, raw

            for key in sorted(expected_tests):
                raw, validated = account("testharness", key)
                raw_outcomes[raw] += 1
                outcomes[validated] += 1
            for key, type_ in sorted(executable_other.items()):
                raw, validated = account("special", key, type_)
                raw_outcomes[raw] += 1
                outcomes[validated] += 1
            for key in sorted(manual):
                raw, validated = account("special", key, "manual")
                raw_outcomes[raw] += 1
                outcomes[validated] += 1
            for (kind, record_profile, record_harness, key), record in sorted(
                    indexed.items(), key=lambda item: (item[0][0], item[0][3])):
                if record_profile != profile or record_harness != harness:
                    continue
                inventory = expected_tests if kind == "testharness" else expected_other
                if key not in inventory:
                    unexpected.append({"case": key, "schema": kind, "file": record["file"]})
            total = len(expected_tests) + len(expected_other)
            for label, partition in (("validated", outcomes), ("raw", raw_outcomes)):
                if sum(partition.values()) != total:
                    warn(f"the {label} accounting for {profile}/{harness} covered "
                         f"{sum(partition.values())} of {total} inventory cases; "
                         "the outcome partition is incomplete")
            if unexpected:
                warn(f"{len(unexpected)} recorded {profile}/{harness} results are absent from the "
                     "manifest inventory")
            if raw_outcomes["manualExecuted"]:
                warn(f"{raw_outcomes['manualExecuted']} manual {profile}/{harness} cases have "
                     "recorded results even though the runner excludes manual cases; "
                     "they are not passes")
            if stale:
                warn(f"{len(stale)} recorded {profile}/{harness} results cannot be attributed to "
                     f"WPT fixture revision {manifest_revision}; their raw outcomes are retained "
                     "but none of them counts as a validated pass")
            if type_mismatches:
                warn(f"{len(type_mismatches)} recorded {profile}/{harness} special results disagree "
                     "with the manifest case type; they are not validated passes")
            if unverified:
                demoted = sum(1 for entry in unverified if entry["demotedFromPass"])
                warn(f"{len(unverified)} recorded {profile}/{harness} results applied a plugin "
                     "profile without recording a pluginVerificationFailures self-report; "
                     f"{demoted} of them recorded a raw pass that cannot be validated")
            if unresolved:
                warn(f"{len(unresolved)} {profile}/{harness} cases have conflicting duplicate "
                     "records; they are accounted as unresolved, never as passes")
            if contradictory:
                warn(f"{len(contradictory)} recorded {profile}/{harness} results contradict the "
                     "producer about which harness the profile was installed in; they are not "
                     "validated passes")
            if unverifiable:
                warn(f"{len(unverifiable)} recorded {profile}/{harness} results cannot be validated "
                     "because the manifest records no usable revision; their raw outcomes are "
                     "retained")
            by_harness[harness] = {
                "fullInventoryCases": total,
                "validated": {"passedCases": outcomes["passed"],
                              "notPassedCases": total - outcomes["passed"],
                              "accountedCases": sum(outcomes.values()),
                              "outcomes": dict(sorted(outcomes.items()))},
                "raw": {"passedCases": raw_outcomes["passed"],
                        "notPassedCases": total - raw_outcomes["passed"],
                        "accountedCases": sum(raw_outcomes.values()),
                        "outcomes": dict(sorted(raw_outcomes.items())),
                        "note": "raw repeats the recorded outcome without requiring the WPT fixture "
                                "revision, case type or plugin verification self-report"},
                "requiresPluginEvidence":
                    identities.get(profile, {}).get("requiresPluginEvidence", {}).get(harness, False),
                "testharness": {"expected": len(expected_tests),
                                "recorded": sum(1 for key in expected_tests
                                                if ("testharness", profile, harness, key) in indexed),
                                "missing": missing["testharness"]},
                "special": {"expectedExecutable": len(executable_other),
                            "recorded": sum(1 for key in executable_other
                                            if ("special", profile, harness, key) in indexed),
                            "missing": missing["special"]},
                "manual": {"inventory": len(manual), "cases": sorted(manual),
                           "notExecuted": missing["manual"],
                           "note": "the runner never executes manual cases; they remain in the "
                                   "inventory denominator and are not passes"},
                "invalidResults": invalid_cases,
                "unresolvedDuplicates": unresolved,
                "unexpectedResults": unexpected,
                "revisionUnverified": stale,
                "manifestRevisionUnverifiable": unverifiable,
                "contradictoryProfileApplication": contradictory,
                "typeMismatches": type_mismatches,
                "unverifiedPluginEvidence": unverified,
                "unverifiedRawPasses": sum(1 for entry in unverified if entry["demotedFromPass"]),
            }
        by_profile[profile] = by_harness
    accounting = {
        "available": True,
        "manifest": str(manifest_path),
        "revision": manifest_revision,
        "suite": manifest.get("suite"),
        "paths": manifest.get("paths"),
        "metadataComplete": not metadata_warnings,
        "metadataWarnings": metadata_warnings,
        "revisionVerifiable": revision_verifiable,
        "scope": ("validated means the recorded metadata ties a result to this WPT fixture "
                  "inventory and profile; it is not proof that a plugin, engine or source port "
                  "produced the behavior, and it is not a conformance or parity claim"),
        "expected": {"testharness": len(expected_tests),
                     "otherCases": dict(sorted(Counter(expected_other.values()).items())),
                     "manualExcludedFromExecution": len(manual),
                     "fullInventoryCases": len(expected_tests) + len(expected_other),
                     "declaredCounts": manifest.get("counts")},
        "malformedManifestEntries": malformed_entries,
        "duplicateManifestEntries": manifest_duplicates,
        "caseKeyCollisions": collisions,
        "byProfile": by_profile,
    }

summary["inventory"] = {"directory": str(directory), "scanned": scan,
                        "unscannedDirectories": unscanned, "duplicateResults": duplicates,
                        "profiles": profiles, "profileIdentities": identities,
                        "recordedFixtureRevisions": revisions, "recordedBrowsers": browsers,
                        "accounting": accounting,
                        "warnings": warnings, "warningCount": len(warnings)}
Path(args.output).write_text(json.dumps(summary, indent=2) + "\n")
digest = {"totals": summary["totals"], "legacyAggregate": aggregate,
          "special": {profile: entry["totals"]
                      for profile, entry in summary["special"]["byProfile"].items()},
          "inventory": {"profiles": profiles, "recordedFixtureRevisions": revisions,
                        "recordedBrowsers": browsers, "warningCount": len(warnings),
                        "profileConfigurations": {name: sorted(digests)
                                                  for name, digests in configurations.items()},
                        "scanned": {key: value if isinstance(value, int) else len(value)
                                    for key, value in scan.items()},
                        "unscannedDirectories": unscanned,
                        "duplicateResults": len(duplicates)}}
if accounting["available"]:
    digest["inventory"]["accounting"] = {
        "expected": accounting["expected"],
        "metadataComplete": accounting["metadataComplete"],
        "byProfile": {profile: {harness: {"fullInventoryCases": counts["fullInventoryCases"],
                                          "validated": counts["validated"],
                                          "raw": {key: value for key, value
                                                  in counts["raw"].items() if key != "note"}}
                                for harness, counts in harnesses.items()}
                      for profile, harnesses in accounting["byProfile"].items()}}
else:
    digest["inventory"]["accountingUnavailable"] = accounting["reason"]
print(json.dumps(digest, indent=2))
for message in warnings:
    print(f"warning: {message}", file=sys.stderr)
if args.strict and warnings:
    sys.exit(1)
