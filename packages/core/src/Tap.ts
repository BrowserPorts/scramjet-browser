import {
	Array_includes,
	Array_map,
	Object_create,
	Promise_all,
	drain,
} from "@/shared/snapshot";

type Description = {
	context?: object;
	props?: object;
};

type Callback<T extends Description> = (
	context: T["context"],
	props: T["props"]
) => void | Promise<void>;

export type TapOrder = {
	/** Run before these plugins. */
	before?: readonly string[];
	/** Run after these plugins. */
	after?: readonly string[];
};

type CallbackInfo<T extends Description> = {
	callback: Callback<T>;
	plugin: Plugin;
	order: TapOrder;
};

type InternalHookDescription = {
	tap: TapInternal;
	key: string;
};

type TapInternal = {
	callbacks: Record<string, CallbackInfo<Description>[]>;
};

export type TapInstance<T extends Record<string, Description>> = {
	[K in keyof T]: T[K] & InternalHookDescription;
};

function mergeTapOrder(plugin: Plugin, order?: TapOrder): TapOrder {
	return {
		before: order?.before ?? plugin.tapOrder.before,
		after: order?.after ?? plugin.tapOrder.after,
	};
}

/**
 * Order `callbacks` so each runs after the plugins it names in `after`, and
 * before the ones it names in `before`.
 *
 * Dispatch happens in the page realm - every navigation and `pushState` goes
 * through here - so this sticks to `drain` and indexed writes: `for...of`,
 * spread and the `Array.prototype` methods all reach intrinsics the page can
 * replace, and with them which hooks run, in what order.
 */
function sortCallbacks<T extends Description>(
	callbacks: CallbackInfo<T>[]
): CallbackInfo<T>[] {
	const afters: Record<string, string[]> = Object_create(null);
	const addAfter = (plugin: string, after: string) => {
		const list = (afters[plugin] ??= []);
		if (!Array_includes(list, after)) list[list.length] = after;
	};
	for (const callback of drain(callbacks)) {
		if (callback.order.before) {
			for (const before of drain(callback.order.before)) {
				addAfter(before, callback.plugin.name);
			}
		}
		if (callback.order.after) {
			for (const after of drain(callback.order.after)) {
				addAfter(callback.plugin.name, after);
			}
		}
	}

	const byName = (name: string) => {
		for (const callback of drain(callbacks)) {
			if (callback.plugin.name === name) return callback;
		}

		return undefined;
	};

	const sorted: CallbackInfo<T>[] = [];
	// the chain of plugins being placed, innermost last
	const visiting: string[] = [];
	function recurse(callback: CallbackInfo<T>) {
		const name = callback.plugin.name;
		if (afters[name]) {
			visiting[visiting.length] = name;
			for (const after of drain(afters[name])) {
				if (Array_includes(visiting, after)) {
					throw `Circular dependency detected: ${name} -> ${after}. Using append order.`;
				}
				const afterCallback = byName(after);
				if (afterCallback) recurse(afterCallback);
			}
			visiting.length--;
		}
		if (!Array_includes(sorted, callback)) sorted[sorted.length] = callback;
	}

	try {
		for (const callback of drain(callbacks)) {
			recurse(callback);
		}
		return sorted;
	} catch (err) {
		dbg.error("an error occurred:", err);
		return sorted;
	}
}

/**
 * The order a transform hook runs in: each plugin's callbacks together, after
 * every plugin it names in `after` and before every plugin that names it in
 * `before`. Unlike `sortCallbacks` a cycle is an error, not a fallback to
 * append order: a transform that runs on the wrong side of the one it depends
 * on produces wrong output rather than a late notification.
 */
