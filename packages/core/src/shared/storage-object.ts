import {
	Number,
	Object_create,
	Reflect_defineProperty,
	Reflect_get,
	Reflect_getOwnPropertyDescriptor,
	Reflect_has,
	Reflect_ownKeys,
	Reflect_set,
	String,
} from "@/shared/snapshot";
import type {
	ScramjetStorageArea,
	ScramjetStorageContext,
	ScramjetStorageType,
} from "@/shared/storage";

/**
 * A Storage object backed only by a {@link ScramjetStorageArea}, for documents with no storage of
 * their own, such as an opaque sandboxed frame whose localStorage getter throws. It behaves like
 * the browser's: methods on Storage.prototype, items as own properties, writes through the area.
 */
export function createStorageObject(
	global: typeof globalThis,
	storageType: ScramjetStorageType,
	backend: ScramjetStorageArea,
	context: () => Omit<ScramjetStorageContext, "storageType">
): Storage {
	const ctx = (): ScramjetStorageContext => ({ ...context(), storageType });
	const target = Object_create(global.Storage?.prototype ?? null) as Storage;
	const methods: Record<string, (...args: any[]) => unknown> = {
		getItem(key: string) {
			if (!arguments.length) throw new TypeError("Storage getItem requires a key");
			return backend.getItem(ctx(), String(key));
		},
		setItem(key: string, value: string) {
			if (arguments.length < 2)
				throw new TypeError("Storage setItem requires a key and value");
			backend.setItem(ctx(), String(key), String(value));
		},
		removeItem(key: string) {
			if (!arguments.length) throw new TypeError("Storage removeItem requires a key");
			backend.removeItem(ctx(), String(key));
		},
		clear() {
			backend.clear(ctx());
		},
		key(index: number) {
			if (!arguments.length) throw new TypeError("Storage key requires an index");
			return backend.key(ctx(), Number(index) >>> 0);
		},
	};
	const own = (prop: PropertyKey) =>
		typeof prop === "string" && !(prop in methods) && prop !== "length";
	return new Proxy(target, {
		get(object, prop) {
			if (prop === "length") return backend.length(ctx());
			if (typeof prop === "string" && prop in methods) return methods[prop];
			if (typeof prop === "symbol" || Reflect_has(object, prop))
				return Reflect_get(object, prop);
			return backend.getItem(ctx(), prop) ?? undefined;
		},
		set(object, prop, value) {
			if (!own(prop)) return Reflect_set(object, prop, value);
			backend.setItem(ctx(), String(prop), String(value));
			return true;
		},
		deleteProperty(_object, prop) {
			if (own(prop)) backend.removeItem(ctx(), String(prop));
			return true;
		},
		has(object, prop) {
			if (own(prop) && backend.getItem(ctx(), String(prop)) !== null) return true;
			return Reflect_has(object, prop);
		},
		ownKeys(object) {
			return [...(backend.keys?.(ctx()) ?? []), ...Reflect_ownKeys(object)];
		},
		getOwnPropertyDescriptor(object, prop) {
			if (own(prop)) {
				const value = backend.getItem(ctx(), String(prop));
				if (value !== null)
					return { value, enumerable: true, configurable: true, writable: true };
			}
			return Reflect_getOwnPropertyDescriptor(object, prop);
		},
		defineProperty(object, prop, attributes) {
			if (!own(prop)) return Reflect_defineProperty(object, prop, attributes);
			backend.setItem(ctx(), String(prop), String(attributes.value ?? ""));
			return true;
		},
	});
}
