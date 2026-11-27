import { resolve } from "node:path";
import { rspack, type RspackOptions } from "@rspack/core";
import configs from "./rspack.config.ts";
import {
	IDENTITY_NAMES,
	type IdentityName,
} from "./packages/core/src/runtime-identity-names.ts";

/**
 * A hardened build is handed every physical name by its host, which derives
 * them under a secret this build never sees: `ST_SCRAMJET_IDENTITY_NAMES` holds
 * a JSON object with a name for each of `IDENTITY_NAMES`. Nothing here derives
 * a name.
 *
 * `ST_SCRAMJET_ATTRIBUTE_KEY` holds the bytes shared by the HTML rewriter
 * and the client hooks that read mirrored attribute names.
 *
 * The runtime is built into `SCRAMJET_BUILD_OUTPUT`: `core/scramjet.js`,
 * `core/scramjet.mjs` with its `scramjet-external.mjs`, and
 * `controller/controller.{api,inject,sw}.js`. The rewriter's wasm takes every
 * name from its caller, so the unkeyed `packages/core/dist/scramjet.wasm` is the
 * one a keyed build ships.
 */
const rawNames = process.env.ST_SCRAMJET_IDENTITY_NAMES;
const rawAttributeKey = process.env.ST_SCRAMJET_ATTRIBUTE_KEY;
const destination = process.env.SCRAMJET_BUILD_OUTPUT;
if (!rawNames || !destination)
	throw new Error(
		"Hardened Scramjet builds require their names and an output directory"
	);
const table: unknown = JSON.parse(rawNames);
if (typeof table !== "object" || table === null || Array.isArray(table))
	throw new TypeError("Scramjet's names have to be a JSON object");
function physicalName(logical: IdentityName): string {
	const physical: unknown = Reflect.get(table as object, logical);
	if (typeof physical !== "string" || !/^[a-z][a-z0-9]*$/.test(physical))
		throw new TypeError(`Scramjet has no usable name for ${logical}`);
	return physical;
}
const identityNames = Object.fromEntries(
	IDENTITY_NAMES.map((logical) => [logical, physicalName(logical)])
);
function readKey(
	raw: string | undefined,
	label: string
): readonly number[] | undefined {
	if (!raw) return undefined;
	const key: unknown = JSON.parse(raw);
	if (
		!Array.isArray(key) ||
		key.length !== 32 ||
		key.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
	)
		throw new TypeError(`Invalid Scramjet ${label} key`);
	return key;
}
const attributeKey = readKey(rawAttributeKey, "attribute");
const scriptKey = readKey(process.env.ST_SCRAMJET_SCRIPT_XOR_KEY, "script XOR");
const runtimeName = physicalName("$scramjet");
const controllerName = physicalName("$scramjetController");
const names = new Set(["scramjet-iife", "scramjet-esmodule", "scramjet-controller"]);

export default (configs as RspackOptions[])
	.filter((config) => names.has(config.name!))
	.map((original) => {
		const controller = original.name === "scramjet-controller";
		const outputDir = resolve(destination, controller ? "controller" : "core");
		const namespace = controller ? controllerName : runtimeName;
		const plugins = original
			.plugins!.filter(
				(plugin) => plugin?.constructor.name !== "TypeScriptDeclarationsPlugin"
			)
			.map((plugin) => {
				if (plugin?.constructor.name === "ExternalStubPlugin") {
					const stub = plugin as unknown as {
						globalName: string;
						outputDir: string;
					};
					stub.globalName = namespace;
					stub.outputDir = outputDir;
				}
				return plugin;
			});
		plugins.push(
			new rspack.DefinePlugin({
				SCRAMJET_IDENTITY_NAMES: JSON.stringify(identityNames),
				SCRAMJET_ATTRIBUTE_KEY: JSON.stringify(attributeKey) ?? "undefined",
				SCRAMJET_SCRIPT_XOR_KEY: JSON.stringify(scriptKey) ?? "undefined",
			})
		);
		const library = original.output?.library;
		const config: RspackOptions = {
			...original,
			devtool: false,
			output: {
				...original.output,
				path: outputDir,
				...(library && original.name !== "scramjet-esmodule"
					? {
							library: controller
								? { type: "self", name: namespace }
								: { type: "assign", name: "self." + namespace },
						}
					: {}),
			},
			plugins,
		};
		if (controller) {
			config.dependencies = ["scramjet-esmodule"];
			config.resolve = {
				...original.resolve,
				alias: {
					...(original.resolve?.alias as Record<string, string>),
					"@mercuryworkshop/scramjet$": resolve(
						destination,
						"core/scramjet-external.mjs"
					),
				},
			};
		} else {
			config.dependencies = undefined;
		}
		return config;
	});
