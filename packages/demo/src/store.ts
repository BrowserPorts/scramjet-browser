import { createState, createStore } from "dreamland/core";

export type AvailableTransports = "libcurl" | "epoxy";
export type DemoTab = "browser" | "requests" | "playground" | "settings";

export const DEMO_TABS: ReadonlyArray<{ value: DemoTab; label: string }> = [
	{ value: "browser", label: "Browser" },
	{ value: "requests", label: "Requests" },
	{ value: "playground", label: "Playground" },
	{ value: "settings", label: "Settings" },
];

export const demoUiStore = createState({
	activeTab: "browser" as DemoTab,
});

export const AVAILABLE_TRANSPORTS: ReadonlyArray<{
	value: AvailableTransports;
	label: string;
}> = [
	{ value: "libcurl", label: "Libcurl" },
	{ value: "epoxy", label: "Epoxy" },
];
const DEFAULT_WISP_URL = import.meta.env.VITE_WISP_URL;
const DEFAULT_TRANSPORT: AvailableTransports = "libcurl";
const DEFAULT_HOME_URL = "https://google.com";
const DEFAULT_MAX_REQUESTS = 200;

export const demoSettingsStore = createStore(
	{
		transport: DEFAULT_TRANSPORT as AvailableTransports,
		wispUrl: DEFAULT_WISP_URL,
		homeUrl: DEFAULT_HOME_URL,
		maxRequests: DEFAULT_MAX_REQUESTS,
	},
	{
		ident: "scramjet-demo-settings",
		backing: "localstorage",
		autosave: "auto",
	},
);

export function normalizeWispUrl(value: string) {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new TypeError("Wisp URL is required.");
	}

	let normalized = trimmed;
	if (!normalized.startsWith("ws://") && !normalized.startsWith("wss://")) {
		normalized = `ws://${normalized}`;
	}

	const parsed = new URL(normalized);
	if (!parsed.pathname || parsed.pathname === "") {
		parsed.pathname = "/";
	}
	if (!parsed.pathname.endsWith("/")) {
		parsed.pathname = `${parsed.pathname}/`;
	}

	return parsed.toString();
}

export function normalizeHomeUrl(value: string) {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new TypeError("Home page URL is required.");
	}

	const normalized = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
		? trimmed
		: `https://${trimmed}`;

	return new URL(normalized).toString();
}

export function normalizeTransport(value: string): AvailableTransports {
	if (AVAILABLE_TRANSPORTS.some((t) => t.value === value)) {
		return value as AvailableTransports;
	}
	throw new TypeError(`Unknown transport: ${value}`);
}

export function normalizeMaxRequests(value: string | number) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new TypeError("Request log limit must be a number.");
	}

	const rounded = Math.round(parsed);
	if (rounded < 10 || rounded > 5000) {
		throw new RangeError("Request log limit must be between 10 and 5000.");
	}

	return rounded;
}

export const demoSettingsDefaults = {
	wispUrl: normalizeWispUrl(DEFAULT_WISP_URL),
	transport: DEFAULT_TRANSPORT,
	homeUrl: normalizeHomeUrl(DEFAULT_HOME_URL),
	maxRequests: DEFAULT_MAX_REQUESTS,
};

export type DemoSettingsInput = {
	wispUrl: string;
	transport: string;
	homeUrl: string;
	maxRequests: string | number;
};

export type AppliedDemoSettings = {
	wispUrl: string;
	transport: AvailableTransports;
	homeUrl: string;
	maxRequests: number;
	transportChanged: boolean;
};

export function applyDemoSettings(
	input: DemoSettingsInput,
): AppliedDemoSettings {
	const nextWispUrl = normalizeWispUrl(input.wispUrl);
	const nextTransport = normalizeTransport(input.transport);
	const nextHomeUrl = normalizeHomeUrl(input.homeUrl);
	const nextMaxRequests = normalizeMaxRequests(input.maxRequests);
	const transportChanged =
		nextWispUrl !== demoSettingsStore.wispUrl ||
		nextTransport !== demoSettingsStore.transport;

	demoSettingsStore.wispUrl = nextWispUrl;
	demoSettingsStore.transport = nextTransport;
	demoSettingsStore.homeUrl = nextHomeUrl;
	demoSettingsStore.maxRequests = nextMaxRequests;

	return {
		wispUrl: nextWispUrl,
		transport: nextTransport,
		homeUrl: nextHomeUrl,
		maxRequests: nextMaxRequests,
		transportChanged,
	};
}

export function applyDemoSettingsPartial(
	partial: Partial<DemoSettingsInput>,
): AppliedDemoSettings {
	return applyDemoSettings({
		wispUrl: partial.wispUrl ?? demoSettingsStore.wispUrl,
		transport: partial.transport ?? demoSettingsStore.transport,
		homeUrl: partial.homeUrl ?? demoSettingsStore.homeUrl,
		maxRequests: partial.maxRequests ?? demoSettingsStore.maxRequests,
	});
}
