/**
 * External plugin profiles.
 *
 * A profile is a JSON manifest the consumer owns. Every path inside it resolves
 * against the manifest's own directory, never the working directory, so a profile
 * can be moved without rewriting it. The manifest path is an explicit argument:
 * this module reads no environment. A declared `../` is the consumer's own
 * resolution and is honoured; containment is a property of what the harness will
 * *serve*, which is checked separately below.
 *
 * The browser-facing profile JSON keeps the shape the existing plugin factories
 * already consume, so external plugins keep working across the v2 rewrite.
 *
 * Provenance hashes are the declared tree's identity: the canonical entry files,
 * and every file under an asset mount the server will actually answer, hashed
 * recursively. They are not a transitive dependency graph — a plugin that imports
 * another module at runtime is not covered, and the hash names say so. And they
 * are not a byte count of the directory: entries the static handler refuses to
 * serve (dotfiles it denies) are excluded from the inventory, because hashing
 * bytes the lane can never load would claim provenance the run does not have.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { RunwayError } from "../core/errors.ts";

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

const MANIFEST_KEYS = ["name", "plugins", "assets", "serviceWorker"] as const;
const PLUGIN_KEYS = ["entry", "options"] as const;
const ASSET_KEYS = ["name", "directory"] as const;
const SERVICE_WORKER_KEYS = ["entry", "type"] as const;

export type PluginManifest = {
	readonly name: string;
	readonly plugins?: readonly {
		readonly entry: string;
		readonly options?: Readonly<Record<string, unknown>>;
	}[];
	readonly assets?: readonly { readonly name: string; readonly directory: string }[];
	readonly serviceWorker?: {
		readonly entry: string;
		readonly type?: "classic" | "module";
	};
};

/** Browser-facing profile. Served at `/runway-plugin-profile.json`. */
export type BrowserPluginProfile = {
	readonly name: string;
	readonly plugins: readonly {
		readonly url: string;
		readonly sha256: string;
		readonly options: Readonly<Record<string, unknown>>;
	}[];
	readonly assets: Readonly<Record<string, string>>;
	readonly serviceWorker?: {
		readonly url: string;
		readonly sha256: string;
		readonly type: "classic" | "module";
	};
};

export type StaticMount =
	| {
			readonly kind: "file";
			/**
			 * The exact request path the server answers. Its basename is the
			 * *declared* entry's basename, so URL identity is stable no matter what
			 * the entry resolves to: a link and its target never collide.
			 */
			readonly url: string;
			/**
			 * The entry's canonical path: symlinks resolved. This is the identity
			 * the server derives its exact served bytes from, and the bytes the
			 * recorded hash attests — not a same-named neighbour of the link.
			 */
			readonly file: string;
	  }
	| { readonly kind: "directory"; readonly url: string; readonly directory: string };

export type LoadedPluginProfile = {
	readonly profile: BrowserPluginProfile;
	readonly mounts: readonly StaticMount[];
	/** Hashes of everything the lane will load, for lane provenance. */
	readonly loaded: Readonly<Record<string, string>>;
	readonly manifestPath: string | null;
};

/**
 * Does this mount path name a dotfile at any depth, the way the static
 * handler checks it?
 *
 * `send` denies a request when *any* of its path segments starts with a dot and
 * is longer than one character (`.` itself and `..` are handled by its own
 * normalization and traversal rejection). Verified against the vendored
 * `send@0.19.0`: `/top.txt` 200, `/.env` 403, `/nested/.h.txt` 403,
 * `/.hdir/leaf.txt` 403 — a dotfile at any depth, including an intermediate
 * directory, is denied, never served. The inventory below excludes exactly that
 * set: hashing bytes the lane can never load would claim provenance the run
 * does not have.
 */
function isDeniedDotfile(mountPath: string): boolean {
	return mountPath
		.split("/")
		.some((segment) => segment.length > 1 && segment.startsWith("."));
}

/**
 * One servable file under an asset mount: a file the static handler will
 * actually answer, which excludes the dotfile requests it denies.
 *
 * The mount path is recorded as a POSIX-relative path because that is the shape
 * of the request the harness will answer, and the bytes are described by both
 * length and content hash so a same-length edit cannot pass unnoticed.
 */
export type ServableFile = {
	readonly path: string;
	readonly type: "file";
	readonly bytes: number;
	readonly sha256: string;
	/** Present only when the mode carries information a plain read does not. */
	readonly executable?: true;
};

export const BUILTIN_PROFILE: LoadedPluginProfile = Object.freeze({
	profile: Object.freeze({ name: "builtin", plugins: [], assets: Object.freeze({}) }),
	mounts: Object.freeze([]),
	loaded: Object.freeze({}),
	manifestPath: null,
});

