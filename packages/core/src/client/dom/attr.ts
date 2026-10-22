import { internalAttribute, internalAttributePrefix } from "@/runtime-identity";
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
			// The getter above only answers for a real element
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			const element = ctx.this as Element;
			// The nonce Scramjet stamped on a script is not an attribute the page sees,
			// unless the page gave the element one of its own
			const stamped = (name: unknown): boolean =>
				client.realm !== null &&
				typeof name === "string" &&
				name.toLowerCase() === "nonce" &&
				!client.natives.call(
					"Element.prototype.hasAttribute",
					element,
					internalAttribute("nonce")
				);
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
											!String_startsWith(name, internalAttributePrefix) &&
											!stamped(name)
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

					// An attribute added through the map takes the same path as one added by the
					// element, so its nonce and its handler source are kept the same way
					if (prop === "setNamedItem" || prop === "setNamedItemNS") {
						const method =
							prop === "setNamedItem" ? "setAttributeNode" : "setAttributeNodeNS";
						return (attr: Attr) =>
							Reflect_apply(
								Reflect_get(Element.prototype, method),
								element,
								[attr]
							);
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
					if (stamped(prop) || stamped(map[prop]?.name)) return false;

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

			// An attribute node that is not on an element yet can still be named for a handler,
			// and a document that requires trusted script takes only trusted text for one
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			if (client.realm?.isHandlerAttribute(String(ctx.this?.name))) {
				return ctx.set(client.realm.trusted(String(value)));
			}

			return ctx.set(value);
		},
	});
}
