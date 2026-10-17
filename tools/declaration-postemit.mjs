/**
 * @fileoverview
 * Post-emit fixups for the `.d.ts` output of the workspace declaration builds.
 *
 * Two problems are fixed here, both of them properties of what `tsc` emits
 * rather than of the sources:
 *
 * 1. Extensionless relative specifiers (`resolveRelativeSpecifiers`).
 *    The packages compile with `moduleResolution: "bundler"`, so their sources
 *    import siblings as `./types` and `tsc` copies that specifier verbatim into
 *    the emitted declaration. A consumer on `moduleResolution: "node16"`,
 *    `"nodenext"` or `"bundler"`-less ESM resolution requires the extension, and
 *    a published declaration naming `./types` describes a file the package does
 *    not contain. Each specifier is resolved against the emitted tree and
 *    rewritten to the file that is actually there: `./types` -> `./types.js`,
 *    `./client` -> `./client/index.js`, `.` -> `./index.js`. Nothing is guessed;
 *    a specifier that resolves to neither is a build failure.
 *
 * 2. Bare specifiers for build-only dependencies (`redirectBareSpecifiers`).
 *    The controller's public API types name `RpcHelper` from
 *    `@mercuryworkshop/rpc`, a workspace package that is not published. Instead
 *    of turning a private package into a public runtime dependency, its
 *    declarations are emitted into the consuming package at a stable internal
 *    path and the emitted specifier is redirected there. The public type is the
 *    real generic `RpcHelper<Local, Remote>`, not an ambient stub, and the
 *    installed declaration graph needs nothing outside the tarball.
 *
 * Module specifier positions are located with the TypeScript parser, never with
 * text patterns, so a string literal type, a comment or a template that happens
 * to look like a path is never touched. `declare module "…"` is deliberately not
 * visited: it declares a module identity rather than referencing one.
 *
 * Everything here fails closed. An unresolvable relative specifier, a redirect
 * target that was not emitted, or a leftover specifier for a build-only package
 * throws, and the caller (the rspack declaration plugin, or the CI gate) turns
 * that into a non-zero exit rather than shipping a broken declaration.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

/** Specifiers that already name a file a package can contain. */
const RESOLVED_EXTENSION = /\.(js|mjs|cjs|json|css)$/;

/** `./x.d.ts`, `./x.d.mts`, `./x.d.cts` and `./x.d.anything.ts` name declarations. */
const DECLARATION_NAME = /\.d(\.[^./]+)*\.(ts|mts|cts)$/;

/**
 * The relative specifiers that name a directory and nothing else.
 *
 * `import { Frame } from "."` is legal in a source compiled with
 * `moduleResolution: "bundler"` and `tsc` copies it verbatim into the emitted
 * declaration, where it is a directory import: `node16`/`nodenext` consumers
 * reject it outright. These forms need `index.js` appended rather than an
 * extension, and they are not caught by a `./`-prefix test, so they are named
 * explicitly.
 */
const DIRECTORY_SELF = new Set([".", "..", "./", "../"]);

/**
 * Whether a specifier is relative in the sense the module resolvers use.
 *
 * `startsWith("./") || startsWith("../")` misses the bare `"."` and `".."`
 * directory forms; treating those as bare package specifiers is what let an
 * unresolved directory import reach a published declaration.
 *
 * @param {string} specifier
 */
function isRelativeSpecifier(specifier) {
	return (
		specifier.startsWith("./") ||
		specifier.startsWith("../") ||
		DIRECTORY_SELF.has(specifier)
	);
}

/**
 * Every module specifier in a parsed declaration file, with its exact span.
 *
 * Covers the module syntax `tsc` emits into declarations: static import/export
 * clauses, side-effect imports, `import("…")` types, and
 * `import x = require("…")` / `export = require("…")`. `declare module "./…"` is
 * deliberately absent — rewriting it would change what the declaration
 * augments.
 *
 * @param {string} sourceText
 * @returns {Array<{ specifier: string, start: number, end: number }>}
 */
