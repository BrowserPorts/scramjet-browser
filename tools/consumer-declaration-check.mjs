/**
 * @fileoverview
 * Compiles a throwaway external consumer against the *packed* tarballs.
 *
 * Everything else in the repo type-checks the workspace, where `node_modules`
 * has every workspace package linked and `@types/*` hoisted to the root. That
 * setup cannot see the failures this check exists for: a published declaration
 * that imports a package the tarball does not depend on, a relative specifier
 * that needs an extension a consumer's resolver demands, or an ambient
 * declaration that only resolved because the workspace happened to include it.
 *
 * So: install `@mercuryworkshop/scramjet`, `@mercuryworkshop/scramjet-controller`
 * and `@mercuryworkshop/scramjet-utils` from their tarballs into an empty
 * project, and compile a probe against them twice — once with
 * `moduleResolution: "bundler"` and once with `"nodenext"`, both `strict` and
 * both with `skipLibCheck: false`, because skipping lib checks is exactly what
 * would hide the class of bug being tested.
 *
 * The probe is not a smoke test. It asserts the public shapes that the
 * declaration packaging is allowed to change but must not:
 *
 * - `Controller.rpc` is the real `RpcHelper<Controllerbound, SWbound>` generic
 *   carried in from the build-only `@mercuryworkshop/rpc` package, not `any` and
 *   not a stub. Proven by a `@ts-expect-error` on an RPC method name the remote
 *   description does not have: against `any` that directive would itself be an
 *   error ("unused '@ts-expect-error' directive"), so a degraded type fails.
 * - `@mercuryworkshop/rpc` is not resolvable from the consumer at all, which is
 *   the dependency claim itself.
 * - `Window[SCRAMJETCLIENT]` / `Document[SCRAMJETCLIENT]` resolve to
 *   `ScramjetClient`, which only works if core's ambient `global.d.ts` ships and
 *   the entry declaration still references it.
 *
 * Diagnostics are partitioned by the file that produced them. Zero are allowed
 * from the consumer's own sources or from any of the three packages under test.
 * Diagnostics inside an unrelated third-party dependency are printed in full and
 * attributed, never suppressed and never hidden behind `skipLibCheck`: a
 * declaration defect in a dependency this repo does not publish is a different
 * finding than one in a declaration this repo emits.
 *
 * The consumer's program deliberately has no `@types/*` packages at all. That is
 * the supported shape and it is a measured result, not an assumption: these
 * packages' published declarations compile against nothing but `lib`. In
 * particular `@types/serviceworker` must *not* be in a consumer program that
 * also uses `lib: DOM` — it redeclares the DOM globals, so the combination
 * produces ~46 conflict diagnostics inside `@types/serviceworker` and
 * `lib.dom.d.ts` themselves before any of this repository's code is reached.
 * `--with-service-worker-types` reproduces that combination on demand; it is a
 * documented incompatibility of those two type sets, not a supported consumer.
 *
 * The consumer project is always left on disk and its path printed, so a failing
 * run can be inspected instead of re-derived.
 *
 * ## What a passing run does and does not claim
 *
 * The two variants are not equal in status, and the aggregate exit code reflects
 * exactly one of them:
 *
 * - `bundler` is the **required** gate. It must produce zero diagnostics, from
 *   any file. Nothing is tolerated.
 * - `nodenext` is a **known, expected failure** caused by
 *   `@mercuryworkshop/proxy-transports` (see `UPSTREAM_UNRESOLVABLE`). Its raw
 *   `tsc` exit code and full diagnostic count are recorded verbatim, and a
 *   `::warning::` is emitted so the failure stays visible in CI. It does not gate,
 *   because it is not fixable from this repository.
 *
 * So exit 0 means "the required bundler gate passed, and every `nodenext`
 * diagnostic was attributed to the documented upstream defect". It does **not**
 * mean the published packages are NodeNext-clean, and it is not a general
 * publish-quality claim. Registry NodeNext compatibility stays open until
 * `@mercuryworkshop/proxy-transports` ships extension-carrying declarations.
 *
 * The variant matrix, raw exits and per-owner counts are written to
 * `consumer-declaration-report.json` in the work directory (`--report` to place it
 * elsewhere) so the distinction survives into machine-read output.
 *
 * usage:
 *   node tools/consumer-declaration-check.mjs --tarballs <dir> [--work <dir>]
 *                                             [--report <file>]
 *                                             [--with-service-worker-types]
 *                                             [--skip-injection]
 *
 * exit codes: 0 the required gate passed and the expected failure was as
 * documented, 1 the required gate failed / an unattributed diagnostic / the
 * failure-injection self-check did not hold, 2 a setup failure (missing tarball,
 * install failure, upstream export set undeterminable).
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** The tarballs the consumer installs, by package name. */
const PACKAGES = [
	{ name: "@mercuryworkshop/scramjet", match: /^mercuryworkshop-scramjet-\d/ },
	{
		name: "@mercuryworkshop/scramjet-controller",
		match: /^mercuryworkshop-scramjet-controller-\d/,
	},
	{
		name: "@mercuryworkshop/scramjet-utils",
		match: /^mercuryworkshop-scramjet-utils-\d/,
	},
];

