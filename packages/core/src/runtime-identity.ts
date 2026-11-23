import { IDENTITY_NAMES, type IdentityName } from "./runtime-identity-names";

declare const SCRAMJET_IDENTITY_NAMES:
	| Readonly<Record<IdentityName, string>>
	| undefined;

/**
 * A keyed build gives every name in `IDENTITY_NAMES` a physical name, which
 * the host derives under a secret this build never sees and hands over as a
 * table at build time. Nothing here derives one: a name a page could compute
 * from what it holds would be the same on every site a guess was tried on.
 *
 * Read once, while the bundle evaluates, with the plain globals: nothing a page
 * runs can come before it.
 */
const names =
	typeof SCRAMJET_IDENTITY_NAMES === "undefined"
		? undefined
		: SCRAMJET_IDENTITY_NAMES;
if (names) {
	for (let i = 0; i < IDENTITY_NAMES.length; i++) {
		if (!Object.prototype.hasOwnProperty.call(names, IDENTITY_NAMES[i]))
			throw new TypeError(
				`The build gave Scramjet no name for ${IDENTITY_NAMES[i]}`
			);
	}
}

/** Whether this bundle was built with a host's name table. */
export const keyedBuild = names !== undefined;

/**
 * The physical name of one of Scramjet's own names: the logical name itself in
 * a build without a table, the host's name for it in one with.
 */
export function identityName(value: IdentityName): string {
	if (!names) return value;

	return names[value];
}

/**
 * The prefix every attribute of Scramjet's own starts with. A keyed build
 * spells it with the host's name, so a page that has not been given the table
 * cannot select, read or strip one by name.
 */
export const internalAttributePrefix = identityName("scramjet-attr");
/** Marks the scripts the HTML rewriter injects. */
export const injectedAttribute = identityName("scramjet-injected");
/** The global the core bundle assigns itself to. */
export const runtimeNamespace = identityName("$scramjet");
/** The global the controller bundle assigns itself to. */
export const controllerNamespace = identityName("$scramjetController");
/** Where the virtual wasm payload leaves the rewriter's bytes. */
export const wasmNamespace = identityName("WASM");
/** The fields a message scramjet sends between its own realms carries. */
export const messageFields = {
	type: identityName("$scramjet$messagetype"),
	origin: identityName("$scramjet$origin"),
	data: identityName("$scramjet$data"),
	target: identityName("$scramjet$target"),
};

export const runtimeIdentity = {
	runtimeNamespace,
	controllerNamespace,
	wasmNamespace,
	injectedAttribute,
	internalAttributePrefix,
};
