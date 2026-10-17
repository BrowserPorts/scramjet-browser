# WPT manifest migration: `recordedTestFlags` and `h2`

## What changed

`scripts/generate-wpt.py` records two additional things:

- **`tests[].h2`** — upstream's own `URLManifestItem.h2`, a sibling of `https` and
  `subdomain` derived from the same `_flags` set. Recorded unconditionally, so
  `false` is a recorded fact rather than an absence.
- **`provenance.inventory.recordedTestFlags`** — the list of per-test flags this
  producer recorded: `["https", "subdomain", "h2"]`.

Both are additive. Existing fields keep their meaning, shape and values, and the
manifest remains byte-deterministic apart from the documented volatile fields.

## Regeneration is REQUIRED for manifests produced before this change

There is deliberately **no fallback, no alias and no inference** for a manifest that
predates it. A manifest without `recordedTestFlags` is read as *"this producer never
looked at h2"*, which is not the same as *"no case needs h2"*.

Concretely, an old manifest behaves like this — this is the `capability-unknown`
path in `inventory.ts`, shown here on a real upstream manifest downgraded to the
old shape:

```
legacy manifest: 78 entries, 0 executable, reasons {"capability-unknown":78}
```

Every case is **retained** in the denominator with the reason `capability-unknown`.
None is dropped, and none is executed. That is the fail-closed outcome: an h2 case
is flagged `h2: true, https: false` upstream, so a reader that treated the missing
flag as `false` would plan it as an ordinary plain-HTTP case and serve it from the
wrong listener.

### To migrate

Regenerate against the same upstream checkout and selection:

```sh
python3 "$SCRIPTS/generate-wpt.py" "$WPT_ROOT" "$OUT/manifest.json" \
  --preset url
```

The generator refuses to replace a manifest recording a **different** upstream
revision, so a regeneration that is really a revision change stays a deliberate,
recorded act (`--allow-revision-change`). Copy any manifest that is evidence for a
recorded run before regenerating it.

### Why not a compatibility shim

A shim would have to guess one of two things: that the old producer would have found
no h2 cases, or that the consumer does not care. The first is false in general (the
`xhr` selection alone contains `/xhr/status.h2.window.html`), and the second is the
kind of assumption that turns into a case being served over the wrong protocol and
reported as a pass. Refusing to execute, while keeping the case counted, is the only
option that neither shrinks the denominator nor fabricates a capability.