/**
 * The one upstream defect this check attributes instead of failing on.
 *
 * `@mercuryworkshop/proxy-transports@1.0.2` — the latest published version —
 * emits extensionless relative specifiers in its own declarations
 * (`export type * from "./types"`), which `node16`/`nodenext` resolution rejects
 * with TS2834. Because its entry declaration then fails to resolve, every type
 * it re-exports goes missing, and each package here that names one of those
 * types reports TS2305 "has no exported member" against
 * `"@mercuryworkshop/proxy-transports"`.
 *
 * Neither half is fixable from this repository: the consumer installs the
 * dependency from the registry, so a `pnpm` patch would fix the workspace and
 * not the consumer.
 *
 * The tolerance is therefore pinned to those two exact shapes, by error code,
 * and only for the `nodenext` variant:
 *
 *   TS2834 *inside* that package — its own unresolvable relative specifiers.
 *   TS2305 naming that module, **and naming a member that package really does
 *   export** — the re-exports that go missing as a result.
 *
 * That second condition is load-bearing. "TS2305 mentioning the package" on its
 * own would also tolerate a misspelled import in one of *our* declarations:
 * `import type { RawHeadersTypo } from "@mercuryworkshop/proxy-transports"` fails
 * with the same code, in the same module, and would sail straight through a
 * message-only match. So the real export set is measured first, with the
 * consumer's own `typescript` under `bundler` resolution — where the package's
 * declarations do resolve — and a TS2305 is attributed upstream only when the
 * member it names is in that set (see `upstreamExportedMembers`). If the set
 * cannot be determined the run fails as a setup error rather than tolerating
 * anything.
 *
 * Deliberately not tolerated: TS2307 "Cannot find module
 * '@mercuryworkshop/proxy-transports'". That message also names the package, but
 * it means the dependency is not installed at all, which would be a real missing
 * dependency in something this repo publishes — exactly the class of bug this
 * check exists to catch. Nor is an unresolved relative specifier of our own: it
 * is a TS2834 in *our* file, which is not inside that package and so fails.
 *
 * `--skip-injection` aside, every run ends by *proving* the above with failure
 * injection: a bogus member is added to a real import of that module inside an
 * installed package under test, and both variants must report it as blocking.
 */
const UPSTREAM_UNRESOLVABLE = "@mercuryworkshop/proxy-transports";

/** Error codes tolerated for `UPSTREAM_UNRESOLVABLE`, by where they appear. */
const UPSTREAM_TOLERATED = {
	/** The package's own declarations. */
	inside: new Set(["TS2834"]),
	/**
	 * Anywhere, when the message names the package *and* names a member the
	 * package genuinely exports.
	 */
	naming: new Set(["TS2305"]),
};

/**
 * A member name this package certainly does not export, used for the failure
 * injection at the end of the run. The injection asserts it is reported, so a
 * name that ever became real would make the check fail loudly rather than quietly
 * stop testing anything.
 */
const BOGUS_UPSTREAM_MEMBER = "ScramjetConsumerCheckDefinitelyNotExported";

const TS_VERSION = "5.9.3";

function parseArgs(argv) {
	const args = {
		tarballs: null,
		work: null,
		report: null,
		serviceWorkerTypes: false,
		injection: true,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--tarballs") args.tarballs = argv[++i];
		else if (arg === "--work") args.work = argv[++i];
		else if (arg === "--report") args.report = argv[++i];
		else if (arg === "--with-service-worker-types")
			args.serviceWorkerTypes = true;
		else if (arg === "--skip-injection") args.injection = false;
		else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
	}
	if (!args.tarballs) throw new Error("--tarballs <dir> is required");
	return args;
}

/** Resolves each required tarball inside `dir`, failing when one is missing. */
function findTarballs(dir) {
	const entries = readdirSync(dir);
	return PACKAGES.map(({ name, match }) => {
		const found = entries.filter(
			(entry) => match.test(entry) && entry.endsWith(".tgz"),
		);
		if (found.length !== 1) {
			throw new Error(
				`expected exactly one tarball for ${name} in ${dir}, found ${found.length}${found.length ? `: ${found.join(", ")}` : ""}`,
			);
		}
		return { name, path: resolve(dir, found[0]) };
	});
}

