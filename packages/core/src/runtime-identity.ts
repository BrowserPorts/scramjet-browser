import {
	Number_parseInt,
	Number_toString,
	String_charCodeAt,
	String_fromCharCode,
	String_slice,
	String_startsWith
} from "./shared/snapshot";
import { IDENTITY_NAMES, type IdentityName } from "./runtime-identity-names";

declare const SCRAMJET_IDENTITY_NAMES:
	| Readonly<Record<IdentityName, string>>
	| undefined;
declare const SCRAMJET_ATTRIBUTE_KEY: readonly number[] | undefined;

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
const attributeKey =
	typeof SCRAMJET_ATTRIBUTE_KEY === "undefined"
		? undefined
		: SCRAMJET_ATTRIBUTE_KEY;

/**
 * The physical name of one of Scramjet's own names: the logical name itself in
 * a build without a table, the host's name for it in one with. A bundle the
 * host configures at run time, such as a frame's minimal client, is handed the
 * host's table instead of carrying one
 */
export function identityName(
	value: IdentityName,
	table: Readonly<Record<IdentityName, string>> | undefined = names
): string {
	if (!table) return value;
	if (!Object.prototype.hasOwnProperty.call(table, value))
		throw new TypeError(`The build gave Scramjet no name for ${value}`);

	return table[value];
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
	clientId: keyedBuild
		? identityName("$scramjet$data") + "i"
		: "$scramjet$clientid"
};

const mirrorPrefix = internalAttributePrefix + "-";

/** XOR each UTF-16 unit so even custom attribute names round-trip exactly. */
function attributeSuffix(name: string): string {
	if (!attributeKey) return name;
	let result = "";
	for (let index = 0; index < name.length; index++) {
		const code =
			String_charCodeAt(name, index) ^
			(attributeKey[(index * 2) % attributeKey.length] << 8) ^
			attributeKey[(index * 2 + 1) % attributeKey.length];
		result += String_slice("000" + Number_toString(code, 16), -4);
	}
	return result;
}

export function internalMirrorAttribute(name: string): string {
	return mirrorPrefix + attributeSuffix(name);
}

export function logicalMirrorAttribute(name: string): string | null {
	if (!String_startsWith(name, mirrorPrefix)) return null;
	const suffix = String_slice(name, mirrorPrefix.length);
	if (!attributeKey) return suffix;
	if (suffix.length % 4 !== 0) return null;
	let result = "";
	for (let offset = 0; offset < suffix.length; offset += 4) {
		const hex = String_slice(suffix, offset, offset + 4);
		const code = Number_parseInt(hex, 16);
		if (String_slice("000" + Number_toString(code, 16), -4) !== hex)
			return null;
		const index = offset / 2;
		result += String_fromCharCode(
			code ^
				(attributeKey[index % attributeKey.length] << 8) ^
				attributeKey[(index + 1) % attributeKey.length]
		);
	}
	return result;
}

export const scriptSourceAttribute =
	internalAttributePrefix + "_" + attributeSuffix("script-source");

export const runtimeIdentity = {
	runtimeNamespace,
	controllerNamespace,
	wasmNamespace,
	injectedAttribute,
	internalAttributePrefix,
};
