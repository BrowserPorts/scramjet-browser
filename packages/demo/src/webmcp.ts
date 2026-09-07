import { createState } from "dreamland/core";
import type { ScramjetFlags } from "@mercuryworkshop/scramjet";
import { cachePlugin, controller, getTransport } from ".";
import { flagDescriptions, flagStore } from "./components/FlagEditor";
import { browserState } from "./pages/BrowserView";
import { requestsState } from "./pages/RequestViewer";
import {
	applyDemoSettingsPartial,
	DEMO_TABS,
	demoSettingsStore,
	demoUiStore,
	normalizeHomeUrl,
	type DemoTab,
} from "./store";

export type WebMcpBackend = "native" | "polyfill" | "unavailable";

export const webmcpState = createState({
	backend: "unavailable" as WebMcpBackend,
	toolCount: 0,
	error: "",
});

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const DEMO_TAB_VALUES = DEMO_TABS.map((tab) => tab.value) as DemoTab[];

type StoredTool = {
	tool: ModelContextTool;
	exposedTo: string[];
};

const POLYFILL_FLAG = "__scramjetWebMcpPolyfill";
const INSTALL_ABORT_KEY = "__scramjetWebMcpInstallAbort";

class ModelContextPolyfill extends EventTarget implements ModelContext {
	readonly [POLYFILL_FLAG] = true;
	#tools = new Map<string, StoredTool>();
	ontoolchange: ((this: ModelContext, ev: Event) => unknown) | null = null;

	override dispatchEvent(event: Event): boolean {
		if (event.type === "toolchange" && this.ontoolchange) {
			this.ontoolchange.call(this, event);
		}
		return super.dispatchEvent(event);
	}

	async registerTool(
		tool: ModelContextTool,
		options: ModelContextRegisterToolOptions = {},
	): Promise<void> {
		if (!tool?.name || !TOOL_NAME_RE.test(tool.name) || !tool.description) {
			throw new DOMException(
				"Invalid WebMCP tool name or description",
				"InvalidStateError",
			);
		}
		if (this.#tools.has(tool.name)) {
			throw new DOMException(
				`Tool "${tool.name}" is already registered`,
				"InvalidStateError",
			);
		}
		if (options.signal?.aborted) {
			throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
		}
		if (tool.inputSchema !== undefined) {
			JSON.stringify(tool.inputSchema);
		}

		const entry: StoredTool = {
			tool,
			exposedTo: options.exposedTo ? [...options.exposedTo] : [],
		};
		this.#tools.set(tool.name, entry);

		if (options.signal) {
			options.signal.addEventListener(
				"abort",
				() => {
					if (this.#tools.get(tool.name) === entry) {
						this.#tools.delete(tool.name);
						this.dispatchEvent(new Event("toolchange"));
					}
				},
				{ once: true },
			);
		}

		this.dispatchEvent(new Event("toolchange"));
	}

	async getTools(): Promise<RegisteredTool[]> {
		return [...this.#tools.values()]
			.map(({ tool }) => toRegisteredTool(tool))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	async executeTool(
		tool: RegisteredTool,
		input: object | string = {},
		options: ModelContextExecuteToolOptions = {},
	): Promise<string> {
		const entry = this.#tools.get(tool.name);
		if (!entry) {
			throw new DOMException(
				`Tool "${tool.name}" was not found`,
				"NotFoundError",
			);
		}
		if (options.signal?.aborted) {
			throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
		}

		const inputObject = parseToolInput(input);
		const result = await entry.tool.execute(inputObject, {
			signal: options.signal ?? new AbortController().signal,
		});
		if (result === undefined) return "null";
		return typeof result === "string" ? result : JSON.stringify(result);
	}
}

function toRegisteredTool(tool: ModelContextTool): RegisteredTool {
	return {
		name: tool.name,
		title: tool.title ?? "",
		description: tool.description,
		inputSchema: tool.inputSchema,
		annotations: tool.annotations,
		origin: location.origin,
		window,
	};
}

function parseToolInput(input: object | string): Record<string, unknown> {
	if (typeof input === "string") {
		if (!input.trim()) return {};
		const parsed = JSON.parse(input) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new DOMException("Tool input must be a JSON object", "DataError");
		}
		return parsed as Record<string, unknown>;
	}
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		throw new DOMException("Tool input must be a JSON object", "DataError");
	}
	return input as Record<string, unknown>;
}

function isPolyfill(
	context: ModelContext | undefined,
): context is ModelContextPolyfill {
	return Boolean(context && (context as ModelContextPolyfill)[POLYFILL_FLAG]);
}

