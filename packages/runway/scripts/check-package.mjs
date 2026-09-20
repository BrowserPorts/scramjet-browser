#!/usr/bin/env node
/**
 * Checks that Runway is publishable, using the tools the ecosystem already has.
 *
 *     node scripts/check-package.mjs [--keep]
 *
 * Three steps, no invention:
 *
 * 1. `pnpm pack` produces the tarball. It has to be pnpm: Runway depends on its
 *    workspace siblings through `workspace:*` and on two packages through
 *    `catalog:`, and only pnpm resolves those to concrete versions when packing.
 *    `npm pack` copies them verbatim and the result is uninstallable anywhere.
 * 2. `publint` lints the packed tarball for the packaging mistakes that only show
 *    up after publishing — entry points that do not resolve, wrong file
 *    extensions for the declared module type, `files` that omit what `exports`
 *    promises.
 * 3. `attw` (`@arethetypeswrong/cli`) resolves every entry point the way Node and
 *    bundlers do and reports where the types do not follow the JavaScript.
 *
 * `attw` runs against the *tarball*, not `--pack`: its `--pack` shells out to a
 * package manager of its own choosing, which in this workspace means `npm pack`
 * and therefore unresolved `workspace:`/`catalog:` specifiers. Packing first with
 * pnpm and handing over the file avoids that entirely.
 *
 * The only thing here that is not one of those tools is a short list of paths that
 * must never be inside the tarball — scratch output and unmigrated sources that
 * this working tree does carry. `publint` has no opinion about those, and a
 * release that ships them is a mistake nobody notices until it is public.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findForbiddenTarballPaths } from "./package-content.mjs";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const keep = process.argv.includes("--keep");

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: packageRoot,
		encoding: "utf8",
		...options,
	});
	if (result.error) throw result.error;
	return result;
}

/** Runs a tool and streams its output, returning whether it passed. */
function check(label, command, args) {
	process.stdout.write(`\n--- ${label}: ${command} ${args.join(" ")}\n`);
	const result = run(command, args, { stdio: "inherit" });
	const ok = result.status === 0;
	process.stdout.write(`--- ${label}: exit ${result.status}\n`);
	return ok;
}

function packTarball(destination) {
	const result = run("pnpm", ["pack", "--pack-destination", destination]);
	if (result.status !== 0) {
		throw new Error(`pnpm pack failed (exit ${result.status})\n${result.stdout}\n${result.stderr}`);
	}
	// pnpm prints the packed file list and then the tarball path; the last absolute
	// `.tgz` line is the archive itself.
	const named = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.endsWith(".tgz"))
		.filter((line) => path.isAbsolute(line));
	const tarball = named.pop();
	if (!tarball) throw new Error(`pnpm pack named no tarball\n${result.stdout}\n${result.stderr}`);
	return path.resolve(destination, path.basename(tarball));
}

/** The tarball's member paths, relative to the `package/` root npm tarballs use. */
function tarballEntries(tarball) {
	const result = run("tar", ["-tzf", tarball]);
	if (result.status !== 0) {
		throw new Error(`could not list ${tarball} (exit ${result.status})\n${result.stderr}`);
	}
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.endsWith("/"))
		.map((line) => (line.startsWith("package/") ? line.slice("package/".length) : line));
}

const scratch = await mkdtemp(path.join(tmpdir(), "runway-check-package-"));
let failures = 0;
try {
	process.stdout.write(`--- packing with pnpm into ${scratch}\n`);
	const tarball = packTarball(scratch);
	const entries = tarballEntries(tarball);
	process.stdout.write(`--- packed ${path.basename(tarball)} (${entries.length} file(s))\n`);

	const offenders = findForbiddenTarballPaths(entries);
	process.stdout.write("\n--- contents: nothing scratch, generated or unpublishable\n");
	if (offenders.length > 0) {
		failures += 1;
		for (const offender of offenders) process.stderr.write(`  ships ${offender}\n`);
		process.stdout.write(`--- contents: ${offenders.length} problem(s)\n`);
	} else {
		process.stdout.write("--- contents: ok\n");
	}

	const bin = path.join(packageRoot, "node_modules", ".bin");
	if (!check("publint", path.join(bin, "publint"), [tarball, "--strict"])) failures += 1;
	// `--profile esm-only` is `attw`'s own profile for a package that ships ESM and
	// nothing else, which is what this one is: `"type": "module"`, no `require`
	// condition, `engines.node >= 22`. It stops reporting the two consequences of
	// that choice — a `require` call reaching ESM, and node10's pre-`exports`
	// resolver failing on subpath exports — while still reporting anything where the
	// types do not follow the JavaScript.
	if (!check("attw", path.join(bin, "attw"), [tarball, "--profile", "esm-only"])) failures += 1;

	if (keep) {
		process.stdout.write(`\n--- kept ${tarball}\n`);
	}
	process.stdout.write(
		failures === 0
			? "\ncheck-package: ok\n"
			: `\ncheck-package: ${failures} check(s) failed\n`
	);
	process.exitCode = failures === 0 ? 0 : 1;
} finally {
	if (!keep) await rm(scratch, { recursive: true, force: true });
	else process.stdout.write(`--- scratch kept at ${scratch}: ${(await readdir(scratch)).join(", ")}\n`);
}