function invalid(message: string, details: Record<string, unknown>): never {
	throw new RunwayError("config/invalid-option", message, {
		details,
		remedy: "Fix the plugin manifest; Runway never falls back to the builtin profile.",
	});
}

function missing(message: string, details: Record<string, unknown>, cause?: unknown): never {
	throw new RunwayError("config/missing-input", message, {
		details,
		...(cause === undefined ? {} : { cause }),
		remedy: "Paths in a manifest resolve against the manifest's directory.",
	});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Refuses keys the loader does not implement.
 *
 * A misspelled key is the one manifest error that otherwise costs nothing at load
 * time and everything at run time: the profile loads, the plugin never loads, and
 * the run reports a plugin failure instead of a manifest typo. There are no
 * aliases and no legacy spellings to accept.
 */
function rejectUnknownKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	where: string,
	details: Record<string, unknown>
): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) {
		invalid(`${where} has unknown key(s): ${unknown.join(", ")}`, {
			...details,
			unknown,
			allowed,
		});
	}
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** The permission bits a static file server can act on; nothing host-specific. */
function executableBit(stats: Stats): boolean {
	return (stats.mode & 0o111) !== 0;
}

function describeEntryKind(stats: Stats): string {
	if (stats.isSymbolicLink()) return "symbolic link";
	if (stats.isBlockDevice()) return "block device";
	if (stats.isCharacterDevice()) return "character device";
	if (stats.isFIFO()) return "fifo";
	if (stats.isSocket()) return "socket";
	return "unknown entry";
}

/**
 * Resolves `file` the way the harness's static handler will, and refuses anything
 * that would leave `root` once symlinks are followed.
 *
 * This mirrors the serving policy exactly: the harness answers a mounted request
 * with the real path of the file and returns 403 when that real path is outside
 * the mount. A profile that hashes bytes the harness would refuse to serve would
 * be recording provenance for something the lane can never load.
 */
async function resolveContained(
	file: string,
	root: string,
	details: Record<string, unknown>
): Promise<string> {
	let resolvedRoot: string;
	try {
		resolvedRoot = await realpath(root);
	} catch (cause) {
		missing(`the mount root ${root} could not be resolved`, { ...details, root }, cause);
	}
	let resolved: string;
	try {
		resolved = await realpath(file);
	} catch (cause) {
		missing(
			`${file} could not be resolved; a mounted path must exist and a symbolic link must have a target`,
			{ ...details, file },
			cause
		);
	}
	if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
		invalid(`${file} escapes its mount and could never be served`, {
			...details,
			file,
			resolved,
			mount: resolvedRoot,
		});
	}
	return resolved;
}

/**
 * Recursively inventories the files an asset mount can serve.
 *
 * Nested directories are included because the harness serves them: a mount is
 * answered by joining the request path onto the mount root, at any depth. An
 * entry that is neither a file nor a directory is refused rather than skipped —
 * silently ignoring it would hash a directory as if the unservable entry were
 * not there, and the run would claim provenance it does not have.
 *
 * Dotfile *requests* are the one exclusion, because the static handler denies
 * them (`dotfiles: "deny"`): a dotfile on disk can never be loaded by the lane,
 * so it is left out of the inventory rather than hashed as loadable bytes. The
 * exclusion applies at every depth, exactly as the handler checks it.
 */
export async function inventoryServableFiles(
	root: string,
	details: Record<string, unknown> = {}
): Promise<readonly ServableFile[]> {
	let resolvedRoot: string;
	try {
		resolvedRoot = await realpath(root);
	} catch (cause) {
		missing(`the asset directory ${root} could not be resolved`, { ...details, root }, cause);
	}
	const files: ServableFile[] = [];

	const walk = async (
		directory: string,
		prefix: string,
		// Symlinked directories are legal and servable, but a link back into its own
		// chain of parents must fail loudly instead of walking forever. Only the
		// ancestor chain is a cycle: two links to the same directory are two
		// servable paths, not a loop.
		ancestors: readonly string[]
	): Promise<void> => {
		const names = (await readdir(directory)).sort();
		for (const name of names) {
			const full = path.join(directory, name);
			const mountPath = prefix === "" ? name : `${prefix}/${name}`;
			if (isDeniedDotfile(mountPath)) continue;
			const entryDetails = { ...details, entry: mountPath };
			// Containment is checked per entry, before the bytes are read, so a link
			// out of the mount is a load failure rather than recorded provenance.
			const resolved = await resolveContained(full, resolvedRoot, entryDetails);
			const info = await stat(full);
			if (info.isDirectory()) {
				if (ancestors.includes(resolved)) {
					invalid(`the asset directory contains a symbolic link cycle at ${mountPath}`, {
						...entryDetails,
						resolved,
					});
				}
				await walk(full, mountPath, [...ancestors, resolved]);
				continue;
			}
			if (!info.isFile()) {
				invalid(
					`the asset entry ${mountPath} is a ${describeEntryKind(info)}; a mount may only contain files and directories`,
					entryDetails
				);
			}
			const bytes = await readFile(full);
			files.push(
				Object.freeze({
					path: mountPath,
					type: "file" as const,
					bytes: bytes.byteLength,
					sha256: sha256(bytes),
					...(executableBit(info) ? { executable: true as const } : {}),
				})
			);
		}
	};

	await walk(resolvedRoot, "", [resolvedRoot]);
	return Object.freeze(files);
}

