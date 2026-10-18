import { internalAttributePrefix } from "@/runtime-identity";
import { ScramjetClient } from "@client/index";
import {
	Number,
	Object_keys,
	Reflect_apply,
	Reflect_get,
	Reflect_has,
	Reflect_ownKeys,
	Symbol_iterator,
	String_startsWith,
} from "@/shared/snapshot";

export default function (client: ScramjetClient) {
	client.Trap("Element.prototype.attributes", {
		get(ctx) {
			const map = ctx.get() as NamedNodeMap;
			const proxy = new Proxy(map, {
				get(target, prop, _receiver) {
					const value = Reflect_get(target, prop);
					if (prop === Symbol_iterator && typeof value === "function") {
						return new Proxy(value, {
							apply(target, that, args) {
								if (that !== proxy) return Reflect_apply(target, that, args);
								const iterator = Reflect_apply(
									target,
									map,
									args
								) as Iterator<Attr>;
								const next = Reflect_get(iterator, "next");

								return (function* () {
									while (true) {
										const result = Reflect_apply(
											next,
											iterator,
											[]
										) as IteratorResult<Attr>;
										if (Reflect_get(result, "done")) return;

										const attribute = Reflect_get(result, "value");
										const name = Reflect_get(attribute, "name");
										if (
											typeof name === "string" &&
											!String_startsWith(name, internalAttributePrefix)
										) {
											yield attribute;
										}
									}
								})();
							},
						});
					}

					if (prop === "length") {
						return Object_keys(proxy).length;
					}

					if (prop === "getNamedItem") {
						return (name: string) => proxy[name];
					}
					if (prop === "getNamedItemNS") {
						return (namespace: string, name: string) =>
							proxy[`${namespace}:${name}`];
					}
					if (prop === "item" && typeof value === "function") {
						return new Proxy(value, {
							apply(target, that, args) {
								if (that !== proxy) return Reflect_apply(target, that, args);
								const position = Object_keys(proxy)[args[0] >>> 0];
								return position === undefined
									? null
									: Reflect_get(map, position);
							},
						});
					}

					if (prop in NamedNodeMap.prototype && typeof value === "function") {
						return new Proxy(value, {
							apply(target, that, args) {
								if (that === proxy) {
									return Reflect_apply(target, map, args);
								}

								return Reflect_apply(target, that, args);
							},
						});
					}

					if (
						(typeof prop === "string" || typeof prop === "number") &&
						!isNaN(Number(prop))
					) {
						const position = Object_keys(proxy)[prop];

						return map[position];
					}

					if (!this.has(target, prop)) return undefined;

					return value;
				},
				ownKeys(target) {
					const keys = Reflect_ownKeys(target);

					return keys.filter((key) => this.has(target, key));
				},
				has(target, prop) {
					if (typeof prop === "symbol") return Reflect_has(target, prop);
					if (prop.startsWith(internalAttributePrefix)) return false;
					if (map[prop]?.name?.startsWith(internalAttributePrefix))
						return false;

					return Reflect_has(target, prop);
				},
			});

			return proxy;
		},
	});

	client.Trap(["Attr.prototype.value", "Attr.prototype.nodeValue"], {
		get(ctx) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			if (ctx.this?.ownerElement) {
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				return ctx.this.ownerElement.getAttribute(ctx.this.name);
			}

			return ctx.get();
		},
		set(ctx, value) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			if (ctx.this?.ownerElement) {
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				return ctx.this.ownerElement.setAttribute(ctx.this.name, value);
			}

			return ctx.set(value);
		},
	});
}
