/**
 * Types for the declaration rewriter in the adjacent JavaScript module.
 *
 * The implementation stays plain `.mjs` so it runs with no build step, and the
 * tests import these types here.
 */
export declare type SpecifierRewrite = {
	readonly from: string;
	readonly to: string;
};

export declare type ModuleSpecifierSpan = {
	readonly specifier: string;
	readonly start: number;
	readonly end: number;
};

export declare function findModuleSpecifiers(
	sourceText: string,
	options?: { readonly scriptKind?: number }
): ModuleSpecifierSpan[];

export declare function rewriteSpecifier(specifier: string): string | null;

export declare type DeclarationRewrite = {
	readonly text: string;
	readonly rewrites: readonly SpecifierRewrite[];
};

export declare function rewriteDeclarationExtensions(source: string): DeclarationRewrite;
export declare function findSourceExtensionSpecifiers(source: string): string[];