const PROBE = `/**
 * External-consumer probe. Compiled from an empty project against the packed
 * tarballs; see tools/consumer-declaration-check.mjs for what each assertion is
 * protecting.
 */

import {
	Controller,
	ManagedPlugin,
	config as controllerConfig,
	VERSION as CONTROLLER_VERSION,
	type Config as ControllerConfig,
	type ControllerInit,
	type Frame,
} from "@mercuryworkshop/scramjet-controller";
import {
	SCRAMJETCLIENT,
	SCRAMJETCLIENTNAME,
	type ScramjetClient,
	type ScramjetConfig,
} from "@mercuryworkshop/scramjet";
import {
	ManagedPlugin as UtilsManagedPlugin,
	HttpCachePlugin,
	LinkHandlerPlugin,
} from "@mercuryworkshop/scramjet-utils";

// @ts-expect-error @mercuryworkshop/rpc is a build-only workspace package: a
// consumer installs the controller without it, so this specifier must not
// resolve. If it ever becomes a real dependency this directive stops being an
// error and the check fails, which is the intent.
import type { RpcHelper as UninstalledRpcHelper } from "@mercuryworkshop/rpc";

/** \`true\` only for \`any\`; used to fail loudly on a widened public type. */
type IsAny<T> = 0 extends 1 & T ? true : false;

declare const controller: Controller;

/* Controller.rpc keeps the real generic from the build-only rpc package. */
type Rpc = Controller["rpc"];
export const rpcIsNotAny: IsAny<Rpc> extends true ? never : true = true;
export const rpcCounter: number = controller.rpc.counter;
export const rpcCallbacks: Map<number, unknown> = controller.rpc.promiseCallbacks;

/* A method the remote description does declare, with its argument type checked. */
export const sendCookies = controller.rpc.call("sendSetCookie", {
	cookies: [{ url: "https://example.com/", cookie: "a=b" }],
});

// @ts-expect-error "notAnRpcMethod" is not in the controller's remote RPC
// description. Against \`any\` this directive would be unused and therefore an
// error, so this is what proves the generic survived declaration packaging.
controller.rpc.call("notAnRpcMethod", undefined);

// @ts-expect-error the argument type of a declared method is still checked.
controller.rpc.call("sendSetCookie", { cookies: "not an array of cookies" });

/* Core's ambient declarations ship and are still referenced from the entry. */
export function readWindowClient(w: Window): ScramjetClient {
	return w[SCRAMJETCLIENT];
}
export function readDocumentClient(d: Document): ScramjetClient {
	return d[SCRAMJETCLIENT];
}
export const clientName: "scramjet client global" = SCRAMJETCLIENTNAME;

/* Public controller surface a consumer actually uses. */
export const prefix: string = controllerConfig.prefix;
export const controllerVersion: string = CONTROLLER_VERSION;
export function makeController(init: ControllerInit): Controller {
	return new Controller(init);
}
export function frameOf(c: Controller, element: HTMLIFrameElement): Frame {
	return c.createFrame(element);
}
export function scramjetConfigOf(c: Controller): ScramjetConfig {
	return c.scramjetConfig;
}
export function partialConfig(): Partial<ControllerConfig> {
	return { prefix: "/scramjet/" };
}

/* Subclassing across the package boundary: install() returns undefined, and the
	 plugin base class the utils package re-exports is the controller's own. */
export class ConsumerPlugin extends ManagedPlugin {
	install(frame: Frame): undefined {
		void frame;
		return undefined;
	}
}
export const utilsPluginIsControllerPlugin: typeof UtilsManagedPlugin extends typeof ManagedPlugin
	? true
	: never = true;
export function utilsPlugins(onNewTab: (url: string) => void): ManagedPlugin[] {
	return [new HttpCachePlugin(), new LinkHandlerPlugin(onNewTab)];
}
`;

/**
 * Splits `tsc --pretty false` output into diagnostics with their file paths.
 *
 * @param {string} output
 * @returns {Array<{ file: string | null, code: string, line: string }>}
 */
function parseDiagnostics(output) {
	/** @type {Array<{ file: string | null, code: string, line: string }>} */
	const diagnostics = [];
	for (const line of output.split("\n")) {
		// `path(line,col): error TSxxxx: message` and the file-less
		// `error TSxxxx: message` form for option/config errors.
		const withFile = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/.exec(line);
		if (withFile) {
			diagnostics.push({ file: withFile[1], code: withFile[4], line });
			continue;
		}
		const withoutFile = /^error (TS\d+):/.exec(line);
		if (withoutFile)
			diagnostics.push({ file: null, code: withoutFile[1], line });
	}
	return diagnostics;
}

