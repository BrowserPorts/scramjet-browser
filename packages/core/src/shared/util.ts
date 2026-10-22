import {
	Array_from,
	atob,
	btoa,
	String_charCodeAt,
	String_fromCharCode,
	String_fromCodePoint,
	TextDecoder_decodeKeepingBom,
	TextEncoder_encode,
} from "@/shared/snapshot";

function bytesToBase64Fallback(bytes: Uint8Array): string {
	const binString = Array_from(bytes, (byte) =>
		String_fromCodePoint(byte)
	).join("");

	return btoa(binString);
}

const bytesToBase64Native: ((this: Uint8Array) => string) | undefined = (
	Uint8Array.prototype as any
).toBase64;

export const bytesToBase64: (bytes: Uint8Array) => string =
	typeof bytesToBase64Native === "function"
		? (bytes) => bytesToBase64Native.call(bytes)
		: bytesToBase64Fallback;

export function base64Encode(text: string) {
	return btoa(
		TextEncoder_encode(text)
			.reduce(
				(data, byte) => (data.push(String_fromCharCode(byte)), data),
				[] as any
			)
			.join("")
	);
}

/**
 * The text `bytesToBase64(TextEncoder_encode(text))` was made from.
 *
 * `atob` alone answers the bytes as Latin-1 characters, so a page's non-ASCII
 * script text would read back as mojibake.
 */
export function base64ToText(base64: string): string {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = String_charCodeAt(binary, i);
	return TextDecoder_decodeKeepingBom(bytes);
}
