/**
 * @fileoverview
 * Guards the declaration-packaging contract for the packages that ship types.
 *
 * The contract, and why each half of it exists:
 *
 * - `@mercuryworkshop/rpc` is a build-only workspace package. It is not
 *   published, so it must never appear in a published package's
 *   `dependencies`/`peerDependencies` and must never be named by a published
 *   declaration. The controller still exposes `Controller.rpc` as the real
 *   `RpcHelper<Controllerbound, SWbound>` generic, so rpc's declarations are
 *   emitted *into* the controller at `dist/types/internal/rpc.d.ts` and the
 *   emitted specifier is redirected there.
 * - Every relative specifier in a published declaration must name a file the
 *   package actually contains, with an extension. `tsc` copies source
 *   specifiers verbatim, so `./types` and `.` reach the output and break any
 *   consumer whose resolver is not `bundler`.
 * - Core's ambient `global.d.ts` and the wasm-bindgen `wasm.d.ts` are `.d.ts`
 *   *inputs*, which `tsc` neither emits nor references from its output. They are
 *   copied after emit, and the entry declaration gets the reference back, or the
 *   `Window`/`Document` `[SCRAMJETCLIENT]` properties and the `Self`/`GlobalThis`
 *   aliases resolve to nothing in a consumer.
 *
 * This file checks the built output and the manifests. The compiler proof — an
 * empty project that installs the tarballs and compiles against them under two
 * resolution modes — is `tools/consumer-declaration-check.mjs`, run by
 * `pnpm test:consumer`; the two are complementary, not alternatives.
 */

import test from "ava";
import { existsSync, readFileSync } from "node:fs";
import {
	assertNoSpecifiers,
	assertRelativeSpecifiersResolved,
} from "../../tools/declaration-postemit.mjs";

/** Packages whose declaration output is published and therefore checked. */
const DECLARATION_OUTPUTS = [
	"packages/core/dist/types",
	"packages/controller/dist/types",
	"packages/utils/dist/types",
];

/** The workspace packages that must never be named by a published declaration. */
const BUILD_ONLY_PACKAGES = ["@mercuryworkshop/rpc"];

/**
 * The canonical prefix of every `build` script that invokes the root rspack
 * config. `--configName` is the spelling `rspack build --help` documents.
 */
const ROOT_BUILD = "cd ../.. && rspack build --mode production";

/**
 * Every workspace package whose `build` script invokes the root rspack config,
 * with the configs it is expected to select.
 *
 * This exists because a narrowed selection is only correct if it is closed under
 * the root config's `dependencies`. rspack enforces that at build time —
 * `MultiCompiler.validateDependencies` refuses to run when `--configName` filters
 * out a dependency of a selected config — but only for a build someone actually
 * runs. A package script that has quietly become unclosed stays broken until the
 * next release, so the expected invocation is pinned here as a static contract.
 *
 * The scripts are listed, not discovered: nothing here parses or executes a shell
 * command, and no unrelated package's scripts are read.
 */
const ROOT_CONFIG_BUILDS = [
	{
		package: "core",
		select: [],
		why: "core is the root of the graph and builds every config",
	},
	{
		package: "utils",
		select: [],
		why: "utils builds every config; its two configs share the declaration program with core's",
	},
	{
		package: "controller",
		select: ["scramjet-esmodule", "scramjet-types", "scramjet-controller"],
		why: "the controller's declaration compile reads core's dist/types, which scramjet-types writes",
	},
	{
		package: "bootstrap",
		select: [
			"scramjet-esmodule",
			"scramjet-types",
			"scramjet-controller",
			"scramjet-bootstrap",
		],
		why: "bootstrap's declaration compile reads the controller's dist/types, which in turn reaches core's",
	},
	{
		package: "create-proxy-app",
		select: ["create-proxy-app"],
		why: "a standalone CLI bundle with no declaration compile and no dependencies",
	},
];

