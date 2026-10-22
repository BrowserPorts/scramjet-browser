import { getScriptBlockTypeString } from "@/shared/mime";
import { Object_getOwnPropertyDescriptor } from "@/shared/snapshot";
import type { ScramjetClient } from "@client/index";

export function getOwnPropertyDescriptorHandler(target, prop) {
	const realDescriptor = Object_getOwnPropertyDescriptor(target, prop);

	return realDescriptor;
}

/** What a script element's `type` and `language` make it, read without the page's masking */
export function scriptBlockTypeForElement(
	client: ScramjetClient,
	element: Element
): string {
	const hasType = client.natives.call(
		"Element.prototype.hasAttribute",
		element,
		"type"
	) as boolean;
	const hasLanguage = client.natives.call(
		"Element.prototype.hasAttribute",
		element,
		"language"
	) as boolean;
	const type = hasType
		? (client.natives.call(
				"Element.prototype.getAttribute",
				element,
				"type"
			) as string | null)
		: null;
	const language = hasLanguage
		? (client.natives.call(
				"Element.prototype.getAttribute",
				element,
				"language"
			) as string | null)
		: null;
	return getScriptBlockTypeString(type, language, hasType, hasLanguage);
}
