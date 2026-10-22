/**
 * Version information for the current Scramjet build.
 * Contains both the semantic version string and the git commit hash for build identification.
 */
export interface ScramjetVersionInfo {
	/** The semantic version */
	version: string;
	/** The git commit hash that this build was created from */
	build: string;
	/** The date of the build */
	date: string;
}

/**
 * Scramjet Feature Flags, configured at build time
 */
export type ScramjetFlags = {
	syncxhr: boolean;
	disableComputedWrap: boolean;
	rewriterLogs: boolean;
	captureErrors: boolean;
	cleanErrors: boolean;
	scramitize: boolean;
	sourcemaps: boolean;
	destructureRewrites: boolean;
	allowInvalidJs: boolean;
	allowFailedIntercepts: boolean;
	debugTrampolines: boolean;
	debugSourceURL: boolean;
	encapsulateWorkers: boolean;
	/**
	 * Run page scripts in an embedder-provided realm instead of rewriting them.
	 * Script text is replaced by stubs that pass it to the realm as the detail of
	 * a DOM event named by `ScramjetConfig.realm`, the page-facing `$scramjet*`
	 * helpers are not installed, and a config without a realm is an error rather
	 * than a fallback to rewriting.
	 */
	realmExecution: boolean;
};

/**
 * How a document reaches the embedder's realm while `realmExecution` is on.
 * The embedder listens for `eventType` on each document in the capture phase,
 * cancels the event it takes, and runs the script the event's detail carries.
 */
export interface ScramjetRealmConfig {
	/** The event type stubs dispatch. Keep it unguessable and never show it to the page */
	eventType: string;
}

export interface ScramjetConfig {
	/** Build identities accompany generated document and worker bootstraps */
	identity: {
		runtimeNamespace: string;
		controllerNamespace: string;
		wasmNamespace: string;
		injectedAttribute: string;
	};
	globals: {
		setrealmfn: string;
		wrapfn: string;
		wrappropertybase: string;
		wraplocation: string;
		wrapparent: string;
		wraptop: string;
		wrapeval: string;
		wrappropertyfn: string;
		cleanrestfn: string;
		importfn: string;
		rewritefn: string;
		metafn: string;
		wrappostmessagefn: string;
		pushsourcemapfn: string;
		trysetfn: string;
		templocid: string;
		tempunusedid: string;
	};
	flags: ScramjetFlags;
	siteFlags: Record<string, Partial<ScramjetFlags>>;
	maskedfiles: string[];
	/** Required while the `realmExecution` flag is on */
	realm?: ScramjetRealmConfig;
}

/**
 * The config for Scramjet initialization.
 */
export interface ScramjetInitConfig
	extends Omit<ScramjetConfig, "codec" | "flags"> {
	flags: Partial<ScramjetFlags>;
	codec: {
		encode: (url: string) => string;
		decode: (url: string) => string;
	};
}

//eslint-disable-next-line
export type AnyFunction = Function;

export type ScramjetDestination = RequestDestination;
