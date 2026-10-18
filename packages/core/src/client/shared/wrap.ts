import { iswindow } from "@client/entry";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
// import { argdbg } from "@client/shared/err";
import {
	Object_defineProperty,
	Object_getOwnPropertyDescriptor,
} from "@/shared/snapshot";

export function createWrapFn(client: ScramjetClient, self: GlobalThis) {
	let wrappedParent: GlobalThis | null = null;
	let wrappedTop: GlobalThis | null = null;
	if (iswindow) {
		try {
			if (SCRAMJETCLIENT in self.parent) {
				// ... then we're in a subframe, and the parent frame is also in a proxy context, so we should return its proxy
				// `parent` is typed `Window`, which does not structurally overlap
				// `typeof globalThis`, but the branch is only taken when that window is
				// a hooked Scramjet realm — i.e. a real global object. The step through
				// `unknown` states that the runtime check above is what establishes it.
				wrappedParent = self.parent as unknown as GlobalThis;
			} else {
				// ... then we should pretend we aren't nested and return the current window
				wrappedParent = self;
			}
		} catch {
			// accessing self.parent can throw if it's cross-origin, in which case we should also pretend we aren't nested
			wrappedParent = self;
		}
		// instead of returning top, we need to return the uppermost parent that's inside a scramjet context
		let current = self;
		for (;;) {
			const test = current.parent.self;
			if (test === current) break; // there is no parent, actual or emulated.

			try {
				// ... then `test` represents a window outside of the proxy context, and therefore `current` is the topmost window in the proxy context
				if (!(SCRAMJETCLIENT in test)) break;
			} catch {
				// accessing test can throw if it's cross-origin, in which case we should also break
				break;
			}
			// test is also insde a proxy, so we should continue up the chain
			current = test;
		}
		wrappedTop = current;
	}

	return function (identifier: any) {
		if (identifier === self.location) return client.locationProxy;
		if (identifier === self.eval) {
			return client.indirectEval;
		}
		if (iswindow) {
			if (identifier === self.parent) {
				return wrappedParent;
			} else if (identifier === self.top) {
				return wrappedTop;
			}
		}
		return identifier;
	};
}

export const order = 4;
export default function (client: ScramjetClient, self: GlobalThis) {
	const properties: Record<string, string> = {
		location: client.config.globals.wraplocation,
		parent: client.config.globals.wrapparent,
		top: client.config.globals.wraptop,
		eval: client.config.globals.wrapeval,
	};
	const realLocationDescriptor = iswindow
		? Object_getOwnPropertyDescriptor(self, "location")
		: undefined;

	Object_defineProperty(self, client.config.globals.wrapfn, {
		value: client.wrapfn,
		writable: false,
		configurable: false,
		enumerable: false,
	});
	Object_defineProperty(self, client.config.globals.wrappropertyfn, {
		value: function (str) {
			if (
				str === "location" ||
				str === "parent" ||
				str === "top" ||
				str === "eval"
			)
				return properties[str];

			return str;
		},
		writable: false,
		configurable: false,
		enumerable: false,
	});
	Object_defineProperty(self, client.config.globals.cleanrestfn, {
		value: function (obj) {
			// TODO
		},
		writable: false,
		configurable: false,
		enumerable: false,
	});

	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wraplocation,
		{
			get: function () {
				// if (this.location.constructor.toString().includes("Location")) {

				if (this === self || this === self.document) {
					return client.locationProxy;
				}

				try {
					return this.location;
				} catch (error) {
					let ownLocationDescriptor: PropertyDescriptor | undefined;
					try {
						ownLocationDescriptor = Object_getOwnPropertyDescriptor(
							this,
							"location"
						);
					} catch {
						throw error;
					}
					if (
						realLocationDescriptor?.get &&
						ownLocationDescriptor?.get === realLocationDescriptor.get
					) {
						return client.locationProxy;
					}
					throw error;
				}
			},
			set(value: any) {
				if (this === self || this === self.document) {
					client.url = value;

					return;
				}
				try {
					this.location = value;
				} catch (error) {
					let ownLocationDescriptor: PropertyDescriptor | undefined;
					try {
						ownLocationDescriptor = Object_getOwnPropertyDescriptor(
							this,
							"location"
						);
					} catch {
						throw error;
					}
					if (
						realLocationDescriptor?.set &&
						ownLocationDescriptor?.set === realLocationDescriptor.set
					) {
						client.url = value;
						return;
					}
					throw error;
				}
			},
			configurable: false,
			enumerable: false,
		}
	);
	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrapparent,
		{
			get: function () {
				return client.wrapfn(this.parent);
			},
			set(value: any) {
				// i guess??
				this.parent = value;
			},
			configurable: false,
			enumerable: false,
		}
	);
	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wraptop,
		{
			get: function () {
				return client.wrapfn(this.top);
			},
			set(value: any) {
				this.top = value;
			},
			configurable: false,
			enumerable: false,
		}
	);
	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrapeval,
		{
			get: function () {
				return client.wrapfn(this.eval);
			},
			set(value: any) {
				this.eval = value;
			},
			configurable: false,
			enumerable: false,
		}
	);

	// `$scramitize` is a debugging aid: the rewriter only emits `$scramitize(...)`
	// calls when the `scramitize` flag is on, so install it only then. In a
	// production build (flag off) it is never defined, so it cannot show up as an
	// enumerable `self.$scramitize` to a page scanning `Object.keys(window)`, and
	// its `debugger` statements never run. Defined non-enumerable even in dev.
	if (client.flagEnabled("scramitize")) {
		Object_defineProperty(self, "$scramitize", {
			value: function (v) {
				const t = typeof v;
				if (t === "object" && v !== null) {
					if (v === location) debugger;
					if (iswindow) {
						// if (v === self.parent) debugger;
						if (v === self.top) debugger;
					}
				} else if (t === "string") {
					if (v.includes("scramjet")) debugger;
					if (v.includes("~/sj")) debugger;
					if (v.includes(location.origin)) debugger;
				}

				return v;
			},
			writable: false,
			configurable: false,
			enumerable: false,
		});
	}

	// location = "..." can't be rewritten as wrapfn(location) = ..., so instead it will actually be rewritten as
	// ((t)=>$scramjet$tryset(location,"+=",t)||location+=t)(...);
	// it has to be a discrete function because there's always the possibility that "location" is a local variable
	// we have to use an IIFE to avoid duplicating side-effects in the getter
	Object_defineProperty(self, client.config.globals.trysetfn, {
		value: function (lhs: any, op: string, rhs: any) {
			if (client.box.locations.has(lhs)) {
				lhs.href = rhs;
				return true;
			}

			return false;
		},
		writable: false,
		configurable: false,
	});
}