function ensureModelContext(): {
	context: ModelContext;
	backend: WebMcpBackend;
} {
	const existing = document.modelContext;
	if (
		existing &&
		typeof existing.registerTool === "function" &&
		!isPolyfill(existing)
	) {
		return { context: existing, backend: "native" };
	}

	const polyfill = new ModelContextPolyfill();
	Object.defineProperty(document, "modelContext", {
		configurable: true,
		enumerable: true,
		value: polyfill,
	});
	return { context: polyfill, backend: "polyfill" };
}

function requireFrame() {
	if (!browserState.frame) {
		throw new Error("The proxied browser frame is not ready yet.");
	}
	return browserState.frame;
}

function readFlags(): Record<string, boolean> {
	const flags = {} as Record<string, boolean>;
	for (const key of Object.keys(flagStore) as Array<keyof ScramjetFlags>) {
		flags[key] = Boolean(flagStore[key]);
	}
	return flags;
}

function isDemoTab(value: unknown): value is DemoTab {
	return (
		typeof value === "string" && DEMO_TAB_VALUES.includes(value as DemoTab)
	);
}

function demoTools(): ModelContextTool[] {
	return [
		{
			name: "get_demo_state",
			title: "Get demo state",
			description:
				"Return the Scramjet demo's current tab, proxied URL, settings, request count, flags, and WebMCP backend.",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true },
			execute: () => ({
				tab: demoUiStore.activeTab,
				url: browserState.url,
				settings: {
					transport: demoSettingsStore.transport,
					wispUrl: demoSettingsStore.wispUrl,
					homeUrl: demoSettingsStore.homeUrl,
					maxRequests: demoSettingsStore.maxRequests,
				},
				requestCount: requestsState.requests.length,
				flags: readFlags(),
				webmcp: {
					backend: webmcpState.backend,
					toolCount: webmcpState.toolCount,
				},
			}),
		},
		{
			name: "navigate",
			title: "Navigate",
			description:
				"Open a URL in the Scramjet proxied browser tab. Accepts a full URL or a hostname.",
			inputSchema: {
				type: "object",
				properties: {
					url: {
						type: "string",
						description:
							"Destination URL or hostname, such as https://example.com",
					},
				},
				required: ["url"],
			},
			execute: ({ url }) => {
				if (typeof url !== "string" || !url.trim()) {
					throw new TypeError("url is required.");
				}
				const normalized = normalizeHomeUrl(url);
				const frame = requireFrame();
				browserState.url = normalized;
				demoSettingsStore.homeUrl = normalized;
				demoUiStore.activeTab = "browser";
				frame.go(normalized);
				return { url: normalized, tab: "browser" };
			},
		},
		{
			name: "go_back",
			title: "Go back",
			description: "Go back in the proxied browser history.",
			inputSchema: { type: "object", properties: {} },
			execute: () => {
				requireFrame().back();
				return { url: browserState.url };
			},
		},
		{
			name: "go_forward",
			title: "Go forward",
			description: "Go forward in the proxied browser history.",
			inputSchema: { type: "object", properties: {} },
			execute: () => {
				requireFrame().forward();
				return { url: browserState.url };
			},
		},
		{
			name: "reload",
			title: "Reload",
			description: "Reload the current proxied page.",
			inputSchema: { type: "object", properties: {} },
			execute: () => {
				requireFrame().reload();
				return { url: browserState.url };
			},
		},
		{
			name: "switch_tab",
			title: "Switch tab",
			description:
				"Switch the Scramjet demo chrome between the Browser, Requests, Playground, and Settings tabs.",
			inputSchema: {
				type: "object",
				properties: {
					tab: {
						type: "string",
						enum: DEMO_TAB_VALUES,
						description: "Demo tab to show.",
					},
				},
				required: ["tab"],
			},
			execute: ({ tab }) => {
				if (!isDemoTab(tab)) {
					throw new TypeError(
						`Unknown tab: ${String(tab)}. Expected one of ${DEMO_TAB_VALUES.join(", ")}.`,
					);
				}
				demoUiStore.activeTab = tab;
				return { tab };
			},
		},
		{
			name: "list_captured_requests",
			title: "List captured requests",
			description:
				"List recent requests captured by the Scramjet demo request viewer.",
			inputSchema: {
				type: "object",
				properties: {
					limit: {
						type: "integer",
						minimum: 1,
						maximum: 100,
						description:
							"Maximum number of requests to return. Defaults to 20.",
					},
				},
			},
			annotations: { readOnlyHint: true },
			execute: ({ limit }) => {
				const parsed =
					typeof limit === "number" && Number.isFinite(limit)
						? Math.round(limit)
						: 20;
				const size = Math.min(100, Math.max(1, parsed));
				const requests = requestsState.requests.slice(-size).map((entry) => ({
					id: entry.id,
					method: entry.method,
					url: entry.url,
					status: entry.status ?? null,
					time: entry.time,
					destination: entry.destination ?? null,
				}));
				return {
					count: requestsState.requests.length,
					returned: requests.length,
					requests,
				};
			},
		},
		{
			name: "get_settings",
			title: "Get settings",
			description: "Return the current Scramjet demo runtime settings.",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true },
			execute: () => ({
				transport: demoSettingsStore.transport,
				wispUrl: demoSettingsStore.wispUrl,
				homeUrl: demoSettingsStore.homeUrl,
				maxRequests: demoSettingsStore.maxRequests,
			}),
		},
		{
			name: "update_settings",
			title: "Update settings",
			description:
				"Update demo runtime settings. Wisp or transport changes apply to future proxied requests.",
			inputSchema: {
				type: "object",
				properties: {
					wispUrl: {
						type: "string",
						description: "Wisp websocket URL, such as ws://localhost:4142/",
					},
					transport: {
						type: "string",
						enum: ["libcurl", "epoxy"],
						description: "Outbound transport used over Wisp.",
					},
					homeUrl: {
						type: "string",
						description: "Default proxied home page URL.",
					},
					maxRequests: {
						type: "integer",
						minimum: 10,
						maximum: 5000,
						description: "Request log limit kept in memory.",
					},
				},
			},
			execute: (input) => {
				const applied = applyDemoSettingsPartial({
					wispUrl:
						typeof input.wispUrl === "string" ? input.wispUrl : undefined,
					transport:
						typeof input.transport === "string" ? input.transport : undefined,
					homeUrl:
						typeof input.homeUrl === "string" ? input.homeUrl : undefined,
					maxRequests:
						typeof input.maxRequests === "number" ||
						typeof input.maxRequests === "string"
							? input.maxRequests
							: undefined,
				});
				if (applied.transportChanged) {
					controller.setTransport(getTransport());
				}
				return applied;
			},
		},
		{
			name: "list_flags",
			title: "List flags",
			description: "List Scramjet feature flags and their current values.",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true },
			execute: () =>
				(Object.keys(flagStore) as Array<keyof ScramjetFlags>).map((name) => ({
					name,
					enabled: Boolean(flagStore[name]),
					description: flagDescriptions[name],
				})),
		},
		{
			name: "set_flag",
			title: "Set flag",
			description: "Enable or disable a Scramjet feature flag at runtime.",
			inputSchema: {
				type: "object",
				properties: {
					name: {
						type: "string",
						description: "Flag name from list_flags.",
					},
					enabled: {
						type: "boolean",
						description: "Whether the flag should be enabled.",
					},
				},
				required: ["name", "enabled"],
			},
			execute: ({ name, enabled }) => {
				if (typeof name !== "string" || !(name in flagStore)) {
					throw new TypeError(`Unknown flag: ${String(name)}`);
				}
				if (typeof enabled !== "boolean") {
					throw new TypeError("enabled must be a boolean.");
				}
				const flag = name as keyof ScramjetFlags;
				flagStore[flag] = enabled;
				Object.assign(controller.scramjetConfig.flags, { [flag]: enabled });
				return { name: flag, enabled };
			},
		},
		{
			name: "bust_cache",
			title: "Bust cache",
			description: "Clear the Scramjet HTTP cache used by the demo browser.",
			inputSchema: { type: "object", properties: {} },
			execute: async () => {
				const ok = await cachePlugin.bust();
				return {
					cleared: ok,
					message: ok ? "Cache cleared" : "Nothing to clear",
				};
			},
		},
	];
}

let installGeneration = 0;

export async function installDemoWebMcp(): Promise<void> {
	const generation = ++installGeneration;
	const previousAbort = (
		window as unknown as Record<string, AbortController | undefined>
	)[INSTALL_ABORT_KEY];
	previousAbort?.abort();
	const toolsAbort = new AbortController();
	(window as unknown as Record<string, AbortController>)[INSTALL_ABORT_KEY] =
		toolsAbort;
	const { signal } = toolsAbort;

	webmcpState.error = "";
	webmcpState.toolCount = 0;

	const { context, backend } = ensureModelContext();

	try {
		const tools = demoTools();
		for (const tool of tools) {
			if (signal.aborted || generation !== installGeneration) return;
			await context.registerTool(tool, { signal });
		}
		if (signal.aborted || generation !== installGeneration) return;
		webmcpState.backend = backend;
		webmcpState.toolCount = tools.length;
	} catch (error) {
		if (signal.aborted || generation !== installGeneration) return;
		webmcpState.backend = backend === "native" ? "native" : "unavailable";
		webmcpState.error =
			error instanceof Error
				? error.message
				: "Failed to register WebMCP tools.";
		console.error("[WebMCP] failed to register demo tools:", error);
	}
}
