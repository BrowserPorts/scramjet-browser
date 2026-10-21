import { TextEncoder_encode, TextDecoder_decode } from "./shared/snapshot";

declare const SCRAMJET_IDENTITY_KEY: readonly number[] | undefined;

// The build injects the same key used by the host's obfuscation plugins
const key =
	typeof SCRAMJET_IDENTITY_KEY === "undefined"
		? undefined
		: SCRAMJET_IDENTITY_KEY;
if (
	key &&
	(key.length !== 32 ||
		key.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))
)
	throw new TypeError("Invalid Scramjet identity key");

export function identityName(
	value: string,
	identityKey: readonly number[] | undefined = key
): string {
	if (!identityKey) return value;
	if (
		identityKey.length !== 32 ||
		identityKey.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
	)
		throw new TypeError("Invalid Scramjet identity key");
	const bytes = TextEncoder_encode(value);
	let result = "_";
	for (let index = 0; index < bytes.length; index++)
		result += (bytes[index] ^ identityKey[index % identityKey.length])
			.toString(16)
			.padStart(2, "0");
	return result;
}

function logicalIdentity(value: string): string {
	if (!key) return value;
	if (!value.startsWith("_") || value.length % 2 !== 1)
		throw new TypeError("Invalid internal attribute name");
	const bytes = new Uint8Array((value.length - 1) / 2);
	for (let index = 0; index < bytes.length; index++) {
		const pair = value.slice(index * 2 + 1, index * 2 + 3);
		const byte = Number.parseInt(pair, 16);
		if (!Number.isFinite(byte) || byte.toString(16).padStart(2, "0") !== pair)
			throw new TypeError("Invalid internal attribute name");
		bytes[index] = byte ^ key[index % key.length];
	}
	return TextDecoder_decode(bytes) as string;
}

export const internalAttributePrefix = key
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
};

export function internalAttribute(name: string): string {
	return internalAttributePrefix + identityName(name);
}

export function logicalAttribute(name: string): string | null {
	if (!name.startsWith(internalAttributePrefix)) return null;
	try {
		return logicalIdentity(name.slice(internalAttributePrefix.length));
	} catch {
		return null;
	}
}

export const runtimeIdentity = {
	runtimeNamespace,
	controllerNamespace,
	wasmNamespace,
	injectedAttribute,
};
