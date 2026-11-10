// The asm.js build, which parses synchronously with no wasm to compile first
import { parse } from "es-module-lexer/js";
import type { ScramjetMinimalClient } from "@/minimal/client";
import { NativeMap, NativeSet, NativeURL } from "@/minimal/natives";
import type { MinimalPluginContext, ScramjetMinimalPlugin } from "@/plugins/types";
import { identityName } from "@/runtime-identity";
import { JSON_stringify, Object_defineProperty } from "@/shared/snapshot";
import { frameOf, identityUrl } from "../state";

/** Modules each module is waiting on while it loads, to tell a cycle from a shared dependency */
const waits = new NativeMap<string, Set<string>>();

function reaches(from: string, to: string, seen = new NativeSet<string>()): boolean {
	if (from === to) return true;
	if (seen.has(from)) return false;
	seen.add(from);
	for (const next of waits.get(from) ?? []) if (reaches(next, to, seen)) return true;
	return false;
}

/** The global the rewritten dynamic imports call, named for the publication */
function helperName(client: ScramjetMinimalClient): string {
	return identityName("scramjet-frame-import", client.config.identityKey);
}

/** Whether a specifier is a URL or a relative path; anything else needs an import map */
function resolvable(specifier: string): boolean {
	return /^(\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i.test(specifier);
}

/**
 * A module's text with its imports pointed at blobs: static import and export specifiers become
 * blob URLs of the modules they name (each rewritten the same way), dynamic imports call a helper
 * that does the same at run time, and import.meta.url reads the module's own URL. Found with a
 * lexer rather than a full parse, so the code is otherwise left as written.
 *
 * A dependency that is still loading because it waits on this module (a cycle) keeps its absolute
 * URL, which the frame's policy refuses; cycles need an import map, which this does not build.
 */
export async function rewriteModule(
	client: ScramjetMinimalClient,
	source: string,
	url: string
): Promise<string> {
	let imports: ReturnType<typeof parse>[0];
	try {
		[imports] = parse(source);
	} catch {
		// Not a module the lexer understands; the browser reports the error when it runs
		return source;
	}
	const own = identityUrl(client, url).href;
	const helper = JSON_stringify(helperName(client));
	const edits = await Promise.all(
		imports.map(async (entry): Promise<[number, number, string] | null> => {
			if (entry.d === -2)
				return [
					entry.s,
					entry.e,
					`({ url: ${JSON_stringify(own)}, resolve: (specifier) => new URL(specifier, ${JSON_stringify(own)}).href })`,
				];
			if (entry.d > -1)
				return [entry.ss, entry.ss + "import".length, `(globalThis[${helper}](${JSON_stringify(url)}))`];
			if (entry.n === undefined || !resolvable(entry.n)) return null;
			const target = client.resolve(entry.n, url);
			if (!target || target.protocol === "blob:" || target.protocol === "data:") return null;
			if (reaches(target.href, url)) return [entry.s, entry.e, target.href];
			let waiting = waits.get(url);
			if (!waiting) waits.set(url, (waiting = new NativeSet()));
			waiting.add(target.href);
			try {
				return [entry.s, entry.e, await client.blob(target, "script", true)];
			} finally {
				waiting.delete(target.href);
			}
		})
	);
	let output = source;
	for (const edit of edits
		.filter((edit): edit is [number, number, string] => edit !== null)
		.sort((a, b) => b[0] - a[0]))
		output = output.slice(0, edit[0]) + edit[2] + output.slice(edit[1]);
	return output;
}

/**
 * Module scripts, module workers and dynamic imports in frame mode. A module loaded from a blob
 * cannot resolve its relative imports (measured), so every module the client turns into a blob is
 * rewritten by {@link rewriteModule} first, and a worker's module entry is built the same way
 * inside the worker, from blobs the worker made itself.
 */
function install(
	client: ScramjetMinimalClient,
	self: typeof globalThis,
	{ tap }: MinimalPluginContext<ScramjetMinimalClient>
) {
	const load = async (specifier: unknown, base: string) => {
		const raw = String(specifier);
		const url = resolvable(raw) ? client.resolve(raw, base) : null;
		if (!url) throw new TypeError(`Failed to resolve module specifier "${raw}"`);
		const target =
			url.protocol === "blob:" || url.protocol === "data:"
				? url.href
				: await client.blob(url, "script", true);
		return import(/* @vite-ignore */ /* webpackIgnore: true */ target);
	};
	const define = () => {
		const name = helperName(client);
		if (Object.prototype.hasOwnProperty.call(self, name)) return;
		Object_defineProperty(self, name, {
			configurable: true,
			value: (base: string) => (specifier: unknown) => load(specifier, base),
		});
	};
	define();

	tap.tap(client.hooks.resource, async ({ url, kind, isModule }, props) => {
		if (kind !== "script" || !isModule || !props.response.ok) return;
		// The publication's identity may have arrived since install, which renames the helper
		define();
		const text = await rewriteModule(client, await props.response.text(), url.href);
		props.response = new Response(text, {
			status: props.response.status,
			statusText: props.response.statusText,
			headers: props.response.headers,
		});
	});

	// A worker's own script loads from a blob this worker made, from bytes it fetched over its link
	// or that the page read ahead, since it cannot load the page's blobs everywhere (Safari's data:
	// workers have origins of their own)
	tap.tap(client.hooks.entry, async ({ module }, props) => {
		const state = frameOf(client)!;
		const file = state.files.get(props.entry);
		if (file && !module) {
			props.entry = URL.createObjectURL(file);
			return;
		}
		let url: URL;
		try {
			url = new NativeURL(props.entry);
		} catch {
			return;
		}
		if (file) {
			const text = await rewriteModule(client, await file.text(), url.href);
			props.entry = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
			return;
		}
		if (url.protocol === "blob:" || url.protocol === "data:") return;
		props.entry = await client.blob(url, "script", module);
	});
}

export default {
	name: "frame-modules",
	order: -4,
	enabled: (client: ScramjetMinimalClient) => frameOf(client) !== null,
	install,
} satisfies ScramjetMinimalPlugin<ScramjetMinimalClient>;
