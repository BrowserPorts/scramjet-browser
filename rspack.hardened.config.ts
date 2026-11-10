import { resolve } from "node:path";
import { rspack, type RspackOptions } from "@rspack/core";
import configs from "./rspack.config.ts";
import {
	IDENTITY_NAMES,
	type IdentityName,
} from "./packages/core/src/runtime-identity-names.ts";

/**
 * A hardened build is handed every physical name by its host, which derives them under a secret
 * this build never sees: `ST_SCRAMJET_IDENTITY_NAMES` holds a JSON object with a name for each of
 * `IDENTITY_NAMES`, and `ST_SCRAMJET_ATTRIBUTE_KEY` the 32 bytes internal attribute names are encoded
 * under, as a JSON array. Nothing here derives a name
 */
const rawNames = process.env.ST_SCRAMJET_IDENTITY_NAMES;
const rawAttributeKey = process.env.ST_SCRAMJET_ATTRIBUTE_KEY;
const destination = process.env.SCRAMJET_BUILD_OUTPUT;
if (!rawNames || !rawAttributeKey || !destination)
	throw new Error(
		"Hardened Scramjet builds require their names, an attribute key and an output directory"
	);
const table: unknown = JSON.parse(rawNames);
if (typeof table !== "object" || table === null || Array.isArray(table))
	throw new TypeError("Scramjet's names have to be a JSON object");
function physicalName(logical: IdentityName): string {
	const physical: unknown = Reflect.get(table, logical);
	if (typeof physical !== "string" || !/^[a-z][a-z0-9]*$/.test(physical))
		throw new TypeError(`Scramjet has no usable name for ${logical}`);
	return physical;
}
const identityNames = Object.fromEntries(
	IDENTITY_NAMES.map((logical) => [logical, physicalName(logical)])
);
const attributeKey: unknown = JSON.parse(rawAttributeKey);
if (
	!Array.isArray(attributeKey) ||
	attributeKey.length !== 32 ||
	attributeKey.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
)
	throw new TypeError("Invalid Scramjet attribute key");
const runtimeName = physicalName("$scramjet");
const controllerName = physicalName("$scramjetController");
const names = new Set([
	"scramjet-iife",
	"scramjet-esmodule",
	"scramjet-minimal",
	"scramjet-controller",
]);

export default configs
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
				SCRAMJET_ATTRIBUTE_KEY: JSON.stringify(attributeKey),
				SCRAMJET_RUNTIME_NAMESPACE: JSON.stringify(runtimeName),
			})
		);
		const config: RspackOptions = {
			...original,
			devtool: false,
			output: {
				...original.output,
				path: outputDir,
				...(original.output?.library &&
				original.name !== "scramjet-esmodule" &&
				original.name !== "scramjet-minimal"
					? { library: { type: "assign", name: "self." + namespace } }
					: {}),
			},
			plugins,
		};
		if (controller) {
			config.dependencies = ["scramjet-esmodule"];
			config.resolve = {
				...original.resolve,
				alias: {
					...original.resolve?.alias,
					"@mercuryworkshop/scramjet$": resolve(
						destination,
						"core/scramjet-external.mjs"
					),
				},
			};
		}
		return config;
	});