/**
 * Which installed package a diagnostic's file belongs to, or `null` when the
 * diagnostic is in the consumer's own sources or has no file at all.
 *
 * `tsc` reports paths relative to the project directory, so the `node_modules`
 * segment is matched with or without a leading separator; anchoring on
 * `"/node_modules/"` alone attributes every dependency diagnostic to the
 * consumer, which is the opposite of what this check needs.
 */
function owningDependency(file) {
	if (file === null) return null;
	const normalized = file.split(sep).join("/");
	const segments = normalized.split("/");
	const index = segments.lastIndexOf("node_modules");
	if (index === -1) return null;
	const scope = segments[index + 1];
	if (scope === undefined) return null;
	if (scope.startsWith("@")) {
		const name = segments[index + 2];
		return name === undefined ? scope : `${scope}/${name}`;
	}
	return scope;
}

/**
 * The member name a TS2305 "has no exported member" diagnostic complains about.
 *
 * Both spellings TypeScript emits are handled: the plain
 * `has no exported member 'X'.` and the suggestion form
 * `has no exported member named 'X'. Did you mean 'Y'?`.
 *
 * @param {string} line
 * @returns {string | null}
 */
function noExportedMemberName(line) {
	const match = /has no exported member(?: named)? '([^']+)'/.exec(line);
	return match ? match[1] : null;
}

/**
 * Every name `UPSTREAM_UNRESOLVABLE` actually exports, measured with the
 * consumer's own installed `typescript` under `bundler` resolution — the mode in
 * which that package's declarations do resolve.
 *
 * This is the evidence behind the TS2305 tolerance: without it, "TS2305 that
 * mentions the package" would also excuse a typo in one of our own imports.
 *
 * @returns {Promise<Set<string> | null>} `null` when the module could not be
 * resolved at all, which is a setup failure rather than something to tolerate.
 */
async function upstreamExportedMembers(work) {
	const tsEntry = join(work, "node_modules/typescript/lib/typescript.js");
	if (!existsSync(tsEntry)) return null;
	const ts = (await import(pathToFileURL(tsEntry).href)).default;

	// Deliberately outside `src`: the variant tsconfigs include `src` only, so
	// this probe cannot leak into the graded compiles.
	const probe = join(work, "upstream-exports.probe.ts");
	writeFileSync(
		probe,
		`import * as upstream from "${UPSTREAM_UNRESOLVABLE}";\nexport type Upstream = typeof upstream;\n`,
	);
	const program = ts.createProgram([probe], {
		target: ts.ScriptTarget.ES2022,
		lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: true,
		noEmit: true,
		// Only the export *names* are wanted here, and this program is not a gate;
		// the graded variants both run with `skipLibCheck: false`.
		skipLibCheck: true,
	});
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(probe);
	if (!source) return null;
	const declaration = source.statements.find((statement) =>
		ts.isImportDeclaration(statement),
	);
	if (!declaration) return null;
	const moduleSymbol = checker.getSymbolAtLocation(declaration.moduleSpecifier);
	if (!moduleSymbol) return null;
	const names = new Set(
		checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.getName()),
	);
	return names.size > 0 ? names : null;
}

/**
 * Whether a `nodenext` diagnostic is the documented upstream
 * `@mercuryworkshop/proxy-transports` defect (see `UPSTREAM_UNRESOLVABLE`).
 *
 * @param {{ file: string | null, code: string, line: string }} diagnostic
 * @param {string | null} owner
 * @param {Set<string>} upstreamExports names that package really exports
 */
function isUpstreamUnresolvable(diagnostic, owner, upstreamExports) {
	if (owner === UPSTREAM_UNRESOLVABLE)
		return UPSTREAM_TOLERATED.inside.has(diagnostic.code);
	if (!UPSTREAM_TOLERATED.naming.has(diagnostic.code)) return false;
	if (!diagnostic.line.includes(`"${UPSTREAM_UNRESOLVABLE}"`)) return false;
	// The member must be one the package genuinely exports. A misspelled local
	// import produces the same code against the same module and must not pass.
	const member = noExportedMemberName(diagnostic.line);
	return member !== null && upstreamExports.has(member);
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: process.env,
	});
	if (result.error) throw result.error;
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

const args = parseArgs(process.argv.slice(2));
const tarballs = findTarballs(args.tarballs);