/**
 * The root config's `dependencies` edges, as an explicit table.
 *
 * A mirror of `rspack.config.ts` kept deliberately: importing that file would
 * execute it, which reads a built wasm artifact and installs plugin ownership as a
 * side effect. rspack's own `validateDependencies` is the runtime enforcement; this
 * table is what lets the expected selections above be checked for closure, so a
 * selection cannot be narrowed and the table "corrected" to match in one step.
 */
const CONFIG_DEPENDENCIES = {
	"scramjet-iife": [],
	"scramjet-iife-bundled": [],
	"scramjet-esmodule": [],
	"scramjet-esmodule-bundled": [],
	"scramjet-types": [],
	"scramjet-controller": ["scramjet-esmodule", "scramjet-types"],
	"scramjet-utils-iife": [
		"scramjet-esmodule",
		"scramjet-types",
		"scramjet-controller",
	],
	"scramjet-utils-esmodule": [
		"scramjet-esmodule",
		"scramjet-types",
		"scramjet-controller",
	],
	"scramjet-bootstrap": ["scramjet-types", "scramjet-controller"],
	"scramjet-bootstrap-static": [],
	"create-proxy-app": [],
};

/** `select` rendered as the flags a canonical `build` script spells out. */
function expectedBuildScript(select) {
	if (select.length === 0) return ROOT_BUILD;
	return `${ROOT_BUILD} ${select.map((name) => `--configName ${name}`).join(" ")}`;
}

