import { IncrementalHtmlRewriter } from "@/shared";
import { ScramjetClient } from "./client";
import { SourceMaps } from "./shared/sourcemaps";
import {
	Object_getOwnPropertyNames,
	Object_getOwnPropertyDescriptor,
} from "@/shared/snapshot";

export class SingletonBox {
	clients: ScramjetClient[] = [];
	globals: Map<Self, ScramjetClient> = new Map();
	documents: Map<Document, ScramjetClient> = new Map();
	histories: Map<History, ScramjetClient> = new Map();
	locations: Map<Location, ScramjetClient> = new Map();
	writeRewriters = new WeakMap<Document, IncrementalHtmlRewriter>();
	unproxy = new Map<any, any>();

	ctors: Record<string, Function[]> = {};

	/**
	 * The windows that posted a message and are named by the message, as a message of the realm names its sender.
	 * The browser takes the realm of the code that made the call as the sender, and a window another opened is
	 * hooked by a copy of the runtime that is the opener's, so the browser would name the opener as the sender of
	 * what the opened window posts to it
	 */
	senders = new Map<string, Window>();
	private senderCount = 0;

	/** Names a window that is about to post a message, which the receiving page reads its `source` back from */
	registerSender(window: Window): string {
		const id = `${(this.senderCount += 1)}.${Math.random().toString(36).slice(2)}`;
		this.senders.set(id, window);
		// A message that is never delivered, as one to a window that went away is, does not stay for good
		if (this.senders.size > 1024) {
			const oldest = this.senders.keys().next();
			if (!oldest.done) this.senders.delete(oldest.value);
		}
		return id;
	}

	senderOf(id: unknown): Window | undefined {
		return typeof id === "string" ? this.senders.get(id) : undefined;
	}

	sourcemaps: SourceMaps = {};

	constructor(public ownerclient: ScramjetClient) {}

	registerClient(client: ScramjetClient, global: Self) {
		this.clients.push(client);
		this.globals.set(global, client);
		this.documents.set(global.document, client);
		this.locations.set(global.location, client);
		this.histories.set(global.history, client);

		Object_getOwnPropertyNames(global).forEach((prop) => {
			const desc = Object_getOwnPropertyDescriptor(global, prop);
			if (desc && typeof desc.value === "function") {
				if (!this.ctors[prop]) this.ctors[prop] = [];
				this.ctors[prop].push(desc.value);
			}
		});
	}

	instanceof(obj: any, name: string): boolean {
		const ctors = this.ctors[name];
		if (!ctors) {
			dbg.error(`No constructors for ${name} found`);
			return false;
		}
		for (const ctor of ctors) {
			// eslint-disable-next-line scramjet-core/no-instanceof
			if (obj instanceof ctor) return true;
		}
		return false;
	}
}
