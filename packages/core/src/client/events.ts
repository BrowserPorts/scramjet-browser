export type LifecycleHooks = {
	/**
	 * Before scramjet calls a native through `client.native`, so a plugin that
	 * hands the page facades over DOM objects can unwrap them first
	 */
	nativeCall: {
		context: { target: string };
		props: { receiver: unknown; args: unknown[] };
	};
	navigate: {
		context: {
			type: "location" | "history" | "hashchange";
		};
		props: {
			url: string;
		};
	};
};