export function findModuleSpecifiers(sourceText) {
	const sourceFile = ts.createSourceFile(
		"declaration-postemit.d.ts",
		sourceText,
		ts.ScriptTarget.ESNext,
		true,
		ts.ScriptKind.TS,
	);
	/** @type {import("typescript").StringLiteralLike[]} */
	const found = [];
	/** @param {import("typescript").Node} node */
	const visit = (node) => {
		/** @param {import("typescript").Node | undefined} literal */
		const take = (literal) => {
			if (literal && ts.isStringLiteralLike(literal)) found.push(literal);
		};
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier
		) {
			take(node.moduleSpecifier);
		} else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument)
		) {
			take(node.argument.literal);
		} else if (ts.isImportEqualsDeclaration(node)) {
			const reference = node.moduleReference;
			if (reference && ts.isExternalModuleReference(reference))
				take(reference.expression);
		} else if (
			ts.isExportAssignment(node) &&
			node.expression &&
			ts.isExternalModuleReference(node.expression)
		) {
			take(node.expression.expression);
		} else if (
			ts.isCallExpression(node) &&
			node.arguments.length === 1 &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments[0] &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			take(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found.map((literal) => ({
		specifier: literal.text,
		// The span excludes the quote characters, so the replacement never has to
		// know which quote style `tsc` chose.
		start: literal.getStart(sourceFile) + 1,
		end: literal.getEnd() - 1,
	}));
}

/**
 * Exact-case directory entry lookup.
 *
 * `existsSync` answers case-insensitively on macOS and Windows, which would let
 * a `./Types` specifier "resolve" against `types.d.ts` and then fail on a
 * case-sensitive consumer. Reading the directory and comparing names byte-wise
 * is the only check that matches what a case-sensitive filesystem does.
 */
class ExactCaseTree {
	constructor() {
		/** @type {Map<string, Set<string> | null>} */
		this.entries = new Map();
	}

	/** @param {string} dir @returns {Set<string> | null} */
	list(dir) {
		const cached = this.entries.get(dir);
		if (cached !== undefined) return cached;
		/** @type {Set<string> | null} */
		let names = null;
		try {
			names = new Set(readdirSync(dir));
		} catch {
			names = null;
		}
		this.entries.set(dir, names);
		return names;
	}

	/** @param {string} path @returns {boolean} */
	isFile(path) {
		const names = this.list(dirname(path));
		if (!names || !names.has(basenameOf(path))) return false;
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	}

	/** @param {string} path @returns {boolean} */
	isDirectory(path) {
		const names = this.list(dirname(path));
		if (!names || !names.has(basenameOf(path))) return false;
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	}
}

/**
 * Guards the one invariant a rewrite of a relative specifier must keep: it stays
 * relative. Dropping the `./` would silently turn `./shared` into the bare
 * package specifier `shared`, which resolves to nothing and makes every
 * `export *` behind it contribute no exports — a failure that shows up as
 * "has no exported member" in a consumer rather than as a broken path.
 *
 * @param {string} specifier
 */
function keepRelative(specifier) {
	if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
		throw new Error(
			`declaration rewrite produced the non-relative specifier ${JSON.stringify(specifier)}`,
		);
	}
	return specifier;
}

/** @param {string} path */
function basenameOf(path) {
	const parts = path.split(sep);
	return parts[parts.length - 1];
}

/** Every `.d.ts` file under `dir`, as absolute paths, in stable order. */
export function listDeclarationFiles(dir) {
	/** @type {string[]} */
	const out = [];
	/** @param {string} current */
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true }).sort(
			(left, right) => (left.name < right.name ? -1 : 1),
		)) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && entry.name.endsWith(".d.ts")) out.push(path);
		}
	};
	walk(dir);
	return out;
}

/**
 * The extension-carrying form of one relative specifier, or `null` when it
 * already names an emitted file.
 *
 * @param {string} specifier the specifier as `tsc` emitted it
 * @param {string} fromFile absolute path of the declaration that contains it
 * @param {ExactCaseTree} tree
 * @returns {string | null}
 * @throws when the specifier resolves to nothing in the emitted tree
 */
export function resolveRelativeSpecifier(specifier, fromFile, tree) {
	if (!isRelativeSpecifier(specifier)) return null;
	if (RESOLVED_EXTENSION.test(specifier)) return null;
	// `./x.d.ts` names a declaration that is in the package already. TypeScript
	// resolves it, and rewriting it to `./x.d.js` would name nothing.
	if (DECLARATION_NAME.test(specifier)) return null;

	const base = dirname(fromFile);
	const target = resolve(base, specifier);
	// Built by concatenation, never by `path.join`: joining normalises `./x`
	// to `x`, which turns a relative specifier into a bare package specifier
	// that resolves to nothing.
	//
	// The directory-only forms are resolved as directories only. Appending an
	// extension to `"."` would produce `"..js"`, and the `${target}.d.ts` probe
	// below would ask about a `.d.ts` named after the containing directory,
	// which is a different file than the one the specifier means.
	if (!DIRECTORY_SELF.has(specifier) && tree.isFile(`${target}.d.ts`))
		return keepRelative(`${specifier}.js`);
	if (tree.isDirectory(target) && tree.isFile(join(target, "index.d.ts"))) {
		return keepRelative(`${specifier.replace(/\/+$/, "")}/index.js`);
	}
	// A specifier that already points at a `.ts` source (Node type-stripping
	// style) maps onto the emitted `.js` name when the declaration is there.
	if (specifier.endsWith(".ts")) {
		const withoutExtension = specifier.slice(0, -".ts".length);
		if (tree.isFile(`${resolve(base, withoutExtension)}.d.ts`))
			return keepRelative(`${withoutExtension}.js`);
	}
	throw new Error(
		`${fromFile}: relative specifier ${JSON.stringify(
			specifier,
		)} resolves to no emitted declaration (looked for ${relative(
			base,
			`${target}.d.ts`,
		)} and ${relative(base, join(target, "index.d.ts"))})`,
	);
}

