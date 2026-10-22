// Realm mode for the harness (RUNWAY_REALM=1). Page scripts are never rewritten and never run in
// the frame's own realm: the controller is in realm mode and the SDK's guest-page plugin runs each
// script in a V8-Wasm guest realm, the way Stellite's hardened player does. The wiring copies
// Stellite/scripts/realm-engine (run.ts serves the same files, host.js builds the same guest page).
//
// It needs ST_FERROCHROME_ROOT (a root with v8-wasm-web and packages/ferrochrome-runtime),
// STELLITE_SDK_DIR (a built Stellite-SDK), STELLITE_DIR (the Stellite checkout, whose URL owner the
// page boundary is bundled with), Bun (which bundles it) and Chrome 137 or newer (CHROME_PATH).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Express } from "express";
import { CDP_INIT_SCRIPT } from "../../cdp-init.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "../../..");

export const realmMode = process.env.RUNWAY_REALM === "1";

/** What the harness page's head gets in realm mode: the SDK chunks' bare imports, and the switch */
const REALM_HEAD = `<script type="importmap">{"imports":{"comlink":"/vendor/comlink.js","ultrahtml":"/vendor/ultrahtml.js","valibot":"/vendor/valibot.js","ajv":"/vendor/ajv.js","module":"/vendor/module.js","@terbiumos/tfs/browser":"/vendor/tfs.js"}}</script>
		<script>window.__runwayRealm = true;</script>`;

function required(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Realm mode needs ${name}`);
	}
	return path.resolve(value);
}

/**
 * Builds the page boundary and the vendored packages, and serves them with the engine stage
 * and the SDK build. The harness page is served with the import map and the switch in its head.
 */
export function mountRealm(app: Express, publicDir: string) {
	const ferrochromeRoot = required("ST_FERROCHROME_ROOT");
	const sdk = required("STELLITE_SDK_DIR");
	required("STELLITE_DIR");
	const assets = path.resolve(
		process.env.RUNWAY_REALM_ASSETS ??
			path.join(packageRoot, "runway-output", "realm-assets")
	);
	execFileSync(
		process.env.BUN_PATH ?? "bun",
		[path.join(packageRoot, "scripts", "realm-assets.ts"), assets],
		{ stdio: "inherit" }
	);

	const page = fs
		.readFileSync(path.join(publicDir, "index.html"), "utf-8")
		.replace("<!-- runway realm head -->", REALM_HEAD);
	const sendPage = (_req: express.Request, res: express.Response) => {
		res.type("html").send(page);
	};
	app.get("/", sendPage);
	app.get("/index.html", sendPage);

	// The runway's page helpers, which realm mode evaluates in each frame's guest realm, since a
	// page's scripts there do not see what an init script left on the frame's own window
	app.get("/runway-guest-helpers.js", (_req, res) => {
		res.type("text/javascript").send(CDP_INIT_SCRIPT);
	});
	app.use("/sdk", express.static(path.join(sdk, "dist")));
	app.use("/engine", express.static(path.join(ferrochromeRoot, "v8-wasm-web")));
	app.get("/boundary.js", (_req, res) => {
		res.sendFile(path.join(assets, "boundary.js"));
	});
	app.use("/vendor", express.static(path.join(assets, "vendor")));
	console.log("    Realm mode: page scripts run in the V8-Wasm guest realm");
}