function orderTransforms<T extends Description>(
	callbacks: CallbackInfo<T>[]
): CallbackInfo<T>[] {
	const names: string[] = [];
	const groups: Record<string, CallbackInfo<T>[]> = Object_create(null);
	const dependencies: Record<string, string[]> = Object_create(null);
	const depend = (name: string, on: string) => {
		const list = (dependencies[name] ??= []);
		if (!Array_includes(list, on)) list[list.length] = on;
	};
	for (const callback of drain(callbacks)) {
		const name = callback.plugin.name;
		let group = groups[name];
		if (!group) {
			group = groups[name] = [];
			names[names.length] = name;
		}
		group[group.length] = callback;
		dependencies[name] ??= [];
		if (callback.order.after) {
			for (const after of drain(callback.order.after)) depend(name, after);
		}
		if (callback.order.before) {
			for (const before of drain(callback.order.before)) depend(before, name);
		}
	}

	const completed: string[] = [];
	const visiting: string[] = [];
	const result: CallbackInfo<T>[] = [];
	const visit = (name: string) => {
		if (Array_includes(completed, name) || !groups[name]) return;
		if (Array_includes(visiting, name))
			throw new Error(`Circular transform dependency at plugin ${name}`);
		visiting[visiting.length] = name;
		for (const dependency of drain(dependencies[name] ?? [])) visit(dependency);
		visiting.length--;
		completed[completed.length] = name;
		for (const callback of drain(groups[name])) result[result.length] = callback;
	};
	for (const name of drain(names)) visit(name);

	return result;
}

export class Plugin {
	constructor(
		public name: string,
		public readonly tapOrder: TapOrder = {}
	) {}

	tap<T extends Description>(
		hook: T,
		callback: Callback<T>,
		order?: TapOrder
	): void {
		Tap.tap(hook, callback, this, mergeTapOrder(this, order));
	}
}

export class Tap {
	/**
	 * Runs a transform hook's callbacks one after another, each seeing the
	 * result the one before it left in `props`.
	 */
	static async dispatchSeries<T extends Description>(
		hook: T,
		context: T["context"],
		props: T["props"]
	): Promise<void> {
		const internal = hook as unknown as InternalHookDescription;
		const callbacks = internal.tap.callbacks[internal.key];
		if (!callbacks || callbacks.length === 0) return;

		for (const callback of drain(
			orderTransforms(callbacks as CallbackInfo<T>[])
		)) {
			await callback.callback(context, props);
		}
	}

	/**
	 * Runs a transform hook's callbacks in order, for the rewriters that have
	 * to return their result synchronously. A callback that returns a promise
	 * would finish after the result was used, so that is an error.
	 */
	static dispatchSync<T extends Description>(
		hook: T,
		context: T["context"],
		props: T["props"]
	): void {
		const internal = hook as unknown as InternalHookDescription;
		const callbacks = internal.tap.callbacks[internal.key];
		if (!callbacks || callbacks.length === 0) return;

		for (const callback of drain(
			orderTransforms(callbacks as CallbackInfo<T>[])
		)) {
			const result = callback.callback(context, props) as unknown;
			if (
				result &&
				typeof (result as Promise<void>).then === "function"
			) {
				(result as Promise<void>).then(undefined, () => undefined);
				throw new TypeError(
					`Plugin ${callback.plugin.name} returned asynchronous work to ${internal.key}`
				);
			}
		}
	}

	static dispatch<T extends Description>(
		hook: T,
		context: T["context"],
		props: T["props"]
	): Promise<void[]> | null {
		const internal = hook as unknown as InternalHookDescription;
		const callbacks = internal.tap.callbacks[internal.key];
		if (!callbacks || callbacks.length === 0) return null;

		const sorted = sortCallbacks(callbacks as CallbackInfo<T>[]);

		return Promise_all(Array_map(sorted, (cb) => cb.callback(context, props)));
	}

	static tap<T extends Description>(
		hook: T,
		callback: Callback<T>,
		plugin: Plugin = new Plugin("anonymous"),
		order: TapOrder = {}
	) {
		const internal = hook as unknown as InternalHookDescription;
		const callbacks = internal.tap.callbacks;
		if (!callbacks[internal.key]) callbacks[internal.key] = [];
		const list = callbacks[internal.key]!;
		list[list.length] = { callback, plugin, order };
	}

	static create<T extends Record<string, Description>>(): TapInstance<T> {
		const internal: TapInternal = {
			callbacks: {},
		};
		const hooks: Record<string, InternalHookDescription> = {};

		return new Proxy(internal as unknown as TapInstance<T>, {
			get(target, key: string) {
				if (key === "callbacks") return internal.callbacks;
				if (!hooks[key]) {
					hooks[key] = { tap: internal, key };
				}
				return hooks[key];
			},
		});
	}

	static getTappers<T extends Description>(hook: T): Plugin[] {
		const internal = hook as unknown as InternalHookDescription;
		return Array_map(internal.tap.callbacks[internal.key], (c) => c.plugin);
	}
}
