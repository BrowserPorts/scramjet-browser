/**
 * Browser assets that live inside Runway's installed dependencies.
 *
 * Resolution goes through Node's package resolver on each package's public entry
 * point, so it works in a pnpm store layout, a hoisted `node_modules` and a
 * consumer's own tree alike. Runway never joins a guessed `node_modules` path and
 * never reads a dependency's `package.json`, which `exports` may legitimately
 * refuse to expose.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunwayError } from "../core/errors.ts";

export type AssetKind = "scramjet" | "controller" | "libcurl";

export type AssetSpec = {
	/**
	 * Package whose entry point locates the asset, for assets that come from a
	 * dependency. Absent for assets Runway ships itself.
	 */
	readonly specifier?: string;
	/**
	 * Where an asset Runway owns lives, per execution shape. Absent for assets
	 * that come from a dependency.
	 *
	 * The two paths are relative to THIS module and are chosen by which shape is
	 * running, never by trying one and falling back to the other: a packaged
	 * install must not reach outside the package, or a consumer that happens to
	 * have a `vendor/libcurl.js/dist` of its own would silently be served it.
	 */
	readonly owned?: {
		/** Packaged: `dist/fixtures/` beside `dist/assets/`. */
		readonly dist: string;
		/** This repository: `src/fixtures/`, with the build under `vendor/`. */
		readonly source: string;
	};
	/** File that must exist for the directory to be usable. */
	readonly expectFile: string;
	readonly flag: string;
	/** Shown when an owned asset is missing, instead of a package name. */
	readonly buildHint?: string;
};

export const ASSET_SPECS: Readonly<Record<AssetKind, AssetSpec>> = Object.freeze({
	scramjet: {
		specifier: "@mercuryworkshop/scramjet",
		expectFile: "scramjet.js",
		flag: "--scramjet-dist",
	},
	controller: {
		specifier: "@mercuryworkshop/scramjet-controller",
		expectFile: "controller.api.js",
		flag: "--controller-dist",
	},
	/*
	 * Runway ships its own libcurl transport rather than resolving the published
	 * `@mercuryworkshop/libcurl-transport`, whose 2.0.5 build hangs forever on a
	 * 304 and on any HEAD. The bundled build carries the fixes for both.
	 *
	 * It is still an OPTIONAL transport in the same sense as before: only the
	 * scramjet harness page loads it, the bare lane never does, and nothing in
	 * the runner imports it. This only changes which directory is served.
	 *
	 * Source, licences and the exact inputs are in `SOURCES.md` beside the files.
	 */
	libcurl: {
		owned: {
			dist: "../assets/libcurl",
			source: "../../../../vendor/libcurl.js/dist",
		},
		expectFile: "index.js",
		flag: "--libcurl-dist",
		buildHint:
			"In an installed package this asset ships with Runway, so a missing one " +
			"means the install is incomplete: reinstall, or rebuild it from the " +
			"corresponding source beside it (BUILD.md and source.tar.gz). In this " +
			"repository, build it with vendor/libcurl.js/prepare-build-tree.sh and the " +
			"commands in vendor/libcurl.js/BUILD-RECIPE.md. Either way, " +
			"--libcurl-dist <dir> overrides.",
	},
});

export type ResolvedAsset = {
	readonly kind: AssetKind;
	readonly directory: string;
	readonly origin: "resolved" | "override";
};

function verify(kind: AssetKind, directory: string, origin: ResolvedAsset["origin"]): ResolvedAsset {
	const spec = ASSET_SPECS[kind];
	if (!existsSync(directory) || !statSync(directory).isDirectory()) {
		throw new RunwayError(
			"fixtures/asset-unresolved",
			`the ${kind} asset directory does not exist: ${directory}`,
			{
				details: { kind, directory, origin },
				remedy: `Point ${spec.flag} at the built asset directory.`,
			}
		);
	}
	if (!existsSync(path.join(directory, spec.expectFile))) {
		const what = spec.specifier ?? `Runway's own ${kind} asset`;
		throw new RunwayError(
			"fixtures/asset-unresolved",
			`${directory} does not contain ${spec.expectFile}, so it cannot serve ${what}`,
			{
				details: { kind, directory, origin, expected: spec.expectFile },
				remedy:
					origin === "override"
						? `${spec.flag} must name the directory that contains ${spec.expectFile}.`
						: (spec.buildHint ??
							`Build ${what}, or pass ${spec.flag} <dir> to use prebuilt assets.`),
			}
		);
	}
	return Object.freeze({ kind, directory, origin });
}

export type AssetResolveOptions = {
	/**
	 * Directory a relative override is resolved against. Required: the caller's
	 * working directory is an input, never something this module reads from the
	 * ambient process. A programmatic caller with a different `cwd` must not be
	 * able to load assets from the runner's directory by accident.
	 */
	readonly cwd: string;
	readonly override?: string;
};

/** Resolves one asset directory, honouring an explicit override. */
export function resolveAssetDirectory(
	kind: AssetKind,
	options: AssetResolveOptions
): ResolvedAsset {
	const spec = ASSET_SPECS[kind];
	if (options.override) {
		return verify(kind, path.resolve(options.cwd, options.override), "override");
	}
	if (spec.owned) {
		// `tsconfig` emits `src/**` to `dist/**` with the layout preserved and the
		// build refuses to finish if anything is bundled, so the directory holding
		// this module names the shape exactly: `src` in this repository, `dist`
		// once compiled and packed. Anything else is a layout this module does not
		// know how to serve, and guessing would be how a packaged install ends up
		// reading a directory outside its own package.
		const here = path.dirname(fileURLToPath(import.meta.url));
		const layout = path.basename(path.dirname(here));
		const relative =
			layout === "dist"
				? spec.owned.dist
				: layout === "src"
					? spec.owned.source
					: undefined;
		if (relative === undefined) {
			throw new RunwayError(
				"fixtures/asset-unresolved",
				`Runway is running from an unsupported layout (${layout}), so its own ${kind} asset cannot be located`,
				{
					details: { kind, layout, module: here },
					remedy: `Run Runway from its package or this repository, or pass ${spec.flag} <dir>.`,
				}
			);
		}
		// Deliberately fatal when absent: no second candidate, and no fallback to
		// the published package, whose 304/HEAD handling never settles.
		return verify(kind, path.resolve(here, relative), "resolved");
	}
	if (!spec.specifier) {
		throw new RunwayError(
			"fixtures/asset-unresolved",
			`the ${kind} asset has neither a package specifier nor an owned directory`,
			{ details: { kind }, remedy: `Pass ${spec.flag} <dir>.` }
		);
	}
	let resolved: string;
	try {
		resolved = import.meta.resolve(spec.specifier);
	} catch (cause) {
		throw new RunwayError(
			"fixtures/asset-unresolved",
			`could not resolve ${spec.specifier} from Runway`,
			{
				details: { kind, specifier: spec.specifier },
				remedy: `Install ${spec.specifier} next to Runway, or pass ${spec.flag} <dir>.`,
				cause,
			}
		);
	}
	if (!resolved.startsWith("file:")) {
		throw new RunwayError(
			"fixtures/asset-unresolved",
			`${spec.specifier} resolved to ${resolved}, which is not a local file`,
			{ details: { kind, resolved }, remedy: `Pass ${spec.flag} <dir>.` }
		);
	}
	return verify(kind, path.dirname(fileURLToPath(resolved)), "resolved");
}

/** SHA-256 of one served entry file. Paths are never recorded as hashes. */
export function hashAssetEntry(directory: string, expectFile: string): string {
	const file = path.join(directory, expectFile);
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}
