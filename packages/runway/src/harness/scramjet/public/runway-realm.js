// Realm mode of the harness page (RUNWAY_REALM=1). It builds the guest page the way Stellite's
// real-engine run does (Stellite/scripts/realm-engine/host.js): it loads the staged V8-Wasm engine,
// makes the SDK's guest page, and waits for preload, since a frame builds its realm without waiting.
// The harness merges `config` into the controller's Scramjet config and installs the plugin on the
// test frame.
//
// What realm mode adds for the runway itself: a page's scripts run in the guest, which does not see
// what Playwright's init script left on the frame's window (only the platform's own names are
// projected), so each frame's realm is given the runway's page helpers, evaluated in the guest,
// and Playwright's bindings, which stay host functions. An error the guest leaves uncaught is
// reported on the frame's window by the SDK, where Playwright's pageerror does not see it, so the
// harness fails the test from there as pageerror would.
import {
	createGuestPage,
	createV8WasmArtifactLoader,
} from "/sdk/userscripts/index.js";
import { V8WasmPageHostBoundary } from "/boundary.js";

/** Playwright's bindings, which a page's script calls by name */
const HOST_BINDINGS = [
	"__testPass",
	"__testFail",
	"__testConsistent",
	"__testOk",
	"__runwayControl",
];

/**
 * The runway's `checkglobal` evaluates `top`, `location` and `eval` with the frame's own eval,
 * which realm mode's policy withholds from the host world and which would answer the guest's
 * values in the guest. The same question is asked of the host instead: whether what the page
 * holds is, behind the membrane, the frame's real top, location or eval.
 */
const GUEST_CHECKGLOBAL = `(function (realGlobalOf) {
	window.checkglobal = function checkglobal(global) {
		const leaked = realGlobalOf(global);
		assert(!leaked, leaked + " was leaked");
	};
})`;

function installRunwayHelpers(realm, frameWindow, helpers) {
	for (const name of HOST_BINDINGS) {
		realm.defineGlobal(name, function (...args) {
			const binding = frameWindow[name];
			return typeof binding === "function"
				? Reflect.apply(binding, frameWindow, args)
				: undefined;
		});
	}
	realm.evalInRealm(helpers);
	const install = realm.membrane.decodeToHost(
		realm.evalInRealm(GUEST_CHECKGLOBAL)
	);
	install((value) => {
		if (value === frameWindow.top) return "top";
		if (value === frameWindow.location) return "location";
		if (value === frameWindow.eval) return "eval";
		return "";
	});

	// The SDK fires an uncaught guest error or rejection at the frame's window as an untrusted
	// event; a native one is Playwright's pageerror already. A browser reports one only when no
	// listener cancelled it, which is known once the dispatch is over
	const failTest = (event, message, details) => {
		queueMicrotask(() => {
			if (event.defaultPrevented) return;
			const fail = frameWindow.fail;
			if (typeof fail === "function") fail(message, details);
		});
	};
	frameWindow.addEventListener("error", (event) => {
		if (event.isTrusted) return;
		failTest(event, `Uncaught error: ${String(event.message).replace(/^Uncaught \w*:? ?/u, "")}`, {
			guest: true,
			filename: event.filename,
			lineno: event.lineno,
			stack: String(event.error?.stack ?? ""),
		});
	});
	frameWindow.addEventListener("unhandledrejection", (event) => {
		if (event.isTrusted) return;
		const reason = event.reason;
		failTest(event, `Uncaught error: ${String(reason?.message ?? reason)}`, {
			guest: true,
			rejection: true,
			stack: String(reason?.stack ?? ""),
		});
	});
}

export async function prepareRealm() {
	const wasm = WebAssembly;
	if (
		typeof wasm.promising !== "function" ||
		typeof wasm.Suspending !== "function"
	) {
		throw new Error("Realm mode needs JSPI, which Chrome has from version 137");
	}
	const helpers = await (await fetch("/runway-guest-helpers.js")).text();

	const stage = "/engine/";
	const manifest = await (await fetch(`${stage}manifest.json`)).json();
	const entry = manifest.entry;
	const url = (path) => new URL(stage + path, location.href).href;
	const page = createGuestPage({
		ownerId: crypto.randomUUID(),
		loadArtifact: createV8WasmArtifactLoader({
			engineModuleUrl: url(entry.engine),
			emscriptenModuleUrl: url(entry.emscripten),
			wasmUrl: url(entry.wasm),
			icuDataUrl: url(entry.icuData),
			snapshotDataUrl: url(entry.startupSnapshot),
			dataDir: entry.dataDirectory,
		}),
		loadBoundary: async () => V8WasmPageHostBoundary,
	});

	// Every frame's realm gets the runway's helpers as soon as it is made, before the frame's
	// first script runs
	const createFrameRealmSync = page.runtime.createFrameRealmSync.bind(
		page.runtime
	);
	page.runtime.createFrameRealmSync = (ownerId, frameWindow, extras) => {
		let made;
		try {
			made = createFrameRealmSync(ownerId, frameWindow, extras);
			installRunwayHelpers(made.realm, frameWindow, helpers);
		} catch (error) {
			console.error("runway: a frame's realm could not be made", error);
			const fail = frameWindow.fail;
			if (typeof fail === "function") {
				fail(`Realm mode could not make this frame's realm: ${String(error?.message ?? error)}`, {
					stack: String(error?.stack ?? ""),
					cause: String(error?.cause?.stack ?? error?.cause ?? ""),
				});
			}
			throw error;
		}
		return made;
	};

	await page.preload();
	return {
		engine: manifest.v8,
		config: page.config,
		createPlugin: () =>
			page.createPlugin((name) => new $scramjet.Plugin(name)),
	};
}
