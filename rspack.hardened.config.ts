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
 * `ST_SCRAMJET_ATTRIBUTE_KEY` is read and checked for the host's sake, since
 * hosts built for the fork's v2 line send it, but this line keys its internal
 * attributes by their prefix alone and does not use it.
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
if (rawAttributeKey !== undefined) {
	const attributeKey: unknown = JSON.parse(rawAttributeKey);
	if (
		!Array.isArray(attributeKey) ||
		attributeKey.length !== 32 ||
		attributeKey.some(
			(byte) => !Number.isInteger(byte) || byte < 0 || byte > 255
		)
	)
		throw new TypeError("Invalid Scramjet attribute key");
}
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
