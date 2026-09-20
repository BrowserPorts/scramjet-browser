#!/usr/bin/env node
/**
 * Compiles Runway to `dist/` so the packaged CLI runs from an installed
 * `node_modules` tree, where Node's type stripping is unavailable.
 *
 * TypeScript emit is the only code transform. The harness pages are copied
 * verbatim, so the packaged runner serves byte-identical browser payloads.
 *
 * One thing the compiler leaves undone is finished here: emitted declarations keep
 * the `.ts` extensions the sources import each other with, so they name files that
 * a package shipping only `.js` and `.d.ts` does not contain. See
 * `scripts/declaration-extensions.mjs`. The build then refuses to finish while any
 * output still names a TypeScript source file.
 */
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	findSourceExtensionSpecifiers,
	rewriteDeclarationExtensions,
} from "./scripts/declaration-extensions.mjs";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(packageRoot, "dist");

/** Directories copied verbatim from `src/` into `dist/`. */
export const ASSET_DIRECTORIES = Object.freeze([
	"harness/scramjet/public",
	"harness/bare/public",
]);

/**
 * Assets Runway owns but does not keep under `src/`, copied into `dist/` so the
 * packed tarball carries them.
 *
 * The libcurl transport is built from `vendor/libcurl.js` (pristine upstream +
 * our patches) and lives there with its licences and `SOURCES.md`. Copying it
 * here is what makes an installed consumer resolve it package-relatively,
 * instead of needing a sibling checkout or the published build.
 */
export const VENDOR_ASSETS = Object.freeze([
	{
		from: path.join(packageRoot, "..", "..", "vendor", "libcurl.js", "dist"),
		to: path.join(dist, "assets", "libcurl"),
		expect: "index.js",
		what: "the bundled libcurl transport",
		remedy:
			"Build it with vendor/libcurl.js/prepare-build-tree.sh and the commands in " +
			"vendor/libcurl.js/BUILD-RECIPE.md.",
	},
]);

function resolveTsc() {
	const local = path.join(
		packageRoot,
		"node_modules",
		"typescript",
		"bin",
		"tsc"
	);
	if (existsSync(local)) return local;
	throw new Error(
		"typescript is not installed for this package. Run `pnpm install --filter runway` " +
			"(or `npm install` inside packages/runway) before building."
	);
}

async function copyAssets() {
	for (const relative of ASSET_DIRECTORIES) {
		const from = path.join(packageRoot, "src", relative);
		const to = path.join(dist, relative);
		if (!existsSync(from)) continue;
		await mkdir(path.dirname(to), { recursive: true });
		await cp(from, to, { recursive: true });
	}
	for (const asset of VENDOR_ASSETS) {
		// Missing is fatal, never skipped: a tarball without this asset would make
		// the installed CLI fall back to nothing at all, and the whole point of
		// shipping it is that the published transport's build is broken. Nothing
		// is downloaded or compiled here — the artifact must already be built.
		if (!existsSync(path.join(asset.from, asset.expect))) {
			throw new Error(
				`${asset.what} is not built: ${path.join(asset.from, asset.expect)} is missing. ${asset.remedy}`
			);
		}
		await mkdir(path.dirname(asset.to), { recursive: true });
		await cp(asset.from, asset.to, { recursive: true });
	}
}

async function* walk(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else yield full;
	}
}

async function countFiles(directory) {
	let total = 0;
	for await (const _ of walk(directory)) total += 1;
	return total;
}

/** Rewrites `.ts` module specifiers in emitted declarations. Returns the count. */
async function fixDeclarationExtensions() {
	let rewritten = 0;
	for await (const file of walk(dist)) {
		if (!file.endsWith(".d.ts")) continue;
		const source = await readFile(file, "utf8");
		const { text, rewrites } = rewriteDeclarationExtensions(source);
		if (rewrites.length === 0) continue;
		await writeFile(file, text, "utf8");
		rewritten += rewrites.length;
	}
	return rewritten;
}

/**
 * Fails the build when any emitted file still points at a TypeScript source file.
 *
 * Module positions are found with the TypeScript parser, in both JavaScript emit
 * and declarations: a string inside `eval(…)`, a comment or a literal type that
 * mentions a `.ts` path is not an import and never fails the build. A specifier
 * shape neither the compiler nor the declaration rewrite handles would otherwise
 * ship as an import of a file the package does not contain.
 */
async function assertNoSourceExtensions() {
	const offenders = [];
	for await (const file of walk(dist)) {
		if (!/\.(js|mjs|cjs|d\.ts)$/.test(file)) continue;
		const found = findSourceExtensionSpecifiers(await readFile(file, "utf8"));
		for (const specifier of found) {
			offenders.push(`${path.relative(packageRoot, file)} imports ${specifier}`);
		}
	}
	if (offenders.length > 0) {
		throw new Error(
			`dist/ still names TypeScript sources the package does not ship:\n  ${offenders.join("\n  ")}`
		);
	}
}

/**
 * A failed build leaves no `dist/` at all.
 *
 * `tsc` emits what it managed to compile even when it reports errors, and the
 * declaration rewrite runs only after a clean compile. Keeping that partial output
 * would leave a directory that looks like a build: modules missing, declarations
 * still naming `.ts` sources, and a `pnpm pack` invoked with scripts disabled would
 * package it. Removing it makes a failed build indistinguishable from a build that
 * was never run.
 *
 * The wipe at the top is inside `build()` — not at module scope — because this
 * module is also imported for `ASSET_DIRECTORIES`. An import must not delete,
 * write, spawn or chmod anything: the whole build runs only under the
 * invoked-directly guard at the bottom of the file.
 */
async function build() {
	await rm(dist, { recursive: true, force: true });
	const tsc = resolveTsc();
	const compile = spawnSync(process.execPath, [tsc, "--project", packageRoot], {
		stdio: "inherit",
	});
	if (compile.status !== 0) {
		throw new Error(`tsc failed with exit code ${compile.status ?? 1}`);
	}

	await copyAssets();

	const rewritten = await fixDeclarationExtensions();
	await assertNoSourceExtensions();

	const cli = path.join(dist, "cli", "bin.js");
	if (!existsSync(cli)) {
		throw new Error("dist/cli/bin.js is missing after compilation");
	}
	await chmod(cli, 0o755);
	await stat(path.join(dist, "public.js"));
	return rewritten;
}

let rewritten;
// `process.argv[1]` is the script being run, or undefined when this module is
// merely imported (a test importing `ASSET_DIRECTORIES` runs under the test
// runner, not under this file). Comparing resolved paths keeps the guard exact:
// anything else — a relative invocation, a symlink, an import — must not build.
const invokedDirectly =
	typeof process.argv[1] === "string" &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	try {
		rewritten = await build();
	} catch (error) {
		await rm(dist, { recursive: true, force: true });
		process.stderr.write(
			`runway: build failed, dist/ removed — ${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exit(1);
	}

	console.log(
		`runway: built ${await countFiles(dist)} files into dist/ ` +
			`(${rewritten} declaration specifier(s) rewritten to shipped files)`
	);
}