const work = args.work
	? (mkdirSync(args.work, { recursive: true }), resolve(args.work))
	: mkdtempSync(join(tmpdir(), "scramjet-consumer-"));

console.log(`consumer project: ${work}`);
for (const { name, path } of tarballs) console.log(`  ${name} <- ${path}`);
console.log(
	`  @types/serviceworker: ${
		args.serviceWorkerTypes
			? "installed (documented DOM-lib incompatibility probe, not a supported consumer)"
			: "not installed (supported consumer shape)"
	}`,
);

const dependencies = Object.fromEntries(
	tarballs.map(({ name, path }) => [name, `file:${path}`]),
);

writeFileSync(
	join(work, "package.json"),
	`${JSON.stringify(
		{
			name: "scramjet-consumer-declaration-check",
			private: true,
			version: "0.0.0",
			type: "module",
			dependencies,
			devDependencies: {
				typescript: TS_VERSION,
				...(args.serviceWorkerTypes
					? { "@types/serviceworker": "^0.0.197" }
					: {}),
			},
		},
		null,
		"\t",
	)}\n`,
);

/**
 * The two resolution modes a real consumer uses. `skipLibCheck` is false in both
 * on purpose: it is the flag that would hide every defect this check looks for.
 * `types` is pinned to the empty list (plus `serviceworker` only in the
 * incompatibility probe) so nothing resolves through an ambient `@types` package
 * that happened to be installed.
 */
const VARIANTS = [
	{
		id: "bundler",
		label: "bundler",
		// Must be completely clean: nothing about this resolution mode depends on
		// the upstream defect below.
		tolerateUpstream: false,
		required: true,
		expectation: "pass (required)",
		compilerOptions: {
			module: "ESNext",
			moduleResolution: "bundler",
		},
	},
	{
		id: "nodenext",
		label: "NodeNext",
		tolerateUpstream: true,
		required: false,
		expectation: `expected failure (upstream ${UPSTREAM_UNRESOLVABLE})`,
		compilerOptions: {
			module: "NodeNext",
			moduleResolution: "NodeNext",
		},
	},
];

mkdirSync(join(work, "src"), { recursive: true });
writeFileSync(join(work, "src/probe.ts"), PROBE);

for (const variant of VARIANTS) {
	writeFileSync(
		join(work, `tsconfig.${variant.id}.json`),
		`${JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					lib: ["ES2022", "DOM", "DOM.Iterable"],
					strict: true,
					noEmit: true,
					skipLibCheck: false,
					types: args.serviceWorkerTypes ? ["serviceworker"] : [],
					...variant.compilerOptions,
				},
				include: ["src"],
			},
			null,
			"\t",
		)}\n`,
	);
}

const install = run(
	"npm",
	["install", "--no-audit", "--no-fund", "--loglevel", "error"],
	work,
);
console.log(install.stdout);
if (install.stderr) console.error(install.stderr);
if (install.status !== 0) {
	console.error(`npm install failed with exit ${install.status}`);
	process.exit(2);
}

const underTest = new Set(PACKAGES.map(({ name }) => name));

/**
 * The `@types` packages actually present after install.
 *
 * `types: []` in the tsconfig only stops *automatic* inclusion; it is not proof
 * that none is installed, and a transitively installed one is still reachable by
 * an explicit import from a dependency's declarations. So the directory is read
 * and reported. Nothing is deleted or masked.
 */
function installedTypesPackages() {
	const dir = join(work, "node_modules/@types");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((entry) => {
			try {
				return statSync(join(dir, entry)).isDirectory();
			} catch {
				return false;
			}
		})
		.sort()
		.map((entry) => {
			const manifest = join(dir, entry, "package.json");
			let version = null;
			try {
				version = JSON.parse(readFileSync(manifest, "utf8")).version ?? null;
			} catch {
				version = null;
			}
			return { name: `@types/${entry}`, version };
		});
}

const typesInstalled = installedTypesPackages();
console.log(`\n@types packages installed in the consumer project:`);
if (typesInstalled.length === 0) {
	console.log("  none");
} else {
	for (const { name, version } of typesInstalled)
		console.log(`  ${name}@${version ?? "<unreadable version>"}`);
	console.log(
		`  (reported, not removed; the graded compiles pin types: ${JSON.stringify(
			args.serviceWorkerTypes ? ["serviceworker"] : [],
		)})`,
	);
}

