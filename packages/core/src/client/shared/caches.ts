import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";
import type { ScramjetStorageApiContext } from "@/shared/storage";

type CacheStorageNameOperation = "open" | "has" | "delete";
type CacheRequestOperation =
	| "match"
	| "add"
	| "addAll"
	| "put"
	| "matchAll"
	| "keys"
	| "delete";

function partitionScopedName(
	client: ScramjetClient,
	context: ScramjetStorageApiContext,
	name: string
) {
	const key = client.context.storagePartitionKey;
	const scoped = `${context.origin}@${name}`;
	return key === undefined ? scoped : `${encodeURIComponent(key)}|${scoped}`;
}

export default function (client: ScramjetClient, _self: Self) {
	function storageContext(): ScramjetStorageApiContext {
		const url = client.url;
		return { url, origin: url.origin };
	}

	function cacheName(name: string, operation: CacheStorageNameOperation) {
		const context = storageContext();
		return (
			client.context.storage?.cacheStorage?.cacheName?.(
				context,
				name,
				operation
			) ?? partitionScopedName(client, context, name)
		);
	}

	function requestArg(req: unknown, operation: CacheRequestOperation) {
		const context = storageContext();
		const mapped = client.context.storage?.cacheStorage?.request?.(
			context,
			req,
			operation
		);
		return mapped === undefined ? client.rewriteUrl(String(req)) : mapped;
	}

	client.Proxy("CacheStorage.prototype.open", {
		apply(ctx) {
			ctx.args[0] = cacheName(String(ctx.args[0]), "open");
		},
	});
	client.Proxy("CacheStorage.prototype.has", {
		apply(ctx) {
			ctx.args[0] = cacheName(String(ctx.args[0]), "has");
		},
	});
	client.Proxy("CacheStorage.prototype.match", {
		apply(ctx) {
			ctx.args[0] = requestArg(ctx.args[0], "match");
		},
	});
	client.Proxy("CacheStorage.prototype.delete", {
		apply(ctx) {
			ctx.args[0] = cacheName(String(ctx.args[0]), "delete");
		},
	});
	client.Proxy("Cache.prototype.add", {
		apply(ctx) {
			ctx.args[0] = requestArg(ctx.args[0], "add");
		},
	});
	client.Proxy("Cache.prototype.addAll", {
		apply(ctx) {
			ctx.args[0] = [...ctx.args[0]].map((req) => requestArg(req, "addAll"));
		},
	});
	client.Proxy("Cache.prototype.put", {
		apply(ctx) {
			ctx.args[0] = requestArg(ctx.args[0], "put");
		},
	});
	client.Proxy("Cache.prototype.match", {
		apply(ctx) {
			ctx.args[0] = requestArg(ctx.args[0], "match");
		},
	});
	client.Proxy("Cache.prototype.matchAll", {
		apply(ctx) {
			ctx.args[0] = requestArg(ctx.args[0], "matchAll");
		},
	});
	client.Proxy("Cache.prototype.keys", {
		apply(ctx) {
			ctx.args[0] = requestArg(ctx.args[0], "keys");
		},
	});
	client.Proxy("Cache.prototype.delete", {
		apply(ctx) {
			ctx.args[0] = requestArg(ctx.args[0], "delete");
		},
	});
}
