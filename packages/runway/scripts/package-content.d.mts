/**
 * Types for the tarball-contents rules in the adjacent JavaScript module.
 *
 * The implementation stays plain `.mjs` so `check-package.mjs` runs it with no
 * build step, and the tests import these types here.
 */
export declare type ForbiddenTarballRule = {
	readonly label: string;
	readonly pattern: RegExp;
	readonly allow?: RegExp;
};

export declare const FORBIDDEN_TARBALL_PATHS: readonly ForbiddenTarballRule[];

export declare function findForbiddenTarballPaths(entries: readonly string[]): string[];
