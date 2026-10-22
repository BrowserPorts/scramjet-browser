import { identityName } from "@/runtime-identity";
import { ScramjetClient } from "@client/index";
import { Object_defineProperty, Symbol_for } from "@/shared/snapshot";

export const POLLUTANT = Symbol_for(identityName("scramjet realm pollutant"));

// A realm-mode embedder knows which realm a call came from, so the page never
// needs to tag its objects with $setrealm
export const enabled = (client: ScramjetClient) =>
	!client.flagEnabled("realmExecution");

export default function (client: ScramjetClient, self: GlobalThis) {
	// object.$setrealm({}).postMessage(...)
	// the empty object is the "pollutant" which can reconstruct the real realm
	// i explain more in postmessage.ts
	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.setrealmfn,
		{
			value(pollution: object) {
				// this is bad!! sites could detect this
				Object_defineProperty(this, POLLUTANT, {
					value: pollution,
					writable: false,
					configurable: true,
					enumerable: false,
				});

				return this;
			},
			writable: true,
			configurable: true,
			enumerable: false,
		}
	);
}
