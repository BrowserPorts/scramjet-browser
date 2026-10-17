# Consumer plugins and tests

Runway keeps browser plugins and test declarations separate. A plugin profile
installs consumer-owned Scramjet plugins in the candidate lane. A test directory
supplies assertions through the public `runway/testkit` API. Neither requires
editing this repository or adding code to the installed Runway package.

## Define your own tests

Create `tests/example.mjs` in your project:

```js
import { scriptTest } from "runway/testkit";

export default scriptTest({
  name: "my-plugin-page-contract",
  candidateOnly: true,
  js: `assertEqual(document.title, "", "fresh document title");`,
});
```

Export one test or an array. Available factories include `scriptTest`,
`documentTest`, `originTest`, `fixtureTest`, `pageTest`, `nodeTest`, and
`frameTreeTest`. Use candidate-only tests for plugin-specific APIs; omit
`candidateOnly` to compare ordinary web behavior against the bare browser.

```sh
runway list --test-root ./tests
runway run --test-root ./tests --plugin-manifest ./plugin.json \
  --browser-executable /path/to/browser --output-dir ./results
runway compare ./results/<run-id>
```

`--test-root` replaces the builtin native test directory; it does not add your
tests to every builtin regression. It works with `run`, `list`, `preflight`, and
`inspect`. The directory is resolved against the caller's working directory and
recorded in the immutable plan. ESM `.js`/`.mjs` and directly runnable `.ts`/`.mts`
modules are discovered recursively. For TypeScript, use Node >=22.18 with type
stripping enabled. On supported older Node 22 versions, invoke the installed CLI
with `NODE_OPTIONS=--experimental-strip-types runway ...`, or compile to ESM
JavaScript. Compile non-erasable TypeScript first.
Declaration files, dependency trees, and vendored fixtures are not imported.
Duplicate test names, failed imports, links outside the root, and empty suites
are errors. Test modules execute in Node during discovery: use trusted test code,
not untrusted website scripts. Keep compiled output separate from source to avoid
declaring the same test twice.

The plan records module hashes and the exact test inventory. These hashes cover
entry modules, not their complete dependency graph. Offline comparison uses the
saved inventory and never imports your test modules again.

## Load a browser plugin

See `examples/plugins/forward.json` and `forward.mjs` for a complete forwarding
plugin. Paths in the manifest resolve relative to that manifest:

```json
{
  "name": "my-plugin",
  "plugins": [{ "entry": "./dist/plugin.mjs", "options": {} }],
  "assets": [{ "name": "runtime", "directory": "./dist/assets" }]
}
```

The default factory receives `scramjet`, `controller`, `options`, and `assets`.
Return `plugins` (managed plugin instances), and optionally `configure(init)`,
`report()`, and `verify({testURL})`. Types are exported by `runway/plugin-api`.
Use the supplied controller classes rather than bundling duplicate copies.
Managed plugins can use the existing frame initialization, fetch, and rewriting
hooks. Runway does not supply a guest runtime implementation.

`verify()` runs for navigations and failures fail the attempt, but a plugin's
self-report is not independent proof. Put behavioral assertions in your tests.
The bare lane never installs the candidate plugin. Missing files and plugin
initialization failures are errors, never a fallback to an unmodified candidate.

The profile may optionally supply a static `serviceWorker: {entry, type}` to
replace the harness's **host proxy worker**. This is a deployment hook, not a
guest API implementation. The replacement must implement the controller protocol.

## Select upstream WPT cases

The WPT adapter is independent of custom native test modules. Consumers select
their own upstream paths using `scripts/generate-wpt.py` and run them under the
same plugin profile:

```sh
python scripts/generate-wpt.py /path/to/wpt ./manifest.json --path url --suite url
runway run --suite wpt --wpt-manifest ./manifest.json \
  --wpt-root /path/to/wpt --wpt-server-config ./wpt.config.json \
  --plugin-manifest ./plugin.json --browser-executable /path/to/browser
```

Provide your own wptserve configuration, or adapt `scripts/wpt.config.json`.
See `scripts/WPT_INVENTORY.md` for inventory provenance and selection validation.
