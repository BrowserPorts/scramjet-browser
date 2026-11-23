import {
	JSON_stringify,
	Object_defineProperty,
	Object_setPrototypeOf,
	Reflect_apply,
	Reflect_construct,
	Reflect_get,
	URL_createObjectURL,
} from "@/shared/snapshot";

// Captured when the bundle loads, which is before any of the page's own scripts can replace them
export const NativeURL = globalThis.URL;
export const NativeMap = globalThis.Map;
export const NativeSet = globalThis.Set;
export const NativeWeakMap = globalThis.WeakMap;
export const NativeWeakSet = globalThis.WeakSet;

/** Built-ins captured before page scripts run, for hooks that must not see a page's replacements */
export const natives = {
	JSON_stringify,
	Object_defineProperty,
	Object_setPrototypeOf,
	Reflect_apply,
	Reflect_construct,
	Reflect_get,
	URL_createObjectURL,
};
