import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";
import type { ScramjetStorageApiContext } from "@/shared/storage";

function partitionScopedName(
	client: ScramjetClient,
	context: ScramjetStorageApiContext,
	name: string
) {
	const key = client.context.storagePartitionKey;
	const scoped = `${context.origin}@${name}`;
	return key === undefined ? scoped : `${encodeURIComponent(key)}|${scoped}`;
}

export default function (client: ScramjetClient) {
	function storageContext(): ScramjetStorageApiContext {
		const url = client.url;
		return { url, origin: url.origin };
	}

	function databaseName(name: string, operation: "open" | "deleteDatabase") {
		const context = storageContext();
		return (
			client.context.storage?.indexedDB?.databaseName?.(
				context,
				name,
				operation
			) ?? partitionScopedName(client, context, name)
		);
	}

	client.Proxy("IDBFactory.prototype.open", {
		apply(ctx) {
			const context = storageContext();
			const name = String(ctx.args[0]);
			const version = typeof ctx.args[1] === "number" ? ctx.args[1] : undefined;
			const req = client.context.storage?.indexedDB?.open?.(
				context,
				name,
				version
			);
			if (req) {
				ctx.return(req);
				return;
			}
			ctx.args[0] = databaseName(name, "open");
		},
	});

	client.Proxy("IDBFactory.prototype.deleteDatabase", {
		apply(ctx) {
			const context = storageContext();
			const name = String(ctx.args[0]);
			const req = client.context.storage?.indexedDB?.deleteDatabase?.(
				context,
				name
			);
			if (req) {
				ctx.return(req);
				return;
			}
			ctx.args[0] = databaseName(name, "deleteDatabase");
		},
	});

	client.Trap("IDBDatabase.prototype.name", {
		get(ctx) {
			const name = String(ctx.get());
			return (
				client.context.storage?.indexedDB?.displayName?.(
					storageContext(),
					name
				) ?? name.substring(name.indexOf("@") + 1)
			);
		},
	});
}