/**
 * Applies a list of `{ start, end, to }` edits to text, right to left so that
 * earlier spans keep their offsets.
 *
 * @param {string} source
 * @param {Array<{ start: number, end: number, to: string }>} edits
 */
function applyEdits(source, edits) {
	let text = source;
	for (const edit of [...edits].sort((left, right) => right.start - left.start))
		text = `${text.slice(0, edit.start)}${edit.to}${text.slice(edit.end)}`;
	return text;
}

/**
 * Gives every extensionless relative specifier in `dir` the extension of the
 * declaration it actually resolves to.
 *
 * @param {string} dir declaration output directory
 * @returns {{ files: number, rewrites: Array<{ file: string, from: string, to: string }> }}
 */
export function resolveRelativeSpecifiers(dir) {
	const tree = new ExactCaseTree();
	const files = listDeclarationFiles(dir);
	/** @type {Array<{ file: string, from: string, to: string }>} */
	const rewrites = [];
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		/** @type {Array<{ start: number, end: number, to: string }>} */
		const edits = [];
		for (const span of findModuleSpecifiers(source)) {
			const rewritten = resolveRelativeSpecifier(span.specifier, file, tree);
			if (rewritten === null || rewritten === span.specifier) continue;
			edits.push({ start: span.start, end: span.end, to: rewritten });
			rewrites.push({
				file: relative(dir, file),
				from: span.specifier,
				to: rewritten,
			});
		}
		if (edits.length) writeFileSync(file, applyEdits(source, edits));
	}
	return { files: files.length, rewrites };
}

/**
 * Redirects bare specifiers to declarations bundled inside the same output.
 *
 * @param {string} dir declaration output directory
 * @param {Record<string, string>} map bare specifier -> path of the bundled
 *   declaration, relative to `dir` (for example `internal/rpc.d.ts`)
 * @returns {{ rewrites: Array<{ file: string, from: string, to: string }> }}
 */
export function redirectBareSpecifiers(dir, map) {
	const tree = new ExactCaseTree();
	for (const [specifier, target] of Object.entries(map)) {
		if (!tree.isFile(join(dir, target))) {
			throw new Error(
				`declaration redirect for ${specifier} names ${target}, which was not emitted into ${dir}`,
			);
		}
	}
	/** @type {Array<{ file: string, from: string, to: string }>} */
	const rewrites = [];
	for (const file of listDeclarationFiles(dir)) {
		const source = readFileSync(file, "utf8");
		/** @type {Array<{ start: number, end: number, to: string }>} */
		const edits = [];
		for (const span of findModuleSpecifiers(source)) {
			const target = map[span.specifier];
			if (target === undefined) continue;
			// The emitted specifier must be relative to the file that holds it and
			// name the `.js` sibling of the bundled declaration, which is what both
			// `bundler` and `node16` resolution look for.
			const absolute = join(dir, target).replace(/\.d\.ts$/, ".js");
			let to = relative(dirname(file), absolute).split(sep).join("/");
			if (!to.startsWith(".")) to = `./${to}`;
			edits.push({ start: span.start, end: span.end, to });
			rewrites.push({ file: relative(dir, file), from: span.specifier, to });
		}
		if (edits.length) writeFileSync(file, applyEdits(source, edits));
	}
	return { rewrites };
}

/**
 * Ensures an emitted declaration opens with a `/// <reference path="…" />` to a
 * declaration the package ships but that nothing imports.
 *
 * Ambient files are the case: `global.d.ts` declares the `Window`/`Document`
 * `[SCRAMJETCLIENT]` properties and the `GlobalThis`/`Self` aliases that emitted
 * signatures name, but `tsc` neither emits a `.d.ts` input nor keeps a path
 * reference to one in declaration output — it assumes ambient types are simply
 * present in the consumer's program. Without the reference the consumer resolves
 * `Self` to nothing; with it, loading the entry loads the globals.
 *
 * Idempotent, and fails when the referenced file is not actually in the output.
 *
 * @param {string} dir declaration output directory
 * @param {Array<{ file: string, path: string }>} references `file` is relative
 *   to `dir`; `path` is the reference target, relative to `file`
 * @returns {{ added: string[] }}
 */
