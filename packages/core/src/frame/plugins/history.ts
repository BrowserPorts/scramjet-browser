import type { ScramjetMinimalClient } from "@/minimal/client";
import { NativeURL } from "@/minimal/natives";
import type { MinimalPluginContext, ScramjetMinimalPlugin } from "@/plugins/types";
import { Reflect_apply } from "@/shared/snapshot";
import { frameOf, identityUrl } from "../state";

type Entry = { url: string; state: unknown };

/**
 * A sandboxed srcdoc document's history throws on pushState and replaceState, even for a fragment
 * (measured), so the frame keeps its own: an entry stack with state, a length that counts the
 * documents the host keeps before and after this one, popstate on traversal, and the document's
 * URL and <base> following the current entry. A traversal past this document's entries asks the
 * host, which builds the document there.
 */
function install(
	client: ScramjetMinimalClient,
	self: typeof globalThis,
	{ tap }: MinimalPluginContext<ScramjetMinimalClient>
) {
	const state = frameOf(client)!;
	const page = self as Window & typeof globalThis;
	const querySelector = page.Document.prototype.querySelector;
	const setAttribute = page.Element.prototype.setAttribute;
	const entries: Entry[] = [{ url: client.base, state: null }];
	let index = 0;

	/** Moves the document to another URL in place, as pushState and traversal do */
	const move = (url: string) => {
		client.config.base = url;
		const base = Reflect_apply(querySelector, page.document, ["base[href]"]) as Element | null;
		if (base) Reflect_apply(setAttribute, base, ["href", url]);
	};
	const decoded = (url: string) => identityUrl(client, url).href;

	const write = (args: unknown[], replace: boolean, method: string) => {
		const data = structuredClone(args[0]);
		let url = client.base;
		const raw = args[2];
		if (raw !== undefined && raw !== null) {
			const resolved = client.resolve(String(raw), client.base);
			if (
				!resolved ||
				identityUrl(client, resolved.href).origin !== identityUrl(client).origin
			)
				throw new DOMException(
					`Failed to execute '${method}' on 'History': A history state object with URL '${String(raw)}' cannot be created in a document with origin '${identityUrl(client).origin}'`,
					"SecurityError"
				);
			url = resolved.href;
		}
		if (replace) entries[index] = { url, state: data };
		else {
			entries.splice(index + 1);
			entries.push({ url, state: data });
			index++;
			state.history.after = 0;
		}
		move(url);
	};
	client.Proxy("History.prototype.pushState", {
		apply(ctx) {
			write(ctx.args, false, "pushState");
			ctx.return(undefined);
		},
	});
	client.Proxy("History.prototype.replaceState", {
		apply(ctx) {
			write(ctx.args, true, "replaceState");
			ctx.return(undefined);
		},
	});

	const traverse = (delta: number) => {
		if (!delta) {
			page.location.reload();
			return;
		}
		const target = index + delta;
		if (target < 0 || target >= entries.length) {
			const beyond = target < 0 ? target : target - (entries.length - 1);
			void state.host?.call("traverse", { delta: beyond }).catch(() => undefined);
			return;
		}
		// Traversal is asynchronous, as the browser's is
		setTimeout(() => {
			const previous = entries[index]!;
			index = target;
			const next = entries[index]!;
			move(next.url);
			page.dispatchEvent(new PopStateEvent("popstate", { state: next.state }));
			const before = new NativeURL(previous.url);
			const after = new NativeURL(next.url);
			before.hash = after.hash = "";
			if (before.href === after.href && previous.url !== next.url)
				page.dispatchEvent(
					new HashChangeEvent("hashchange", {
						oldURL: decoded(previous.url),
						newURL: decoded(next.url),
					})
				);
		});
	};
	client.Proxy("History.prototype.back", {
		apply(ctx) {
			traverse(-1);
			ctx.return(undefined);
		},
	});
	client.Proxy("History.prototype.forward", {
		apply(ctx) {
			traverse(1);
			ctx.return(undefined);
		},
	});
	client.Proxy("History.prototype.go", {
		apply(ctx) {
			traverse(Math.trunc(Number(ctx.args[0]) || 0));
			ctx.return(undefined);
		},
	});
	client.Trap("History.prototype.length", {
		get() {
			return state.history.before + entries.length + state.history.after;
		},
	});
	client.Trap("History.prototype.state", {
		get() {
			return entries[index]!.state;
		},
	});

	// A fragment navigation works in place natively (measured); the current entry follows it
	const fragment = () => {
		const url = new NativeURL(entries[index]!.url);
		url.hash = page.location.hash;
		entries[index]!.url = url.href;
		client.config.base = url.href;
	};
	page.addEventListener("hashchange", fragment, true);
	tap.tap(client.hooks.written, () => page.addEventListener("hashchange", fragment, true));
	for (const name of ["oldURL", "newURL"] as const)
		client.Trap(`HashChangeEvent.prototype.${name}`, {
			get(ctx) {
				const native = ctx.get() as string;
				if (!native.startsWith("about:srcdoc")) return native;
				const url = identityUrl(client);
				url.hash = native.slice("about:srcdoc".length);
				return url.href;
			},
		});
}

export default {
	name: "frame-history",
	scope: ["window"],
	enabled: (client: ScramjetMinimalClient) => frameOf(client) !== null,
	install,
} satisfies ScramjetMinimalPlugin<ScramjetMinimalClient>;
