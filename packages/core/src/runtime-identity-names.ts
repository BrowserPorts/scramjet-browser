/**
 * Every name Scramjet gives its globals, symbols, attributes, query
 * parameters, channels and messages. A keyed build is handed a physical name
 * for each of these by its host, which reads this list to derive them, and the
 * runtime refuses to start without one for every entry. A name used anywhere
 * has to be listed here.
 */
export const IDENTITY_NAMES = [
	// query parameters of the proxy's URL wire format
	"$cred",
	"$csr",
	"$dest",
	"$fakedataurl",
	"$fs",
	"$iframe",
	"$io",
	"$mode",
	"$module",
	"$pf",
	"$rfp",
	"$rfs",
	"$ro",
	"$tf",
	// the bundles' globals
	"$scramjet",
	"$scramjetController",
	"WASM",
	// the helpers rewritten code calls
	"$scramjet$call",
	"$scramjet$clean",
	"$scramjet$import",
	"$scramjet$meta",
	"$scramjet$prop",
	"$scramjet$pushsourcemap",
	"$scramjet$registerrealm",
	"$scramjet$rewrite",
	"$scramjet$standin",
	"$scramjet$tempcallee",
	"$scramjet$temploc",
	"$scramjet$tempreceiver",
	"$scramjet$tempunused",
	"$scramjet$tryset",
	"$scramjet$wrap",
	"$scramjet__",
	// message fields
	"$scramjet$data",
	"$scramjet$messagetype",
	"$scramjet$origin",
	"$scramjet$target",
	// symbol descriptions
	"scramjet client global",
	"scramjet interface name",
	"scramjet raw frames",
	// attributes, header carriers and generated frame names
	"scramjet-attr",
	"scramjet-injected",
	"scramjet-frame-",
	"x-scramjet-",
	// the controller's storage and channel
	"__scramjet_controller",
	"__scramjet_controller_channel",
] as const;

export type IdentityName = (typeof IDENTITY_NAMES)[number];
