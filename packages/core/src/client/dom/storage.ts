import { ScramjetClient } from "@client/index";
import {
	Number,
	Object_keys,
	Reflect_defineProperty,
	Reflect_get,
	Reflect_getOwnPropertyDescriptor,
	Reflect_set,
	String,
} from "@/shared/snapshot";
import type {
	ScramjetStorageArea,
	ScramjetStorageType,
} from "@/shared/storage";

export default function (client: ScramjetClient, self: Self) {
	function prefixedKey(key: string) {
		return client.url.host + "@" + key;
	}

	function prefixedKeys(target: Storage) {
		return Object_keys(target).filter((key) => key.startsWith(client.url.host));
	}

	function storageContext(storageType: ScramjetStorageType) {
		const url = client.url;
		return { url, origin: url.origin, storageType };
	}

	function createHandler(
		storageType: ScramjetStorageType,
		backend: ScramjetStorageArea | undefined
	): ProxyHandler<Storage> {
		return {
			get(target, prop) {
				const context = storageContext(storageType);
				switch (prop) {
					case "getItem":
						return (key: string) =>
							backend
								? backend.getItem(context, String(key))
								: target.getItem(prefixedKey(String(key)));
					case "setItem":
						return (key: string, val: string) => {
							if (backend) {
								backend.setItem(context, String(key), String(val));
								return undefined;
							}
							return target.setItem(prefixedKey(String(key)), String(val));
						};
					case "removeItem":
						return (key: string) => {
							if (backend) {
								backend.removeItem(context, String(key));
								return undefined;
							}
							return target.removeItem(prefixedKey(String(key)));
						};
					case "clear":
						return () => {
							if (backend) backend.clear(context);
							else for (const key of prefixedKeys(target)) target.removeItem(key);
							return undefined;
						};
					case "key":
						return (index: number) => {
							if (backend) return backend.key(context, Number(index));
							const key = prefixedKeys(target)[Number(index)];
							return typeof key === "string"
								? key.substring(client.url.host.length + 1)
								: null;
						};
					case "length":
						return backend
							? backend.length(context)
							: prefixedKeys(target).length;
					default:
						if (prop in self.Object.prototype || typeof prop === "symbol") {
							return Reflect_get(target, prop);
						}
						return backend
							? backend.getItem(context, String(prop))
							: target.getItem(prefixedKey(String(prop)));
				}
			},
			set(target, prop, val) {
				if (typeof prop === "symbol") return Reflect_set(target, prop, val);
				const context = storageContext(storageType);
				if (backend) backend.setItem(context, String(prop), String(val));
				else target.setItem(prefixedKey(String(prop)), String(val));
				return true;
			},
			has(target, prop) {
				if (typeof prop === "symbol") return prop in target;
				const context = storageContext(storageType);
				return backend
					? backend.getItem(context, String(prop)) !== null
					: target.getItem(prefixedKey(String(prop))) !== null;
			},
			ownKeys(target) {
				if (backend) return backend.keys?.(storageContext(storageType)) ?? [];
				return prefixedKeys(target).map((key) =>
					key.substring(client.url.host.length + 1)
				);
			},
			getOwnPropertyDescriptor(target, property) {
				if (typeof property === "symbol") {
					return Reflect_getOwnPropertyDescriptor(target, property);
				}
				const context = storageContext(storageType);
				const val = backend
					? backend.getItem(context, String(property))
					: target.getItem(prefixedKey(String(property)));
				if (val === null) return undefined;
				return {
					value: val,
					enumerable: true,
					configurable: true,
					writable: true,
				};
			},
			defineProperty(target, property, attributes) {
				if (typeof property === "symbol") {
					return Reflect_defineProperty(target, property, attributes);
				}
				const val = String(attributes.value ?? "");
				if (backend) {
					backend.setItem(storageContext(storageType), String(property), val);
				} else {
					target.setItem(prefixedKey(String(property)), val);
				}
				return true;
			},
		};
	}

	const localStorageProxy = new Proxy(
		self.localStorage,
		createHandler("localStorage", client.context.storage?.localStorage)
	);
	const sessionStorageProxy = new Proxy(
		self.sessionStorage,
		createHandler("sessionStorage", client.context.storage?.sessionStorage)
	);
	delete self.localStorage;
	delete self.sessionStorage;
	self.localStorage = localStorageProxy;
	self.sessionStorage = sessionStorageProxy;
}