/**
 * Digests an inventory as framed, canonical JSON.
 *
 * Framing is the point. Hashing `name` and then the bytes of each file lets
 * `a` + `bc` collide with `ab` + `c`, so two different directories can share a
 * digest. Serializing the inventory — path, type, length, content hash, and the
 * mode when it carries information — gives every field its own delimited place,
 * so a nested edit, a rename, or a moved file all change the digest.
 */
export function digestServableFiles(files: readonly ServableFile[]): string {
	const canonical = files.map((file) => ({
		path: file.path,
		type: file.type,
		bytes: file.bytes,
		sha256: file.sha256,
		...(file.executable ? { executable: true } : {}),
	}));
	return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/** Reads and validates a manifest. Returns the builtin profile when none is given. */
export async function loadPluginProfile(
	manifestPath: string | null
): Promise<LoadedPluginProfile> {
	if (!manifestPath) return BUILTIN_PROFILE;
	const filename = path.resolve(manifestPath);
	const directory = path.dirname(filename);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(filename, "utf8")) as unknown;
	} catch (cause) {
		throw new RunwayError(
			"config/invalid-option",
			`the plugin manifest at ${filename} could not be read as JSON`,
			{ cause, remedy: "Check the file exists and contains valid JSON." }
		);
	}
	if (!isPlainObject(parsed)) {
		invalid("a plugin manifest must be a JSON object", { filename });
	}
	rejectUnknownKeys(parsed, MANIFEST_KEYS, "the plugin manifest", { filename });
	const manifest = parsed as unknown as PluginManifest;
	if (typeof manifest.name !== "string" || !NAME_PATTERN.test(manifest.name)) {
		invalid("a plugin profile needs a name of letters, numbers, hyphens or underscores", {
			filename,
			name: manifest.name,
		});
	}
	if (manifest.name === "builtin") {
		invalid("`builtin` is reserved for the no-plugin profile", { filename });
	}
	// The collections are checked as collections before anything iterates them: a
	// `plugins` object rather than an array would otherwise iterate as empty and
	// load a profile with no plugins at all.
	if (manifest.plugins !== undefined && !Array.isArray(manifest.plugins)) {
		invalid("`plugins` must be an array of plugin entries", {
			filename,
			received: isPlainObject(manifest.plugins) ? "object" : typeof manifest.plugins,
		});
	}
	if (manifest.assets !== undefined && !Array.isArray(manifest.assets)) {
		invalid("`assets` must be an array of asset mounts", {
			filename,
			received: isPlainObject(manifest.assets) ? "object" : typeof manifest.assets,
		});
	}
	if (manifest.serviceWorker !== undefined && !isPlainObject(manifest.serviceWorker)) {
		invalid("`serviceWorker` must be an object", {
			filename,
			received: Array.isArray(manifest.serviceWorker)
				? "array"
				: typeof manifest.serviceWorker,
		});
	}

	const mounts: StaticMount[] = [];
	const loaded: Record<string, string> = {};
	const mountEntry = async (entry: unknown, key: string) => {
		if (typeof entry !== "string" || entry === "") {
			invalid("plugin entries must be file paths", { filename, key, received: typeof entry });
		}
		// A declared `../` is the consumer's own path resolution, not traversal.
		const file = path.resolve(directory, entry);
		const details = { filename, key, entry };
		let canonical: string;
		try {
			canonical = await realpath(file);
		} catch (cause) {
			missing(
				`the plugin entry ${entry} does not exist (resolved to ${file})`,
				details,
				cause
			);
		}
		let info: Stats;
		try {
			info = await stat(canonical);
		} catch (cause) {
			missing(
				`the plugin entry ${entry} could not be read (resolved to ${canonical})`,
				details,
				cause
			);
		}
		if (!info.isFile()) {
			invalid(`the plugin entry ${entry} is not a file (resolved to ${canonical})`, {
				...details,
				kind: info.isDirectory() ? "directory" : describeEntryKind(info),
			});
		}
		// Authorization, identity, and URL naming, in that order. The entry is
		// authorized against its *declared* parent — a link that wanders out of it
		// is refused even though the bytes exist. What is mounted is then the
		// *canonical* file, and the hash below attests exactly those bytes. The
		// public URL, though, names the *declared* basename: URL identity follows
		// what the manifest said, so `entry.mjs -> nested/actual.mjs` is served at
		// `…/entry.mjs` while a guess at `…/actual.mjs` names nothing. Keeping the
		// two separate is what keeps an alias from accidentally minting a second
		// addressable name.
		await resolveContained(canonical, path.dirname(file), details);
		const digest = sha256(await readFile(canonical));
		const declaredBasename = path.basename(file);
		const url = `/__runway_plugins__/${key}/${encodeURIComponent(declaredBasename)}`;
		mounts.push({ kind: "file", url, file: canonical });
		// Entry identity, not a transitive graph: the key names the declared entry
		// the lane loads; the hash attests the canonical target's bytes.
		loaded[`plugin:${key}:${declaredBasename}`] = digest;
		return { url, sha256: digest };
	};

	const plugins: BrowserPluginProfile["plugins"][number][] = [];
	for (const [index, plugin] of (manifest.plugins ?? []).entries()) {
		if (!isPlainObject(plugin)) {
			invalid("each plugin entry must be an object", {
				filename,
				index,
				received: Array.isArray(plugin) ? "array" : typeof plugin,
			});
		}
		rejectUnknownKeys(plugin, PLUGIN_KEYS, `plugin entry ${index}`, { filename, index });
		if (plugin.options !== undefined && !isPlainObject(plugin.options)) {
			invalid("plugin options must be an object", { filename, index });
		}
		plugins.push({
			...(await mountEntry(plugin.entry, String(index))),
			options: (plugin.options as Readonly<Record<string, unknown>> | undefined) ?? {},
		});
	}

	const assets: Record<string, string> = {};
	for (const [index, asset] of (manifest.assets ?? []).entries()) {
		if (!isPlainObject(asset)) {
			invalid("each asset mount must be an object", {
				filename,
				index,
				received: Array.isArray(asset) ? "array" : typeof asset,
			});
		}
		rejectUnknownKeys(asset, ASSET_KEYS, `asset mount ${index}`, { filename, index });
		if (typeof asset.name !== "string" || !NAME_PATTERN.test(asset.name)) {
			invalid("asset names must be letters, numbers, hyphens or underscores", {
				filename,
				index,
				asset: asset.name,
			});
		}
		const assetName = asset.name;
		if (Object.hasOwn(assets, assetName)) {
			invalid("asset names must be unique", { filename, index, asset: assetName });
		}
		if (typeof asset.directory !== "string" || asset.directory === "") {
			invalid("asset directories must be file paths", { filename, index, asset: assetName });
		}
		const assetDirectory = path.resolve(directory, asset.directory);
		let info: Stats;
		try {
			info = await stat(assetDirectory);
		} catch (cause) {
			missing(
				`the asset directory ${asset.directory} does not exist (resolved to ${assetDirectory})`,
				{ filename, asset: assetName },
				cause
			);
		}
		if (!info.isDirectory()) {
			invalid("an asset mount must be a directory", {
				filename,
				asset: assetName,
				assetDirectory,
			});
		}
		const url = `/__runway_plugins__/assets/${assetName}`;
		mounts.push({ kind: "directory", url, directory: assetDirectory });
		assets[assetName] = `${url}/`;
		loaded[`asset:${assetName}`] = digestServableFiles(
			await inventoryServableFiles(assetDirectory, { filename, asset: assetName })
		);
	}

	let serviceWorker: BrowserPluginProfile["serviceWorker"];
	if (manifest.serviceWorker) {
		rejectUnknownKeys(
			manifest.serviceWorker as unknown as Record<string, unknown>,
			SERVICE_WORKER_KEYS,
			"the serviceWorker entry",
			{ filename }
		);
		const type = manifest.serviceWorker.type ?? "classic";
		if (type !== "classic" && type !== "module") {
			invalid("a host service worker type must be classic or module", { filename, type });
		}
		serviceWorker = { ...(await mountEntry(manifest.serviceWorker.entry, "host")), type };
	}

	if (plugins.length === 0 && !serviceWorker) {
		invalid("the profile configures no plugin and no host service worker", { filename });
	}

	return Object.freeze({
		profile: Object.freeze({
			name: manifest.name,
			plugins: Object.freeze(plugins),
			assets: Object.freeze(assets),
			...(serviceWorker ? { serviceWorker } : {}),
		}),
		mounts: Object.freeze(mounts),
		loaded: Object.freeze({ ...loaded, "profile:name": manifest.name }),
		manifestPath: filename,
	});
}
