import { pstAvailable } from "@/shared/incumbency";
import { identityName, runtimeIdentity } from "./runtime-identity";
import type { ScramjetConfig } from "./types";

// apart from the entry, so a runtime that is not the full client can take the
// defaults without the entry's side effects
export const defaultConfig: ScramjetConfig = {
	globals: {
		wrapfn: identityName("$scramjet$wrap"),
		wrappropertybase: identityName("$scramjet__"),
		wrappropertyfn: identityName("$scramjet$prop"),
		callfn: identityName("$scramjet$call"),
		cleanrestfn: identityName("$scramjet$clean"),
		importfn: identityName("$scramjet$import"),
		rewritefn: identityName("$scramjet$rewrite"),
		metafn: identityName("$scramjet$meta"),
		pushsourcemapfn: identityName("$scramjet$pushsourcemap"),
		registerrealmfn: identityName("$scramjet$registerrealm"),
		standinfn: identityName("$scramjet$standin"),
		trysetfn: identityName("$scramjet$tryset"),
		templocid: identityName("$scramjet$temploc"),
		tempreceiverid: identityName("$scramjet$tempreceiver"),
		tempcalleeid: identityName("$scramjet$tempcallee"),
		tempunusedid: identityName("$scramjet$tempunused"),
	},
	flags: {
		syncxhr: false,
		disableComputedWrap: false,
		rewriterLogs: false,
		captureErrors: false,
		cleanErrors: true,
		sourcemaps: true,
		destructureRewrites: true,
		allowInvalidJs: true,
		debugTrampolines: false,
		encapsulateWorkers: true,
		debugSourceURL: false,
		incumbency: pstAvailable ? "pst" : "lazystamp",
	},
	maskedfiles: [],
	identity: runtimeIdentity,
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
