import { INTERCEPTORS, install, worker } from "./index";

// Pages and the worker bootstrap reach the build through this global
Object.assign(globalThis, {
	$scramjetInterceptors: {
		install,
		worker,
		interceptors: INTERCEPTORS.map(([name]) => name),
	},
});