const upstreamExports = await upstreamExportedMembers(work);
if (upstreamExports === null) {
	console.error(
		`could not determine what ${UPSTREAM_UNRESOLVABLE} exports; refusing to tolerate anything on its behalf`,
	);
	process.exit(2);
}
console.log(
	`\n${UPSTREAM_UNRESOLVABLE} really exports ${upstreamExports.size} name(s) under bundler resolution:`,
);
console.log(`  ${[...upstreamExports].sort().join(", ")}`);

/**
 * Unit checks on the classifier, against the measured export set. These are what
 * keep the tolerance from degrading into "any TS2305 mentioning the package".
 */
{
	const realMember = [...upstreamExports].sort()[0];
	const line = (member) =>
		`node_modules/@mercuryworkshop/scramjet-controller/dist/types/index.d.ts(1,10): error TS2305: Module '"${UPSTREAM_UNRESOLVABLE}"' has no exported member '${member}'.`;
	const cases = [
		{
			what: `TS2305 for a real upstream member (${realMember}) is attributed upstream`,
			diagnostic: { file: "x.d.ts", code: "TS2305", line: line(realMember) },
			owner: "@mercuryworkshop/scramjet-controller",
			want: true,
		},
		{
			what: `TS2305 for a bogus member (${BOGUS_UPSTREAM_MEMBER}) is NOT attributed upstream`,
			diagnostic: {
				file: "x.d.ts",
				code: "TS2305",
				line: line(BOGUS_UPSTREAM_MEMBER),
			},
			owner: "@mercuryworkshop/scramjet-controller",
			want: false,
		},
		{
			what: "TS2307 naming the package is NOT attributed upstream",
			diagnostic: {
				file: "x.d.ts",
				code: "TS2307",
				line: `x.d.ts(1,1): error TS2307: Cannot find module '"${UPSTREAM_UNRESOLVABLE}"' or its corresponding type declarations.`,
			},
			owner: "@mercuryworkshop/scramjet-controller",
			want: false,
		},
		{
			what: "TS2834 in one of our own files is NOT attributed upstream",
			diagnostic: {
				file: "x.d.ts",
				code: "TS2834",
				line: "x.d.ts(1,1): error TS2834: Relative import paths need explicit file extensions",
			},
			owner: "@mercuryworkshop/scramjet-controller",
			want: false,
		},
	];
	let bad = 0;
	console.log("\nclassifier self-checks:");
	for (const testCase of cases) {
		const got = isUpstreamUnresolvable(
			testCase.diagnostic,
			testCase.owner,
			upstreamExports,
		);
		const ok = got === testCase.want;
		if (!ok) bad++;
		console.log(`  ${ok ? "OK  " : "FAIL"} ${testCase.what}`);
	}
	if (bad > 0) {
		console.error(`${bad} classifier self-check(s) failed`);
		process.exit(1);
	}
}

/**
 * Compiles one variant and grades it.
 *
 * @returns {{
 *   id: string, label: string, required: boolean, expectation: string,
 *   module: string, moduleResolution: string,
 *   tscExit: number, diagnostics: number, blocking: number, tolerated: number,
 *   byOwner: Array<{ owner: string, total: number, tolerated: number, underTest: boolean }>,
 *   outcome: string, output: string,
 * }}
 */
function gradeVariant(variant) {
	const tsc = run(
		join(work, "node_modules/.bin/tsc"),
		["--project", `tsconfig.${variant.id}.json`, "--pretty", "false"],
		work,
	);
	const output = `${tsc.stdout}${tsc.stderr}`;
	const diagnostics = parseDiagnostics(output);
	/** @type {Map<string, { total: number, tolerated: number }>} */
	const byOwner = new Map();
	let blocking = 0;
	let tolerated = 0;
	for (const diagnostic of diagnostics) {
		const owner = owningDependency(diagnostic.file);
		const key = owner ?? "<consumer sources / compiler options>";
		const isTolerated =
			variant.tolerateUpstream &&
			isUpstreamUnresolvable(diagnostic, owner, upstreamExports);
		const bucket = byOwner.get(key) ?? { total: 0, tolerated: 0 };
		bucket.total++;
		if (isTolerated) {
			bucket.tolerated++;
			tolerated++;
		} else {
			blocking++;
		}
		byOwner.set(key, bucket);
	}
	let outcome;
	if (blocking > 0) outcome = "fail";
	else if (diagnostics.length === 0 && tsc.status !== 0)
		outcome = "fail-unparseable";
	else if (tolerated > 0) outcome = "expected-failure-as-documented";
	else outcome = "pass";
	return {
		id: variant.id,
		label: variant.label,
		required: variant.required,
		expectation: variant.expectation,
		module: variant.compilerOptions.module,
		moduleResolution: variant.compilerOptions.moduleResolution,
		tscExit: tsc.status,
		diagnostics: diagnostics.length,
		blocking,
		tolerated,
		byOwner: [...byOwner]
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([owner, bucket]) => ({
				owner,
				total: bucket.total,
				tolerated: bucket.tolerated,
				underTest: underTest.has(owner),
			})),
		outcome,
		output,
	};
}

