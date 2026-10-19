import { ScramjetClient } from "@client/index";
import { Tap } from "@/Tap";
import { linkWorkerTransport } from "@client/worker-transport";

const workerCorrelations = new WeakMap<object, string>();

function dedicatedWorkerCorrelation(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let hex = "";
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
}

export default function (client: ScramjetClient, _self: GlobalThis) {
	if ("SharedWorkerGlobalScope" in _self) {
		// Web IDL [Global] installs this replaceable attribute on the global.
		const nativeName = client.descriptors.get("self.name", _self) as string;
		const prefix = `${client.url.origin}@`;
		const name = nativeName.startsWith(prefix)
			? nativeName.slice(prefix.length)
			: nativeName;
		client.Trap("self.name", {
			get(ctx) {
				ctx.get();
				return name;
			},
		});
	}

	client.Proxy("Worker", {
		construct(ctx) {
			const options = ctx.args[1];
			const isModule = options?.type === "module";
			const workerName =
				typeof options === "object" &&
				options !== null &&
				typeof options.name === "string"
					? options.name
					: "";
			const workerCorrelation = dedicatedWorkerCorrelation();
			ctx.args[0] = client.rewriteUrl(ctx.args[0], {
				credentials: options?.credentials ?? "same-origin",
				destination: "worker",
				isModule,
				mode: isModule ? "cors" : "same-origin",
				workerCorrelation,
				workerName,
			});

			const worker = ctx.call();
			workerCorrelations.set(worker, workerCorrelation);
			linkWorkerTransport(client, worker);
		},
	});

	client.Proxy("Worker.prototype.terminate", {
		apply(ctx) {
			const worker = ctx.this;
			ctx.call();
			const correlation = workerCorrelations.get(worker);
			if (typeof correlation !== "string" || correlation.length === 0) {
				throw new Error(
					"DedicatedWorker::terminate has no construct-time DedicatedWorkerHost correlation",
				);
			}
			Tap.dispatch(
				client.hooks.lifecycle.terminateWorker,
				{ worker },
				{ correlation },
			);
		},
	});

	// sharedworkers can only be constructed from window
	client.Proxy("SharedWorker", {
		construct(ctx) {
			const options = ctx.args[1];
			const isModule =
				typeof options === "object" && options?.type === "module";
			ctx.args[0] = client.rewriteUrl(ctx.args[0], {
				credentials: isModule
					? (options?.credentials ?? "same-origin")
					: "same-origin",
				destination: "sharedworker",
				isModule,
				mode: isModule ? "cors" : "same-origin",
			});

			if (ctx.args[1] && typeof ctx.args[1] === "string")
				ctx.args[1] = `${client.url.origin}@${ctx.args[1]}`;

			if (ctx.args[1] && typeof ctx.args[1] === "object") {
				if (ctx.args[1].name) {
					ctx.args[1].name = `${client.url.origin}@${ctx.args[1].name}`;
				}
			}

			const worker = ctx.call();
			linkWorkerTransport(client, worker.port);
		},
	});

	client.Proxy("Worklet.prototype.addModule", {
		apply(ctx) {
			if (ctx.args[0]) ctx.args[0] = client.rewriteUrl(ctx.args[0]);
		},
	});
}