export function ensureDeclarationReferences(dir, references) {
	const tree = new ExactCaseTree();
	/** @type {string[]} */
	const added = [];
	for (const { file, path } of references) {
		const target = join(dir, file);
		if (!tree.isFile(target)) {
			throw new Error(
				`declaration reference host ${file} was not emitted into ${dir}`,
			);
		}
		const referenced = resolve(dirname(target), path);
		if (!tree.isFile(referenced)) {
			throw new Error(
				`declaration reference from ${file} names ${path}, which is not in ${dir}`,
			);
		}
		const directive = `/// <reference path="${path}" />`;
		const source = readFileSync(target, "utf8");
		if (source.includes(directive)) continue;
		writeFileSync(target, `${directive}\n${source}`);
		added.push(`${file} -> ${path}`);
	}
	return { added };
}

/**
 * Ensures a shipped declaration opens with `/// <reference lib="…" />`.
 *
 * A declaration whose types name a standard-library symbol the consumer's `lib`
 * setting does not include fails to compile in the consumer, with an error that
 * points at the package rather than at the consumer's `tsconfig.json`. The
 * wasm-bindgen declaration for `Rewriter` declares `[Symbol.dispose]()`, so a
 * consumer on the common `lib: ["ES2022", "DOM"]` gets TS2550 ("Property
 * 'dispose' does not exist on type 'SymbolConstructor'") from a file inside the
 * package. `Symbol.dispose` is genuinely part of the shipped API, so the package
 * states the requirement itself instead of leaving it to be discovered: a `lib`
 * reference in a declaration adds that library to the consumer's program.
 *
 * Idempotent, and fails when the host declaration is not there.
 *
 * @param {string} dir base directory the `file` paths are relative to
 * @param {Array<{ file: string, lib: string }>} references
 * @returns {{ added: string[] }}
 */
export function ensureLibReferences(dir, references) {
	const tree = new ExactCaseTree();
	/** @type {string[]} */
	const added = [];
	for (const { file, lib } of references) {
		const target = join(dir, file);
		if (!tree.isFile(target)) {
			throw new Error(
				`declaration lib reference host ${file} is not in ${dir}`,
			);
		}
		const directive = `/// <reference lib="${lib}" />`;
		const source = readFileSync(target, "utf8");
		if (source.includes(directive)) continue;
		writeFileSync(target, `${directive}\n${source}`);
		added.push(`${file} -> lib ${lib}`);
	}
	return { added };
}

/**
 * Fails when any declaration under `dir` still names one of `specifiers`.
 *
 * This is the guard behind the dependency decision: the controller keeps
 * `@mercuryworkshop/rpc` as a build-only devDependency, so a published
 * declaration that still imports it would be uninstallable for a consumer.
 *
 * @param {string} dir
 * @param {string[]} specifiers
 */
export function assertNoSpecifiers(dir, specifiers) {
	const banned = new Set(specifiers);
	/** @type {string[]} */
	const offenders = [];
	for (const file of listDeclarationFiles(dir)) {
		const source = readFileSync(file, "utf8");
		for (const span of findModuleSpecifiers(source)) {
			if (banned.has(span.specifier))
				offenders.push(`${relative(dir, file)}: ${span.specifier}`);
		}
	}
	if (offenders.length) {
		throw new Error(
			`declaration output still names build-only packages:\n  ${offenders.join(
				"\n  ",
			)}`,
		);
	}
}

/**
 * Fails when any declaration under `dir` names a relative specifier without a
 * resolvable extension. Runs after the rewrite as its own check, so an
 * unhandled emit shape is a build failure rather than a broken published type.
 *
 * @param {string} dir
 */
export function assertRelativeSpecifiersResolved(dir) {
	const tree = new ExactCaseTree();
	/** @type {string[]} */
	const offenders = [];
	for (const file of listDeclarationFiles(dir)) {
		const source = readFileSync(file, "utf8");
		for (const span of findModuleSpecifiers(source)) {
			if (!isRelativeSpecifier(span.specifier)) continue;
			if (DECLARATION_NAME.test(span.specifier)) continue;
			if (!RESOLVED_EXTENSION.test(span.specifier)) {
				offenders.push(`${relative(dir, file)}: ${span.specifier}`);
				continue;
			}
			const absolute = resolve(dirname(file), span.specifier).replace(
				/\.(js|mjs|cjs)$/,
				"",
			);
			if (
				!tree.isFile(`${absolute}.d.ts`) &&
				!tree.isFile(`${absolute}.d.mts`) &&
				!tree.isFile(`${absolute}.d.cts`) &&
				!span.specifier.endsWith(".json") &&
				!span.specifier.endsWith(".css")
			) {
				offenders.push(
					`${relative(dir, file)}: ${span.specifier} (no declaration emitted)`,
				);
			}
		}
	}
	if (offenders.length) {
		throw new Error(
			`declaration output has unresolved relative specifiers:\n  ${offenders.join(
				"\n  ",
			)}`,
		);
	}
}