const results = [];
for (const variant of VARIANTS) {
	console.log(`\n=== variant: ${variant.label} — ${variant.expectation} ===`);
	const result = gradeVariant(variant);
	if (result.output.trim()) console.log(result.output.trimEnd());
	// Raw numbers first, verbatim, before any interpretation.
	console.log(
		`raw: tsc exit ${result.tscExit}, ${result.diagnostics} diagnostic(s), ${result.blocking} blocking, ${result.tolerated} attributed upstream`,
	);
	for (const bucket of result.byOwner) {
		const note = bucket.tolerated
			? ` (${bucket.tolerated} attributed to the documented ${UPSTREAM_UNRESOLVABLE} defect, printed above, not suppressed)`
			: "";
		console.log(
			`  ${bucket.total} in ${bucket.owner}${bucket.underTest ? " [under test]" : ""}${note}`,
		);
	}
	console.log(`outcome: ${result.label}: ${result.outcome}`);
	results.push(result);
}

/**
 * Failure injection: prove the tolerance cannot launder a bad member.
 *
 * A bogus member is added to a real import of `UPSTREAM_UNRESOLVABLE` inside an
 * installed package under test — i.e. exactly where a typo in one of our own
 * declarations would sit. Both variants must report it as blocking: `bundler`
 * because it tolerates nothing, and `nodenext` because the classifier requires
 * the named member to be a real upstream export. The file is restored afterwards
 * and the restore is verified by hash.
 */
function runInjection() {
	const controllerTypes = join(
		work,
		"node_modules/@mercuryworkshop/scramjet-controller/dist/types",
	);
	const target = readdirSync(controllerTypes)
		.filter((entry) => entry.endsWith(".d.ts"))
		.map((entry) => join(controllerTypes, entry))
		.find((file) => readFileSync(file, "utf8").includes(UPSTREAM_UNRESOLVABLE));
	if (!target) {
		return {
			ran: false,
			reason: `no declaration under test imports ${UPSTREAM_UNRESOLVABLE}`,
		};
	}
	const original = readFileSync(target, "utf8");
	const digest = (text) => createHash("sha256").update(text).digest("hex");
	const before = digest(original);
	writeFileSync(
		target,
		`import type { ${BOGUS_UPSTREAM_MEMBER} } from "${UPSTREAM_UNRESOLVABLE}";\nexport type __InjectedProbe = ${BOGUS_UPSTREAM_MEMBER};\n${original}`,
	);
	const injected = [];
	try {
		for (const variant of VARIANTS) injected.push(gradeVariant(variant));
	} finally {
		writeFileSync(target, original);
	}
	const after = digest(readFileSync(target, "utf8"));
	const checks = [];
	for (const result of injected) {
		const baseline = results.find((entry) => entry.id === result.id);
		checks.push({
			what: `${result.label} reports the bogus member`,
			ok: new RegExp(
				`has no exported member (?:named )?'${BOGUS_UPSTREAM_MEMBER}'`,
			).test(result.output),
			detail: `tsc exit ${result.tscExit}, ${result.diagnostics} diagnostic(s)`,
		});
		checks.push({
			what: `${result.label} counts it as blocking rather than attributing it upstream`,
			ok: result.blocking > baseline.blocking,
			detail: `blocking ${baseline.blocking} -> ${result.blocking}, tolerated ${baseline.tolerated} -> ${result.tolerated}`,
		});
	}
	checks.push({
		what: "injected file restored byte-for-byte",
		ok: before === after,
		detail: `${before.slice(0, 12)} -> ${after.slice(0, 12)}`,
	});
	return {
		ran: true,
		file: target.slice(work.length + 1),
		member: BOGUS_UPSTREAM_MEMBER,
		checks,
		variants: injected.map(
			({ id, tscExit, diagnostics, blocking, tolerated }) => ({
				id,
				tscExit,
				diagnostics,
				blocking,
				tolerated,
			}),
		),
	};
}