/** Every config a selection drags in, following `CONFIG_DEPENDENCIES`. */
function closureOf(select) {
	const seen = new Set();
	const stack = [...select];
	while (stack.length) {
		const name = stack.pop();
		if (seen.has(name)) continue;
		seen.add(name);
		stack.push(...(CONFIG_DEPENDENCIES[name] ?? []));
	}
	return seen;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function read(path) {
	return readFileSync(path, "utf8");
}

test("rpc stays a build-only dependency of the controller", (t) => {
	const pkg = readJson("packages/controller/package.json");
	t.truthy(
		(pkg.devDependencies || {})["@mercuryworkshop/rpc"],
		"the controller compiles against rpc, so it must stay a devDependency",
	);
	for (const field of [
		"dependencies",
		"peerDependencies",
		"optionalDependencies",
	]) {
		t.falsy(
			(pkg[field] || {})["@mercuryworkshop/rpc"],
			`@mercuryworkshop/rpc is not published, so it must not appear in ${field}`,
		);
	}
});

test("rpc resolves to source in the workspace and to dist when published", (t) => {
	const pkg = readJson("packages/rpc/package.json");
	t.is(
		pkg.types,
		"./index.ts",
		"in the workspace rpc is consumed from source, so no dist build is a prerequisite of any other package's build",
	);
	t.deepEqual(pkg.exports["."], {
		types: "./index.ts",
		default: "./index.ts",
	});
	t.is(pkg.publishConfig.types, "./dist/index.d.ts");
	t.deepEqual(pkg.publishConfig.exports["."], {
		types: "./dist/index.d.ts",
		default: "./dist/index.js",
	});
	t.deepEqual(pkg.files, ["dist"]);
});

test("the controller carries rpc's declarations instead of depending on it", (t) => {
	const bundled = "packages/controller/dist/types/internal/rpc.d.ts";
	t.true(existsSync(bundled), `${bundled} must be emitted into the controller`);

	const rpc = read(bundled);
	t.regex(
		rpc,
		/declare class RpcHelper<Local extends RpcDescription, Remote extends RpcDescription>/,
		"the bundled declaration must be the real generic, not a stub or an alias to any",
	);
	t.regex(rpc, /call<Method extends keyof Remote>/);

	const index = read("packages/controller/dist/types/index.d.ts");
	t.regex(
		index,
		/import \{ RpcHelper \} from "\.\/internal\/rpc\.js";/,
		"the emitted specifier must point at the bundled declaration",
	);
	t.regex(
		index,
		/rpc: RpcHelper<Controllerbound, SWbound>;/,
		"Controller.rpc must keep its exact public type",
	);
});

test("each package's build script selects the configs its own build needs", (t) => {
	for (const { package: name, select, why } of ROOT_CONFIG_BUILDS) {
		const script = readJson(`packages/${name}/package.json`).scripts?.build;
		t.is(
			// Whitespace is not part of the contract; the flags and their order are.
			String(script).replace(/\s+/g, " ").trim(),
			expectedBuildScript(select),
			`packages/${name} build script: ${why}`,
		);
	}
});

test("every selection a build script makes is closed under the config graph", (t) => {
	for (const { package: name, select } of ROOT_CONFIG_BUILDS) {
		if (select.length === 0) continue; // a full build selects everything
		for (const config of select) {
			t.true(
				Object.hasOwn(CONFIG_DEPENDENCIES, config),
				`packages/${name} selects ${config}, which is not a known config`,
			);
		}
		const missing = [...closureOf(select)].filter(
			(config) => !select.includes(config),
		);
		t.deepEqual(
			missing,
			[],
			`packages/${name} selects ${select.join(", ")} but rspack will refuse to run it without: ${missing.join(", ")}`,
		);
	}
});

test("no published declaration names a build-only package", (t) => {
	for (const dir of DECLARATION_OUTPUTS) {
		t.true(existsSync(dir), `${dir} must be built before this check runs`);
		t.notThrows(
			() => assertNoSpecifiers(dir, BUILD_ONLY_PACKAGES),
			`${dir} must not name ${BUILD_ONLY_PACKAGES.join(", ")}`,
		);
	}
});

test("every relative specifier in a published declaration resolves", (t) => {
	for (const dir of DECLARATION_OUTPUTS) {
		t.notThrows(
			() => assertRelativeSpecifiersResolved(dir),
			`${dir} must not contain extensionless or dangling relative specifiers`,
		);
	}
});

test("core ships the ambient declarations its emitted types name", (t) => {
	const ambient = "packages/core/dist/types/global.d.ts";
	t.true(existsSync(ambient), `${ambient} must be copied after emit`);

	const index = read("packages/core/dist/types/index.d.ts");
	t.regex(
		index,
		/^\/\/\/ <reference path="\.\/global\.d\.ts" \/>/,
		"the entry declaration must reference the ambient file, which nothing imports",
	);

	const global = read(ambient);
	t.regex(
		global,
		/import type \{ SCRAMJETCLIENT \} from "\.\/symbols\.js";/,
		"the ambient file must resolve SCRAMJETCLIENT the same way from dist/types as from src",
	);
	for (const host of ["Window", "Document"]) {
		t.regex(
			global,
			new RegExp(
				`interface ${host} \\{[\\s\\S]*?\\[SCRAMJETCLIENT\\]: ScramjetClient;`,
			),
			`${host}[SCRAMJETCLIENT] must survive declaration emit`,
		);
	}
});

test("SCRAMJETCLIENT is emitted as a usable property key", (t) => {
	const symbols = read("packages/core/dist/types/symbols.d.ts");
	t.regex(
		symbols,
		/declare const SCRAMJETCLIENTBRAND: unique symbol;/,
		"a computed property key needs a unique symbol, and Symbol.for is typed as the widened symbol",
	);
	t.regex(
		symbols,
		/export declare const SCRAMJETCLIENT: typeof SCRAMJETCLIENTBRAND;/,
		"consumers must get the key by importing SCRAMJETCLIENT, with no ambient stub",
	);
});

test("core ships the wasm-bindgen declarations, with the lib they need", (t) => {
	const wasm = "packages/core/dist/rewriter/wasm/out/wasm.d.ts";
	t.true(existsSync(wasm), `${wasm} must be copied into the package`);

	const emitted = read("packages/core/dist/types/shared/rewriters/wasm.d.ts");
	t.regex(
		emitted,
		/from "\.\.\/\.\.\/\.\.\/rewriter\/wasm\/out\/wasm\.js"/,
		"the emitted declaration must resolve to the copy, not to a path outside the package",
	);

	const declarations = read(wasm);
	t.regex(
		declarations,
		/^\/\/\/ <reference lib="esnext\.disposable" \/>/,
		"Rewriter declares [Symbol.dispose](), so the package states that lib requirement itself",
	);
	t.regex(declarations, /\[Symbol\.dispose\]\(\): void;/);
});
