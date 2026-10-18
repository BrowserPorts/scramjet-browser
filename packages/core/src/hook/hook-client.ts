import { getOwnPropertyDescriptorHandler } from "@client/helpers";
import type { ProxyCtx, ProxyHooks, TrapCtx, TrapHooks } from "@/minimal/types";
import {
	Array_isArray,
	Object_defineProperty,
	Object_getOwnPropertyDescriptor,
	Reflect_apply,
	Reflect_construct,
	Reflect_get,
	Reflect_has,
} from "@/shared/snapshot";

const NativeWeakMap = globalThis.WeakMap;

/**
 * Scramjet's hooking: `Proxy` wraps a function on a global path, `Trap` replaces an accessor, and
 * both keep the original in `natives` and `descriptors` so modules can call through. A hooked
 * function keeps its own descriptor, its name, length and prototype, so a page cannot tell it was
 * replaced by reflecting on it, and `unproxy` maps each wrapper back to the native it wraps.
 */
export class HookClient {
	natives: Record<string, any> = {};
	descriptors: Record<string, PropertyDescriptor | undefined> = {};
	/** Each wrapper this client installed, to the native function it wraps */
	unproxy = new NativeWeakMap<object, any>();

	constructor(public global: typeof globalThis) {}

	Proxy(name: string | readonly string[], handler: ProxyHooks): void {
		if (Array_isArray(name)) {
			for (const each of name) this.Proxy(each, handler);
			return;
		}
		const split = (name as string).split(".");
		const prop = split.pop();
		const target = split.reduce(
			(object, key) => object?.[key],
			this.global as any
		);
		if (!target || !prop) return;
		if (!((name as string) in this.natives))
			this.natives[name as string] = Reflect_get(target, prop);
		this.RawProxy(target, prop, handler);
	}

	RawProxy(target: any, prop: string, handler: ProxyHooks) {
		if (!target || !prop || !Reflect_has(target, prop)) return;
		const value = Reflect_get(target, prop);
		if (typeof value !== "function") return;
		const descriptor = Object_getOwnPropertyDescriptor(target, prop);
		const traps: ProxyHandler<any> = {
			getOwnPropertyDescriptor: getOwnPropertyDescriptorHandler,
		};
		if (handler.construct)
			traps.construct = (fn: any, args: any[], newTarget: any) => {
				let result: any;
				let early = false;
				const ctx: ProxyCtx = {
					fn,
					this: null,
					args,
					newTarget,
					return: (value: any) => {
						early = true;
						result = value;
					},
					call: () => {
						early = true;
						result = Reflect_construct(ctx.fn, ctx.args, ctx.newTarget);
						return result;
					},
				};
				handler.construct!(ctx);
				return early
					? result
					: Reflect_construct(ctx.fn, ctx.args, ctx.newTarget);
			};
		if (handler.apply)
			traps.apply = (fn: any, that: any, args: any[]) => {
				let result: any;
				let early = false;
				const ctx: ProxyCtx = {
					fn,
					this: that,
					args,
					newTarget: null,
					return: (value: any) => {
						early = true;
						result = value;
					},
					call: () => {
						early = true;
						result = Reflect_apply(ctx.fn, ctx.this, ctx.args);
						return result;
					},
				};
				handler.apply!(ctx);
				return early ? result : Reflect_apply(ctx.fn, ctx.this, ctx.args);
			};
		const proxy = new Proxy(value, traps);
		this.unproxy.set(proxy, value);
		delete target[prop];
		Object_defineProperty(target, prop, {
			value: proxy,
			writable: descriptor?.writable ?? true,
			enumerable: descriptor?.enumerable ?? false,
			configurable: descriptor?.configurable ?? true,
		});
	}

	Trap(name: string | readonly string[], descriptor: TrapHooks): void {
		if (Array_isArray(name)) {
			for (const each of name) this.Trap(each, descriptor);
			return;
		}
		const split = (name as string).split(".");
		const prop = split.pop();
		const target = split.reduce(
			(object, key) => object?.[key],
			this.global as any
		);
		if (!target || !prop) return;
		this.descriptors[name as string] = Object_getOwnPropertyDescriptor(
			target,
			prop
		);
		this.RawTrap(target, prop, descriptor);
	}

	RawTrap(target: any, prop: string, descriptor: TrapHooks) {
		if (!target || !prop || !Reflect_has(target, prop)) return;
		const old = Object_getOwnPropertyDescriptor(target, prop);
		const context = (that: any): TrapCtx => ({
			this: that,
			get: () => old?.get?.call(that),
			set: (value: any) => old?.set?.call(that, value),
		});
		delete target[prop];
		const next: PropertyDescriptor = {
			enumerable: descriptor.enumerable ?? old?.enumerable ?? false,
			configurable: descriptor.configurable ?? old?.configurable ?? true,
		};
		if (descriptor.get)
			next.get = this.#accessor(old?.get, function (this: any) {
				return descriptor.get!(context(this));
			});
		else if (old?.get) next.get = old.get;
		if (descriptor.set)
			next.set = this.#accessor(old?.set, function (this: any, value: any) {
				descriptor.set!(context(this), value);
			});
		else if (old?.set) next.set = old.set;
		Object_defineProperty(target, prop, next);
	}

	/**
	 * A replacement accessor that is the native one to anything reflecting on it: a Proxy of the
	 * native keeps its name, length and missing prototype, and toString answers for the native.
	 */
	#accessor(native: ((...args: any[]) => any) | undefined, implementation: (...args: any[]) => any) {
		if (typeof native !== "function") return implementation;
		const proxy = new Proxy(native, {
			apply: (_target, that, args) => Reflect_apply(implementation, that, args),
			getOwnPropertyDescriptor: getOwnPropertyDescriptorHandler,
		});
		this.unproxy.set(proxy, native);
		return proxy;
	}

	/**
	 * Makes Function.prototype.toString answer for the native behind every function this client
	 * replaced, itself included. A callable Proxy otherwise prints without its name, which a page can
	 * compare against the native's.
	 */
	maskToString() {
		const unproxy = this.unproxy;
		this.Proxy("Function.prototype.toString", {
			apply(ctx) {
				const native = unproxy.get(ctx.this);
				if (native !== undefined) ctx.this = native;
			},
		});
	}

	/** Calls the native function a module replaced */
	native<T = any>(name: string, that: unknown, ...args: unknown[]): T {
		return Reflect_apply(this.natives[name], that, args);
	}
}