let injection = { ran: false, reason: "skipped with --skip-injection" };
if (args.injection) {
	console.log(
		`\n=== failure injection: bogus '${BOGUS_UPSTREAM_MEMBER}' imported from ${UPSTREAM_UNRESOLVABLE} ===`,
	);
	injection = runInjection();
	if (injection.ran) {
		console.log(`injected into ${injection.file}`);
		for (const variant of injection.variants) {
			console.log(
				`  ${variant.id}: tsc exit ${variant.tscExit}, ${variant.diagnostics} diagnostic(s), ${variant.blocking} blocking`,
			);
		}
		for (const check of injection.checks)
			console.log(
				`  ${check.ok ? "OK  " : "FAIL"} ${check.what} — ${check.detail}`,
			);
	} else {
		console.log(`not run: ${injection.reason}`);
	}
}

const requiredResults = results.filter((result) => result.required);
const requiredPassed = requiredResults.every(
	(result) => result.outcome === "pass",
);
const unattributed = results.filter(
	(result) => !result.required && result.blocking > 0,
);
/** Non-gating variants that actually hit the documented upstream defect. */
const expectedFailures = results.filter(
	(result) => !result.required && result.tolerated > 0,
);
const labelsOf = (entries) =>
	entries.length === 0 ? "none" : entries.map((e) => e.label).join(", ");
const requiredLabels = labelsOf(requiredResults);
const expectedFailureLabels = labelsOf(expectedFailures);
const nonRequiredLabels = labelsOf(results.filter((result) => !result.required));
const injectionOk = injection.ran
	? injection.checks.every((check) => check.ok)
	: !args.injection;

console.log("\n=== variant matrix ===");
for (const result of results) {
	console.log(
		`  ${result.label}: ${result.outcome} — ${result.required ? "REQUIRED" : "not gating"}; ${result.expectation}; raw tsc exit ${result.tscExit}, ${result.diagnostics} diagnostic(s), ${result.blocking} blocking`,
	);
}
if (args.injection) {
	console.log(
		`  failure injection: ${injection.ran ? (injectionOk ? "pass" : "fail") : `not run (${injection.reason})`}`,
	);
}

// Keep the known-broken NodeNext story visible in CI rather than letting an
// aggregate exit 0 imply it is fine.
for (const result of results) {
	if (result.required || result.tolerated === 0) continue;
	console.log(
		`::warning title=NodeNext consumer resolution is a known failure::${result.label} resolution reports ${result.diagnostics} diagnostic(s) (raw tsc exit ${result.tscExit}); all ${result.tolerated} are attributed to the upstream ${UPSTREAM_UNRESOLVABLE} defect and none is fixable from this repository. Registry NodeNext compatibility remains OPEN.`,
	);
}

const report = {
	tool: "tools/consumer-declaration-check.mjs",
	generatedAt: new Date().toISOString(),
	typescript: TS_VERSION,
	work,
	tarballs: tarballs.map(({ name, path }) => ({ name, path })),
	packagesUnderTest: [...underTest],
	serviceWorkerTypes: args.serviceWorkerTypes,
	typesPackagesInstalled: typesInstalled,
	upstream: {
		package: UPSTREAM_UNRESOLVABLE,
		toleratedCodes: {
			inside: [...UPSTREAM_TOLERATED.inside],
			naming: [...UPSTREAM_TOLERATED.naming],
		},
		exportedMembers: [...upstreamExports].sort(),
	},
	variants: results.map(({ output: _output, ...rest }) => rest),
	injection,
	gate: {
		requiredVariants: requiredResults.map((result) => result.id),
		requiredPassed,
		unattributedNonRequired: unattributed.map((result) => ({
			id: result.id,
			blocking: result.blocking,
		})),
		injectionOk,
		// Stated here so no reader has to infer it from the exit code, and derived
		// from what this run actually observed: if the upstream defect is ever
		// fixed, `expectedFailures` goes empty and the claim says so rather than
		// still asserting a failure that did not happen.
		claim: !requiredPassed
			? `the required ${requiredLabels} gate FAILED`
			: expectedFailures.length > 0
				? `the required ${requiredLabels} gate passed; ${expectedFailureLabels} remains a documented upstream failure and is NOT claimed to be clean`
				: `the required ${requiredLabels} gate passed, and ${nonRequiredLabels} reported no diagnostics either (raw tsc exit 0), so no expected failure was recorded this run`,
	},
	exit: 0,
};

const failed = !requiredPassed || unattributed.length > 0 || !injectionOk;
report.exit = failed ? 1 : 0;

const reportPath = args.report
	? resolve(args.report)
	: join(work, "consumer-declaration-report.json");
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, "\t")}\n`);
console.log(`\nmachine report: ${reportPath}`);

console.log(`consumer project kept at ${work}`);
console.log(`RESULT: ${failed ? "fail" : "pass"} — ${report.gate.claim}`);

process.exit(failed ? 1 : 0);
