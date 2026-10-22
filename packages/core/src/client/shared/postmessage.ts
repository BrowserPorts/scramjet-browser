import { messageFields } from "@/runtime-identity";
import { iswindow } from "@client/entry";
import { ScramjetClient } from "@client/index";
import { Object_defineProperty } from "@/shared/snapshot";
import { POLLUTANT } from "./realm";

export default function (client: ScramjetClient, self: Self) {
	if (iswindow)
		client.Proxy("window.postMessage", {
			apply(ctx) {
				// so we need to send the real origin here, since the recieving window can't possibly know.
				// except, remember that this code is being ran in a different realm than the invoker, so if we ask our `client` it may give us the wrong origin
				// if we were given any object that came from the real realm we can use that to get the real origin
				// and this works in every case EXCEPT for the fact that all three arguments can be strings which are copied instead of cloned
				// so we have to use `$setrealm` which will pollute this with an object from the real realm

				let pollutant;

				if (typeof ctx.args[0] === "object" && ctx.args[0] !== null) {
					pollutant = ctx.args[0]; // try to use the first object we can find because it's more reliable
				} else if (typeof ctx.args[2] === "object" && ctx.args[2] !== null) {
					pollutant = ctx.args[2]; // next try to use transfer
				} else if (
					ctx.this &&
					POLLUTANT in ctx.this &&
					typeof ctx.this[POLLUTANT] === "object" &&
					ctx.this[POLLUTANT] !== null
				) {
					pollutant = ctx.this[POLLUTANT]; // lastly try to use the object from $setrealm
				} else {
					pollutant = {}; // give up
				}

				// and now we can steal Function from the caller's realm
				const {
					constructor: { constructor: Function },
				} = pollutant;

				// invoking stolen function will give us the caller's globalThis, remember scramjet has already proxied it!!!
				const callerGlobalThisProxied: Self = Function("return globalThis")();
				// The caller runs in another realm; reach its client through the
				// shared box rather than off its global (the client is no longer
				// stored there). If the caller is not in this box, fall back to our
				// own client, whose origin is correct for a same-prefix frame.
				const callerClient =
					client.box.globals.get(callerGlobalThisProxied) ?? client;

				// this WOULD be enough but the source argument of MessageEvent has to return the caller's window
				// and if we just call it normally it would be coming from here, which WILL NOT BE THE CALLER'S because the accessor is from the parent
				// so with the stolen function we wrap postmessage so the source will truly be the caller's window (remember that function is scramjet's!!!)
				const wrappedPostMessage = Function("...args", "this(...args)");

				// console.log(
				// 	callerClient,
				// 	client,
				// 	callerGlobalThisProxied.document,
				// 	self.document,
				// 	callerClient === client
				// );
				const inherit =
					callerClient.url.href === "about:srcdoc" ||
					callerClient.url.href === "about:blank";
				const parentClient = client.box.globals.get(
					callerClient.global.parent as Self
				);
				ctx.args[0] = {
					[messageFields.type]: "window",
					[messageFields.origin]:
						inherit && parentClient
							? parentClient.url.origin
							: callerClient.url.origin,
					[messageFields.data]: ctx.args[0],
				};
				// console.error("?", ctx.args);
				// eval("debugger");

				// * origin because obviously
				if (typeof ctx.args[1] === "string") ctx.args[1] = "*";
				if (typeof ctx.args[1] === "object") ctx.args[1].targetOrigin = "*";

				ctx.return(wrappedPostMessage.call(ctx.fn, ...ctx.args));
			},
		});

	client.Proxy("BroadcastChannel.prototype.postMessage", {
		apply(ctx) {
			ctx.args[0] = {
				[messageFields.type]: "window",
				// TODO: need to actually look up the broadcastchannel itself in box i think
				[messageFields.origin]: client.url.origin,
				[messageFields.data]: ctx.args[0],
			};
		},
	});

	const toproxy = ["MessagePort.prototype.postMessage"];

	if (self.Worker) toproxy.push("Worker.prototype.postMessage");
	if (!iswindow) toproxy.push("self.postMessage"); // only do the generic version if we're in a worker

	client.Proxy(toproxy, {
		apply(ctx) {
			// origin/source doesn't need to be preserved - it's null in the message event

			ctx.args[0] = {
				[messageFields.type]: "worker",
				[messageFields.data]: ctx.args[0],
			};
		},
	});
	// Only rewritten code calls this helper
	if (client.flagEnabled("realmExecution")) return;
	Object_defineProperty(self, client.config.globals.wrappostmessagefn, {
		value: function (obj: any) {
			if (!obj || typeof obj.postMessage !== "function") return obj;
			return {
				postMessage: obj.postMessage.bind(obj),
			};
		},
		configurable: false,
		writable: false,
		enumerable: false,
	});
}
