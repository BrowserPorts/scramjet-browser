import { rewriteJs } from "@rewriters/js";
import { ScramjetClient, ProxyCtx, Proxy } from "@client/index";
import {
	Object_defineProperty,
	Object_getOwnPropertyDescriptor,
} from "@/shared/snapshot";

function rewriteFunction<T extends string, U extends "construct" | "apply">(
	ctx: ProxyCtx<T, U>,
	client: ScramjetClient
) {
	const stringifiedFunction = ctx.call().toString();

	// TODO: also check if the function comes from a weird realm. if so we need to completely block it or do something else weird
	// not much point rewriting the javascript if it's executing in the top level

	const content = rewriteJs(
		`return ${stringifiedFunction}`,
		"(function proxy)",
		client.context,
		client.meta
	);
	ctx.return(ctx.fn(content)());
}

export default function (client: ScramjetClient, _self: Self) {
	const handler: Proxy = {
		apply(ctx: ProxyCtx) {
			rewriteFunction(ctx, client);
		},
		construct(ctx) {
			rewriteFunction(ctx, client);
		},
	};

	client.Proxy("Function", handler);

	// Capture the raw constructors before the prototype property changes.
	// A function expression does not call the global Function binding, so
	// `.constructor` is still the original function here.
	const RawFunction = client.natives.call(
		"eval",
		null,
		"(function () {})"
	).constructor;
	const RawAsyncFunction = client.natives.call(
		"eval",
		null,
		"(async function () {})"
	).constructor;
	const RawGeneratorFunction = client.natives.call(
		"eval",
		null,
		"(function* () {})"
	).constructor;
	const RawAsyncGeneratorFunction = client.natives.call(
		"eval",
		null,
		"(async function* () {})"
	).constructor;

	// `fn.constructor === Function` is a normal type test. A second proxy on
	// the prototype is a different object, so the test fails and callers such
	// as AudioPlayr treat the function itself as a sound name.
	const functionProxy = client.global.Function;
	const constructorDescriptor = Object_getOwnPropertyDescriptor(
		RawFunction.prototype,
		"constructor"
	);
	Object_defineProperty(RawFunction.prototype, "constructor", {
		value: functionProxy,
		writable: constructorDescriptor?.writable ?? true,
		enumerable: constructorDescriptor?.enumerable ?? false,
		configurable: constructorDescriptor?.configurable ?? true,
	});

	client.RawProxy(RawAsyncFunction.prototype, "constructor", handler);
	client.RawProxy(RawGeneratorFunction.prototype, "constructor", handler);
	client.RawProxy(RawAsyncGeneratorFunction.prototype, "constructor", handler);
}
