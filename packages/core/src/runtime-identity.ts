import {
	Number,
	Number_parseInt,
	Object_hasOwn,
	TextEncoder_encode,
	TextDecoder_decode,
} from "./shared/snapshot";
import { IDENTITY_NAMES, type IdentityName } from "./runtime-identity-names";

declare const SCRAMJET_IDENTITY_NAMES:
	| Readonly<Record<IdentityName, string>>
	| undefined;
declare const SCRAMJET_ATTRIBUTE_KEY: readonly number[] | undefined;

/**
 * A keyed build gives every name in `IDENTITY_NAMES` a physical name, which the host derives under a
 * secret this build never sees and hands over as a table. Nothing here derives one: a name a page
 * could compute from what it holds would be the same on every site a guess was tried on
 */
const names =
	typeof SCRAMJET_IDENTITY_NAMES === "undefined"
		? undefined
		: SCRAMJET_IDENTITY_NAMES;
if (names)
	for (const logical of IDENTITY_NAMES)
		if (!Object_hasOwn(names, logical))
			throw new TypeError(`The build gave Scramjet no name for ${logical}`);

/**
 * The key internal attribute names are encoded under. The rewriter that writes such an attribute and
 * the realm that reads its logical name back can be different realms with no table in common, so the
 * encoding has to be one both can reverse. The host derives this key for one identity under its
 * secret, apart from every other key, so it decodes these attributes and nothing else
 */
const attributeKey =
	typeof SCRAMJET_ATTRIBUTE_KEY === "undefined" ? undefined : SCRAMJET_ATTRIBUTE_KEY;
if ((names === undefined) !== (attributeKey === undefined))
	throw new TypeError("A keyed Scramjet build needs both its name table and its attribute key");
if (
	attributeKey &&
	(attributeKey.length !== 32 ||
		attributeKey.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
)
	throw new TypeError("Invalid Scramjet attribute key");

/**
 * The physical name of one of Scramjet's own names. A bundle built without a table keeps the logical
 * names, and a bundle the host configures at run time, such as a frame's minimal client, is handed
 * the host's table instead
 */
export function identityName(
	value: IdentityName,
	table: Readonly<Record<IdentityName, string>> | undefined = names
): string {
	if (!table) return value;
	if (!Object_hasOwn(table, value))
		throw new TypeError(`The build gave Scramjet no name for ${value}`);
	return table[value];
}

function encodeAttribute(value: string, key: readonly number[]): string {
	const bytes = TextEncoder_encode(value);
	let result = "";
	for (let index = 0; index < bytes.length; index++)
		result += (bytes[index] ^ key[index % key.length])
			.toString(16)
			.padStart(2, "0");
	return result;
}

/** Null for a name this key did not encode */
function decodeAttribute(value: string, key: readonly number[]): string | null {
	if (value.length % 2 !== 0) return null;
	const bytes = new Uint8Array(value.length / 2);
	for (let index = 0; index < bytes.length; index++) {
		const pair = value.slice(index * 2, index * 2 + 2);
		const byte = Number_parseInt(pair, 16);
		if (!Number.isFinite(byte) || byte.toString(16).padStart(2, "0") !== pair)
			return null;
		bytes[index] = byte ^ key[index % key.length];
	}
	return TextDecoder_decode(bytes) as string;
}

export const internalAttributePrefix = names
	? identityName("scramjet-attr-") + "-"
	: "scramjet-attr-";
export const injectedAttribute = identityName("scramjet-injected");
export const runtimeNamespace = identityName("$scramjet");
export const controllerNamespace = identityName("$scramjetController");
export const wasmNamespace = identityName("WASM");
export const messageFields = {
	workerTransport: identityName("$scramjet$workerTransport"),
	type: identityName("$scramjet$messagetype"),
	origin: identityName("$scramjet$origin"),
	data: identityName("$scramjet$data"),
	source: identityName("$scramjet$source"),
};

export function internalAttribute(name: string): string {
	return (
		internalAttributePrefix +
		(attributeKey ? encodeAttribute(name, attributeKey) : name)
	);
}

export function logicalAttribute(name: string): string | null {
	if (!name.startsWith(internalAttributePrefix)) return null;
	const encoded = name.slice(internalAttributePrefix.length);
	return attributeKey ? decodeAttribute(encoded, attributeKey) : encoded;
}

export const runtimeIdentity = {
	runtimeNamespace,
	controllerNamespace,
	wasmNamespace,
	injectedAttribute,
};
