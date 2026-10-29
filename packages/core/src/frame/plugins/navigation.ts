import type { ScramjetMinimalClient } from "@/minimal/client";
import { NativeURL } from "@/minimal/natives";
import type { MinimalPluginContext, ScramjetMinimalPlugin } from "@/plugins/types";
import { Reflect_apply } from "@/shared/snapshot";
import { frameOf } from "../state";
import type { FrameNavigation } from "../types";

/**
 * Links and forms that would navigate the frame are caught after the page's own handlers had their
 * turn, and the host builds the document they lead to, with a form's method and body. Script
 * navigations (location.href, assign, replace) cannot be caught in an opaque document, whose
 * Navigation API never fires (measured); the fence around the top frame blocks them before any
 * request and the host replays them from its violation report.
 */
function install(
	client: ScramjetMinimalClient,
	self: typeof globalThis,
	{ tap }: MinimalPluginContext<ScramjetMinimalClient>
) {
	const state = frameOf(client)!;
	const page = self as Window & typeof globalThis;
	const getAttribute = page.Element.prototype.getAttribute;
	const closest = page.Element.prototype.closest;
	const attribute = (element: Element, name: string) =>
		Reflect_apply(getAttribute, element, [name]) as string | null;

	const navigate = (navigation: FrameNavigation) => {
		if (!state.host) return false;
		void state.host.call("navigate", navigation).catch((error) => client.report(error, navigation.url));
		return true;
	};

	/** Whether a target names this frame rather than a new window */
	const self_ = (target: string | null) => {
		const name = (target ?? "").trim().toLowerCase();
		return name === "" || name === "_self" || name === "_parent" || name === "_top";
	};

	/** Whether a URL only moves to a fragment of the current document, which works in place */
	const fragmentOnly = (url: URL) => {
		const here = new NativeURL(client.base);
		here.hash = "";
		const there = new NativeURL(url.href);
		there.hash = "";
		return url.hash !== "" && here.href === there.href;
	};

	const click = (event: MouseEvent) => {
		if (event.defaultPrevented || event.button !== 0) return;
		const origin = event.composedPath()[0];
		if (!origin || (origin as Node).nodeType !== 1) return;
		const anchor = Reflect_apply(closest, origin, ["a[href],area[href]"]) as Element | null;
		if (!anchor || attribute(anchor, "download") !== null || !self_(attribute(anchor, "target"))) return;
		const raw = attribute(anchor, "href") ?? "";
		if (/^\s*javascript:/i.test(raw)) return;
		const url = client.resolve(raw, client.base);
		if (!url || !["http:", "https:"].includes(url.protocol) || fragmentOnly(url)) return;
		if (navigate({ url: url.href })) event.preventDefault();
	};

	/** The navigation a form submission makes, as the browser builds it */
	const submission = (form: HTMLFormElement, submitter: HTMLElement | null): FrameNavigation | null => {
		const read = (name: string) =>
			(submitter && attribute(submitter, `form${name}`)) ?? attribute(form, name);
		if (!self_(read("target"))) return null;
		const url = client.resolve(read("action") || client.base, client.base);
		if (!url || !["http:", "https:"].includes(url.protocol)) return null;
		const method = (read("method") ?? "get").toLowerCase();
		if (method === "dialog") return null;
		const data = new FormData(form, submitter ?? undefined);
		const entries: [string, string][] = [];
		data.forEach((value, name) => entries.push([name, typeof value === "string" ? value : value.name]));
		if (method !== "post") {
			url.search = new URLSearchParams(entries).toString();
			return { url: url.href };
		}
		const type = (read("enctype") ?? "").toLowerCase();
		if (type === "multipart/form-data") {
			const request = new Request(url.href, { method: "POST", body: data });
			return {
				url: url.href,
				method: "POST",
				headers: [["content-type", request.headers.get("content-type") ?? type]],
				body: null,
				pending: request.arrayBuffer(),
			} as FrameNavigation & { pending: Promise<ArrayBuffer> };
		}
		const text =
			type === "text/plain"
				? entries.map(([name, value]) => `${name}=${value}\r\n`).join("")
				: new URLSearchParams(entries).toString();
		return {
			url: url.href,
			method: "POST",
			headers: [["content-type", type === "text/plain" ? "text/plain" : "application/x-www-form-urlencoded"]],
			body: new TextEncoder().encode(text).buffer as ArrayBuffer,
		};
	};

	const send = (navigation: FrameNavigation & { pending?: Promise<ArrayBuffer> }) => {
		const { pending, ...rest } = navigation;
		if (!pending) return navigate(rest);
		if (!state.host) return false;
		void pending.then((body) => navigate({ ...rest, body }));
		return true;
	};

	const submit = (event: SubmitEvent) => {
		if (event.defaultPrevented) return;
		const form = event.target as HTMLFormElement;
		if (!form || form.localName !== "form") return;
		const navigation = submission(form, event.submitter);
		if (navigation && send(navigation)) event.preventDefault();
	};

	const listen = () => {
		// Bubbling listeners on the window run after the page's own, so a page that handles a click
		// itself keeps it; one that stops propagation leaves the navigation to the fence
		page.addEventListener("click", click as EventListener);
		page.addEventListener("submit", submit as EventListener);
	};
	listen();
	tap.tap(client.hooks.written, listen);

	// form.submit() fires no submit event
	client.Proxy("HTMLFormElement.prototype.submit", {
		apply(ctx) {
			const navigation = submission(ctx.this as HTMLFormElement, null);
			if (navigation && send(navigation)) ctx.return(undefined);
		},
	});
}

export default {
	name: "frame-navigation",
	scope: ["window"],
	enabled: (client: ScramjetMinimalClient) => frameOf(client) !== null,
	install,
} satisfies ScramjetMinimalPlugin<ScramjetMinimalClient>;
