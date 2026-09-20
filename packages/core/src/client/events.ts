export type LifecycleHooks = {
	navigate: {
		context: {
			type: "location" | "history" | "hashchange";
		};
		props: {
			url: string;
		};
	};
	/**
	 * Host-engine `Worker.prototype.terminate` after the native Worker global
	 * scope has been terminated. `correlation` is the construct-time transport
	 * id stamped as `$wcorr` so the browser-process `DedicatedWorkerHost` can
	 * be destroyed.
	 */
	terminateWorker: {
		context: {
			worker: Worker;
		};
		props: {
			correlation: string;
		};
	};
};
