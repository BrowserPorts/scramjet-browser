import { resolve } from "node:path";
import { rspack, type RspackOptions } from "@rspack/core";
import configs from "./rspack.config.ts";

const rawKey = process.env.ST_BUILD_XOR_KEY;
const destination = process.env.SCRAMJET_BUILD_OUTPUT;
if (!rawKey || !destination)
	throw new Error(
		"Hardened Scramjet builds require a key and output directory"
	);
const key: unknown = JSON.parse(rawKey);
if (
	!Array.isArray(key) ||
	key.length !== 32 ||
	key.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
)
	throw new TypeError("Invalid Scramjet build key");
const encode = (value: string) =>
	"_" +
	Array.from(new TextEncoder().encode(value), (byte, index) =>
		(byte ^ key[index % key.length]).toString(16).padStart(2, "0")
	).join("");
const runtimeName = encode("$scramjet");
const controllerName = encode("$scramjetController");
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
				SCRAMJET_IDENTITY_KEY: JSON.stringify(key),
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
