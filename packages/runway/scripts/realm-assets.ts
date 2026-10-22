// Builds what the harness page needs for realm mode (RUNWAY_REALM=1), the same way Stellite's
// real-engine run builds it (Stellite/scripts/realm-engine/run.ts): Ferrochrome's page boundary,
// bundled with its parser packages resolved to Stellite's browser owner and a silent logger, and
// the packages the SDK's chunks import by name, which the harness page maps with an import map.
//
//   bun scripts/realm-assets.ts <out dir>
//
// It reads ST_FERROCHROME_ROOT (a root with v8-wasm-web and packages/ferrochrome-runtime),
// STELLITE_DIR (the Stellite checkout, for its URL owner) and STELLITE_SDK_DIR (a built SDK).
// It runs under Bun because the bundling is Bun's, and the runner calls it before it starts.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const out = process.argv[2];
const ferrochromeRoot = process.env.ST_FERROCHROME_ROOT;
const stellite = process.env.STELLITE_DIR;
const sdk = process.env.STELLITE_SDK_DIR;
if (!out || !ferrochromeRoot || !stellite || !sdk) {
	console.error(
		"Realm mode needs ST_FERROCHROME_ROOT, STELLITE_DIR and STELLITE_SDK_DIR, and an output directory"
	);
	process.exit(2);
}

const boundaryPath = join(
	resolve(ferrochromeRoot),
	"packages/ferrochrome-runtime/src/embedder/v8_wasm_page_host_boundary.ts"
);
const needed: Array<[string, string]> = [
	["the engine stage", join(resolve(ferrochromeRoot), "v8-wasm-web/manifest.json")],
	["the page boundary", boundaryPath],
	["the SDK build", join(resolve(sdk), "dist/userscripts/index.js")],
	["Stellite's URL owner", join(resolve(stellite), "src/client/v8-wasm-url-owner.ts")],
];
for (const [label, path] of needed) {
	if (!existsSync(path)) {
		console.error(`Missing ${label}: ${path}`);
		process.exit(2);
	}
}

const built = await Bun.build({
	entrypoints: [boundaryPath],
	target: "browser",
	format: "esm",
	plugins: [
		{
			name: "boundary",
			setup(build) {
				const owner = join(resolve(stellite), "src/client/v8-wasm-url-owner.ts");
				build.onLoad({ filter: /ferrochrome-parsers\/src\/(url|origin)\.ts$/ }, (args) => ({
					loader: "ts",
					contents: /\/url\.ts$/.test(args.path)
						? `export * from ${JSON.stringify(owner)};`
						: `export { Origin, chromiumOriginConstructionKey } from ${JSON.stringify(owner)};`,
				}));
				build.onResolve({ filter: /^tslog$/ }, () => ({ path: "tslog", namespace: "silent" }));
				build.onLoad({ filter: /.*/, namespace: "silent" }, () => ({
					loader: "js",
					contents:
						"export class Logger { constructor(s = {}) { this.settings = s } getSubLogger(s = {}) { return new Logger({ ...this.settings, ...s }) } silly() {} trace() {} debug() {} info() {} warn() {} error() {} fatal() {} log() {} }",
				}));
			},
		},
	],
});
if (!built.success) {
	console.error(built.logs);
	process.exit(2);
}

mkdirSync(join(out, "vendor"), { recursive: true });
writeFileSync(join(out, "boundary.js"), await built.outputs[0]!.text());

const vendor: Record<string, string> = {
	module: "export default {}; export const createRequire = () => () => ({});",
	tfs: "export default {};",
};
for (const name of ["comlink", "ultrahtml", "valibot", "ajv"]) {
	const result = await Bun.build({
		entrypoints: [Bun.resolveSync(name, resolve(sdk))],
		target: "browser",
		format: "esm",
	});
	if (!result.success) {
		console.error(`Could not bundle ${name} for the SDK`, result.logs);
		process.exit(2);
	}
	vendor[name] = await result.outputs[0]!.text();
}
for (const [name, text] of Object.entries(vendor)) {
	writeFileSync(join(out, "vendor", `${name}.js`), text);
}
console.log(`    Realm assets written to ${out}`);
