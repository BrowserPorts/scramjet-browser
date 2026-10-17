import type { ScramjetClient } from "@client/index";
import { Object_getPrototypeOf, Reflect_deleteProperty } from "@/shared/snapshot";

// The host's registration namespace belongs to the proxy, not to guest pages.
// Remove the native entry point before guest code runs. A runtime plugin may
// install its own API through the normal post-initialization hooks.
export const order = -20;

export default function (_client: ScramjetClient, scope: typeof globalThis) {
	// Covers Navigator and WorkerNavigator without assuming either constructor
	// exists in this realm. Include the instance so an own native accessor cannot
	// leave a second route to the host registration namespace.
	let target: object | null = scope.navigator;
	while (target) {
		if (!Reflect_deleteProperty(target, "serviceWorker")) {
			throw new Error("Cannot isolate the host service worker API");
		}
		target = Object_getPrototypeOf(target);
	}
}
