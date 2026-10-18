import { identityName, runtimeIdentity } from "./runtime-identity";
import type { ScramjetConfig } from "./types";

export const defaultConfig: ScramjetConfig = {
	identity: runtimeIdentity,
	globals: {
		setrealmfn: identityName("$scramjet$setrealmfn"),
		wrapfn: identityName("$scramjet$wrap"),
		wrappropertybase: identityName("$scramjet__"),
		wraplocation: identityName("$scramjet__location"),
		wrapparent: identityName("$scramjet__parent"),
		wraptop: identityName("$scramjet__top"),
		wrapeval: identityName("$scramjet__eval"),
		wrappropertyfn: identityName("$scramjet$prop"),
		cleanrestfn: identityName("$scramjet$clean"),
		importfn: identityName("$scramjet$import"),
		rewritefn: identityName("$scramjet$rewrite"),
		metafn: identityName("$scramjet$meta"),
		wrappostmessagefn: identityName("$scramjet$wrappostmessage"),
		pushsourcemapfn: identityName("$scramjet$pushsourcemap"),
		trysetfn: identityName("$scramjet$tryset"),
		templocid: identityName("$scramjet$temploc"),
		tempunusedid: identityName("$scramjet$tempunused"),
	},
	flags: {
		syncxhr: false,
		disableComputedWrap: false,
		rewriterLogs: false,
		captureErrors: false,
		cleanErrors: false,
		scramitize: false,
		sourcemaps: true,
		destructureRewrites: true,
		allowInvalidJs: true,
		debugTrampolines: false,
		allowFailedIntercepts: false,
		encapsulateWorkers: true,
		debugSourceURL: false,
	},
	siteFlags: {},
	maskedfiles: [],
};

export const defaultConfigDev: ScramjetConfig = {
	...defaultConfig,
	flags: {
		...defaultConfig.flags,
		rewriterLogs: false,
		captureErrors: true,
		cleanErrors: false,
		debugTrampolines: true,
		debugSourceURL: true,
		allowInvalidJs: false,
	},
};
