import type { ScramjetMinimalClient } from "@/minimal/client";
import type { MinimalPluginContext, ScramjetMinimalPlugin } from "@/plugins/types";
import { Object_defineProperty, Object_getOwnPropertyDescriptor, Object_setPrototypeOf } from "@/shared/snapshot";
import { frameOf, identityUrl } from "../state";

/**
 * A frame's document is about:srcdoc and a frame worker's script is a blob, so what either says
 * about its own address is patched to the URL it stands for, decoded from the codec's space:
 * document.URL, documentURI, baseURI, referrer, domain and origin in a page, and location in a
 * worker. A window's location cannot be redefined, so it keeps reading about:srcdoc.
 */
function install(
	client: ScramjetMinimalClient,
	self: typeof globalThis,
	{ tap }: MinimalPluginContext<ScramjetMinimalClient>
) {
	const here = () => identityUrl(client);
	if (typeof (self as { document?: unknown }).document === "undefined") {
		worker(client, self);
		return;
	}
	const state = frameOf(client)!;
	client.Trap(["Document.prototype.URL", "Document.prototype.documentURI"], {
		get() {
			return here().href;
		},
	});
	client.Trap("Node.prototype.baseURI", {
		get(ctx) {
			const native = ctx.get() as string;
			return client.codec.decode(native) ?? native;
		},
	});
	client.Trap("Document.prototype.referrer", {
		get() {
			return state.referrer;
		},
	});
	client.Trap("Document.prototype.domain", {
		get() {
			return here().hostname;
		},
		// Setting it changes nothing a sandboxed document could use, so it is accepted and ignored
		set() {},
	});
	// origin lives on the window itself, as a replaceable attribute. Plugins tell an opaque frame by
	// it while they install and prepare, so it changes once the document is written, before any of
	// the page's code runs
	let patched = false;
	tap.tap(client.hooks.written, () => {
		if (patched) return;
		patched = true;
		const own = Object_getOwnPropertyDescriptor(self, "origin");
		Object_defineProperty(self, "origin", {
			configurable: true,
			enumerable: own?.enumerable ?? true,
			get: () => here().origin,
			set: (value: unknown) => {
				Object_defineProperty(self, "origin", {
					configurable: true,
					enumerable: true,
					writable: true,
					value,
				});
			},
		});
	});
}

/** A worker's location stands for its script's URL, which can be redefined in a worker (measured) */
function worker(client: ScramjetMinimalClient, self: typeof globalThis) {
	const scope = self as typeof globalThis & { WorkerLocation?: { prototype: object } };
	const prototype = scope.WorkerLocation?.prototype;
	const location = {} as Record<string, unknown>;
	if (prototype) Object_setPrototypeOf(location, prototype);
	const url = () => identityUrl(client);
	for (const name of ["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"])
		Object_defineProperty(location, name, {
			enumerable: true,
			get: () => (url() as unknown as Record<string, string>)[name],
		});
	Object_defineProperty(location, "toString", { value: () => url().href });
	client.Trap("WorkerGlobalScope.prototype.location", {
		get() {
			return location;
		},
	});
}

export default {
	name: "frame-identity",
	order: -5,
	enabled: (client: ScramjetMinimalClient) => frameOf(client) !== null,
	install,
} satisfies ScramjetMinimalPlugin<ScramjetMinimalClient>;
