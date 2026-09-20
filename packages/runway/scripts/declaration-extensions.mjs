/**
 * Rewrites TypeScript source extensions in emitted declaration files.
 *
 * Runway's sources import each other with explicit `.ts` extensions, because that
 * is what Node's type stripping requires when the CLI runs from a checkout.
 * `rewriteRelativeImportExtensions` rewrites those specifiers in emitted
 * JavaScript, but not in emitted declarations (microsoft/TypeScript#61037), so
 * `dist/public.d.ts` shipped `from "./testkit.ts"` while the package contains only
 * `testkit.js` and `testkit.d.ts`.
 *
 * `tsc` itself tolerates this — the extension in a declaration import is
 * informational to the compiler, and the TypeScript team treats the omission as
 * acceptable — so this is not a compile failure for consumers. It is still a
 * published file naming a file that is not in the package: tools that resolve
 * declaration specifiers literally rather than by TypeScript's rules lose every
 * symbol behind them, which is the reported breakage in that issue. A published
 * artifact should not describe files it does not contain.
 *
 * The rewrite therefore happens once, over the build's own output, using the same
 * criteria the compiler applies to JavaScript emit: a specifier is rewritten when
 * it starts with `./` or `../`, ends in `.ts`, `.tsx`, `.mts` or `.cts`, and is
 * not itself a declaration file name. Module specifier positions are found with
 * the TypeScript parser — not text patterns — so a string literal type, a comment
 * or a template that happens to look like a path is never touched. And
 * `assertNoSourceExtensions` then fails the build if any relative source specifier
 * survives anywhere in the output — an unhandled syntax is a build failure rather
 * than a broken published type.
 */

import ts from "typescript";

/** Source extension to the extension of the file the package actually contains. */
const EXTENSION_MAP = Object.freeze({
	".ts": ".js",
	".tsx": ".js",
	".mts": ".mjs",
	".cts": ".cjs",
});

/** `./x.d.ts`, `./x.d.mts`, `./x.d.cts` and `./x.d.anything.ts` name declarations. */
const DECLARATION_NAME = /\.d(\.[^./]+)*\.(ts|mts|cts)$/;

/** The rewritten specifier, or `null` when the compiler would not rewrite it. */
export function rewriteSpecifier(specifier) {
	if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
	if (DECLARATION_NAME.test(specifier)) return null;
	for (const [from, to] of Object.entries(EXTENSION_MAP)) {
		if (specifier.endsWith(from)) return `${specifier.slice(0, -from.length)}${to}`;
	}
	return null;
}

/**
 * Every module specifier in a parsed source file, with its exact span.
 *
 * This covers the module syntax `tsc` emits into declarations: static
 * import/export clauses, side-effect imports, `import("…")` types, and
 * `import x = require("…")` / `export = require("…")` forms. Anything else that
 * holds a path-like string — a literal type (`type Path = "./fixture.ts"`), a
 * comment, a template, a computed value — is not a module reference and is never
 * visited. `declare module "./…"` is deliberately absent: it declares a module
 * identity rather than referencing one, and rewriting it would change what the
 * declaration augments.
 *
 * Dynamic `import(…)` expressions and `require(…)` calls are handled only where a
 * string literal is the argument and the shape matches the module forms; other
 * call shapes are left for the caller, whose build guard refuses to ship any
 * surviving source specifier as explicit text.
 */
export function findModuleSpecifiers(sourceText, { scriptKind = ts.ScriptKind.TS } = {}) {
	const sourceFile = ts.createSourceFile(
		"rewrite-check",
		sourceText,
		ts.ScriptTarget.ESNext,
		true,
		// Declarations, JavaScript emit, and plain scripts all parse as TS here.
		// The walker only reads module-specifier nodes, which share their shape
		// across all three; JSDoc `import(…)` types are type positions, not module
		// references, and are deliberately not visited.
		scriptKind
	);
	const found = [];
	const visit = (node) => {
		const take = (literal) => {
			if (literal && ts.isStringLiteralLike(literal)) found.push(literal);
		};
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier
		) {
			take(node.moduleSpecifier);
		} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
			take(node.argument.literal);
		} else if (ts.isImportEqualsDeclaration(node)) {
			const reference = node.moduleReference;
			if (reference && ts.isExternalModuleReference(reference)) take(reference.expression);
		} else if (
			ts.isExportAssignment(node) &&
			node.expression &&
			ts.isExternalModuleReference(node.expression)
		) {
			take(node.expression.expression);
		} else if (
			ts.isCallExpression(node) &&
			node.arguments.length === 1 &&
			((node.expression.kind === ts.SyntaxKind.ImportKeyword &&
				node.arguments[0] &&
				ts.isStringLiteralLike(node.arguments[0])) ||
				(ts.isIdentifier(node.expression) &&
					node.expression.text === "require" &&
					node.arguments[0] &&
					ts.isStringLiteralLike(node.arguments[0])))
		) {
			take(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return found.map((literal) => ({
		specifier: literal.text,
		start: literal.getStart(sourceFile) + 1,
		end: literal.getEnd() - 1,
	}));
}

/**
 * Rewrites every module specifier in one declaration file's text.
 *
 * Returns the new text and the specifiers that changed, so the build can report
 * how much it touched instead of silently editing its own output.
 */
export function rewriteDeclarationExtensions(source) {
	const edits = [];
	for (const span of findModuleSpecifiers(source)) {
		const rewritten = rewriteSpecifier(span.specifier);
		if (rewritten !== null) edits.push({ ...span, to: rewritten });
	}
	edits.sort((left, right) => right.start - left.start);
	let text = source;
	const rewrites = [];
	for (const edit of edits) {
		text = `${text.slice(0, edit.start)}${edit.to}${text.slice(edit.end)}`;
		rewrites.push({ from: edit.specifier, to: edit.to });
	}
	return { text, rewrites: rewrites.reverse() };
}

/**
 * Relative TypeScript-source specifiers left in a file.
 *
 * Only actual module positions are reported: an ordinary literal type or comment
 * that mentions a `.ts` file is not an import and never becomes a build failure.
 * A declaration file naming `.d.ts` explicitly is fine: that file is in the
 * package. Anything else names a source file the package does not ship.
 */
export function findSourceExtensionSpecifiers(source) {
	const found = [];
	for (const span of findModuleSpecifiers(source)) {
		if (DECLARATION_NAME.test(span.specifier)) continue;
		if (rewriteSpecifier(span.specifier) === null) continue;
		found.push(span.specifier);
	}
	return found;
}
