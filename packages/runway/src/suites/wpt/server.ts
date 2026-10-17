/**
 * Launcher for the official wptserve, run from an upstream checkout.
 *
 * This starts `<wptRoot>/wpt serve --config <configPath>` — upstream's own server,
 * upstream's own Python tooling, upstream's own fixtures — and owns nothing else.
 * There is no second server here, no alternate origin, no rewritten fixture and no
 * substitute for `tools/wptserve`. wptserve is a *fixture server*; the canonical
 * Runway plan/lane/record pipeline remains the only thing that executes tests and
 * the only thing that produces results.
 *
 * Three properties are load-bearing.
 *
 * **Everything is caller-supplied.** The checkout path and the config path are
 * arguments. Nothing is discovered from a home directory, a sibling repository or
 * a working directory, and no path to a checkout is written down in this file.
 *
 * **Readiness is proved, not assumed.** A port that accepts a connection is not a
 * ready wptserve. So readiness is a real HTTP request for `/resources/testharness.js`
 * whose body is hashed and compared with the same file on disk in the checkout.
 * That single check establishes three things at once: the server answers, it is
 * serving *this* checkout as its document root, and the harness the browser will
 * load is the unmodified upstream file. A mismatch is a failure, never a warning.
 *
 * **Teardown touches only what was launched.** The child is spawned detached, so it
 * leads its own process group, and shutdown signals that group and nothing else.
 * No host file is edited, no certificate is trusted, no global state is installed,
 * and no unrelated process is signalled.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { platform as osPlatform } from "node:os";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { RunwayError } from "../../core/errors.ts";
import { CAPABILITIES, type CapabilityId } from "../../core/inventory.ts";
import type { FixtureProvenance } from "../../core/protocol.ts";

/**
 * Upstream's own CLI, inside the checkout the caller supplied.
 *
 * `wpt serve` is started directly: no wrapper entry ships with this package, so an
 * ordinary `npm`/`npx` consumer needs nothing beyond the checkout it already names
 * through the run config. Nothing is resolved from a sibling repository and nothing
 * is installed.
 */
const SERVE_COMMAND = "serve";

/** Upstream file whose bytes prove both readiness and document-root identity. */
export const READINESS_PATH = "/resources/testharness.js";

/** Bounded retention of the child's output, so a failure can be explained. */
const LOG_TAIL_BYTES = 64 * 1024;

export type WptServerRequest = {
	/** Absolute path to a complete upstream WPT checkout with its vendored `tools`. */
	readonly wptRoot: string;
	/**
	 * Absolute path to the wptserve config the caller owns.
	 *
	 * Passed through to `wpt serve --config`. Its contents are read here too, but
	 * only to compute the origins this launcher will claim: the server's behaviour
	 * comes from upstream reading the same file, never from this module.
	 */
	readonly configPath: string;
	/** Interpreter used to run the canonical entry. Defaults to `python3` on PATH. */
	readonly python?: string;
	/** How long to wait for a proved-ready server. Defaults to 60s. */
	readonly readyTimeoutMs?: number;
	/** How long each shutdown stage waits before escalating. Defaults to 5s. */
	readonly shutdownStageTimeoutMs?: number;
	readonly onStdout?: (chunk: string) => void;
	readonly onStderr?: (chunk: string) => void;
	/** Aborts a start that is still waiting for readiness. */
	readonly signal?: AbortSignal;
	/**
	 * Environment for the spawned server. Defaults to this process's environment.
	 *
	 * Explicit so the environment is the caller's choice rather than an ambient read
	 * of `process.env` inside a provider module.
	 *
	 * One environment, used for everything this launcher runs: the wptserve child,
	 * and the `lsof`/`ps` lookups that prove listener ownership. Splitting them —
	 * spawning with an explicit env while resolving tools from the ambient `PATH` —
	 * would mean the ownership prerequisite reported in an error was not the one
	 * actually applied, so a caller could not act on the message.
	 */
	readonly env?: NodeJS.ProcessEnv;
	/**
	 * Names of the POSIX utilities used to prove listener ownership.
	 *
	 * Resolved through the effective environment's `PATH`, exactly as spawning the
	 * server is. Overridable because the names are a genuine deployment prerequisite:
	 * a consumer may need to point at a specific build, and a test needs to exercise
	 * the "tool absent" branch without PATH surgery — on macOS wptserve itself needs
	 * `sysctl` from the same directory as `lsof`, so starving one starves the server.
	 */
	readonly ownershipTools?: { readonly lsof?: string; readonly ps?: string };
	/**
	 * Platform to apply the POSIX-only capability check against.
	 *
	 * Defaults to the real platform. Present so the refusal itself can be tested
	 * without pretending this module supports Windows.
	 */
	readonly platform?: NodeJS.Platform;
};

/**
 * Effective wptserve configuration, layered the way upstream layers it.
 *
 * `serve.py`'s `run()` applies `<wptRoot>/config.json` as an override *before* the
 * `--config` file, so an unnoticed `config.json` in a checkout silently changes the
 * hosts and ports a run used. It is therefore read and reported here rather than
 * ignored: {@link checkoutConfigPresent} says whether one took part.
 */
export type WptEffectiveConfig = {
	readonly browserHost: string;
	readonly alternateHosts: Readonly<Record<string, string>>;
	readonly serverHost: string | null;
	readonly httpPorts: readonly number[];
	readonly httpsPorts: readonly number[];
	/**
	 * Every scheme that will actually have a listener, with its numeric ports.
	 *
	 * The whole effective map, not just the two schemes that produce an origin: a
	 * readiness check that ignored the rest would be reporting on a server other
	 * than the one running.
	 */
	readonly enabledPorts: ReadonlyMap<string, readonly number[]>;
	readonly checkSubdomains: boolean;
	readonly checkoutConfigPresent: boolean;
	/** False when `ssl.type` is `none`; upstream then starts no https/wss listener. */
	readonly sslEnabled: boolean;
	/** Deprecated keys upstream would have renamed, as `old -> modern`. */
	readonly renamedKeys: readonly string[];
};

/** What was actually proved about one listener, and how. */
export type ListenerProof = {
	readonly scheme: string;
	readonly port: number;
	/** `http-hash` is a full content proof; `tcp-connect` only proves it listens. */
	readonly method: "http-hash" | "tcp-connect";
	readonly listening: boolean;
	/** Set only for `http-hash`. */
	readonly servedSha256?: string;
	/**
	 * True only where the protocol was actually exercised end to end.
	 *
	 * A TCP connect proves a listener accepted a socket. It does not establish TLS,
	 * HTTP/2 or WebSocket, and this flag stays false for those so that nothing
	 * downstream can read "listening" as "protocol established".
	 */
	readonly protocolEstablished: boolean;
	/** PIDs observed holding the listening socket, when they could be read. */
	readonly listeningPids: readonly number[];
	/**
	 * Who owns this listening socket.
	 *
	 * Three distinct states, never collapsed to a boolean:
	 *
	 * - `owned`      every PID holding the socket is in the group this launcher created.
	 * - `foreign`    at least one PID is outside it. Someone else is serving this port.
	 * - `unverifiable` ownership could not be established — the tools are missing, the
	 *   platform refused the query, or the socket reported no PID. This is *not*
	 *   `owned`, and it is not treated as one.
	 *
	 * Only `owned` grants the fixture capability. `foreign` and `unverifiable` both
	 * fail the start, because a handle that cannot prove what is serving it is a
	 * handle the canonical run might accept as evidence.
	 */
	readonly ownership: "owned" | "foreign" | "unverifiable";
	/** Why ownership is `foreign` or `unverifiable`. */
	readonly ownershipDetail: string | null;
};

export type WptServerHandle = {
	/** Origins this launcher proved are serving the checkout. HTTP only today. */
	readonly effectiveOrigins: readonly string[];
	/** The primary origin cases are loaded from. */
	readonly origin: string;
	/**
	 * Origins the config declares but this launcher does not claim.
	 *
	 * HTTPS ports live here. TLS is not established at this boundary — upstream's
	 * pregenerated certificate is issued for `web-platform.test`, and the loopback
	 * host a browser would actually be pointed at is not that name — so an https
	 * origin is reported as declared-and-unverified rather than being downgraded to
	 * http or presented with certificate errors ignored.
	 */
	readonly declaredUnverifiedOrigins: readonly string[];
	readonly config: WptEffectiveConfig;
	/** What was proved about each enabled listener, and by what method. */
	readonly listenerProofs: readonly ListenerProof[];
	/**
	 * Always true on a returned handle: ownership of every enabled listener is a
	 * precondition of the capability, so a start that could not prove it throws
	 * instead of returning. Kept on the handle so the receipt states it explicitly.
	 */
	readonly ownershipProven: true;
	/** Capabilities this fixture satisfies for the planner. */
	readonly capabilities: readonly CapabilityId[];
	/** Provenance for the record, with the identity actually read back. */
	readonly provenance: FixtureProvenance;
	readonly pid: number;
	/** Retained tail of the child's output. Diagnostic only. */
	readonly logTail: () => { readonly stdout: string; readonly stderr: string };
	/** Signals only this launcher's process group. Safe to call more than once. */
	readonly close: () => Promise<WptShutdownReport>;
};

export type WptShutdownReport = {
	/** Which escalation stage actually ended the group. */
	readonly endedBy: "sigint" | "sigterm" | "sigkill" | "already-exited";
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	/** True when the group was still reachable after SIGKILL and the wait expired. */
	readonly groupSurvived: boolean;
};

function serverFailed(
	message: string,
	details: Readonly<Record<string, unknown>>,
	remedy?: string,
	cause?: unknown
): RunwayError {
	return new RunwayError("fixtures/server-failed", message, {
		details,
		...(remedy === undefined ? {} : { remedy }),
		...(cause === undefined ? {} : { cause }),
	});
}

function capabilityUnavailable(
	message: string,
	details: Readonly<Record<string, unknown>>,
	remedy: string
): RunwayError {
	return new RunwayError("fixtures/capability-unavailable", message, { details, remedy });
}

async function readJsonFile(file: string, what: string): Promise<Record<string, unknown>> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (cause) {
		throw serverFailed(
			`the ${what} could not be read: ${file}`,
			{ file },
			"Pass an absolute path to a wptserve config JSON file the caller owns.",
			cause
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (cause) {
		throw serverFailed(`the ${what} is not valid JSON: ${file}`, { file }, undefined, cause);
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw serverFailed(`the ${what} is not a JSON object: ${file}`, { file });
	}
	return value as Record<string, unknown>;
}

/**
 * Port-list lengths upstream requires, from `serve.py`'s `start_servers`:
 * `assert len(ports) == {"http": 2, "https": 2}.get(scheme, 1)`.
 *
 * An empty list is fine for any scheme, because `wptserve/config.py`'s `_get_ports`
 * builds a `defaultdict` and never creates the key for a scheme with no ports — so
 * the assertion is not reached. Anything else fails inside upstream with a bare
 * `AssertionError` and no explanation, which is why the rule is checked here.
 */
const REQUIRED_PORT_COUNT: Readonly<Record<string, number>> = Object.freeze({
	http: 2,
	https: 2,
});

/**
 * Upstream's own default port map, from `tools/serve/serve.py` `ConfigBuilder._default`.
 *
 * This is modelled rather than assumed away, because upstream does **not** replace
 * the `ports` dict with the caller's — `wptserve/config.py`'s `_set_override` merges
 * dicts through `_merge_dict`, which iterates the *base* keys and takes the override
 * value only where the base already has that key. Two consequences drive the whole
 * design of this module:
 *
 * 1. A scheme the caller does not mention **keeps upstream's default**. A config that
 *    names only `http` still starts `https` on 8443/8444, `h2` on 9000 and `ws`/`wss`
 *    on auto-assigned ports. A launcher that reported "http only" for such a config
 *    would be describing a server that is not the one running.
 * 2. A key the caller adds that upstream does not have — `dns`, a typo'd scheme — is
 *    **silently dropped** by `_merge_dict`. The caller believes it configured or
 *    disabled something and nothing happened.
 *
 * `h2` is added to the defaults by `build_config` when HTTP/2 is enabled, which is
 * the default (`enable_http2 = True` unless `--no-h2`).
 */
const UPSTREAM_DEFAULT_PORTS: Readonly<Record<string, readonly (number | "auto")[]>> =
	Object.freeze({
		http: [8000, "auto"],
		"http-local": ["auto"],
		"http-public": ["auto"],
		https: [8443, 8444],
		"https-local": ["auto"],
		"https-public": ["auto"],
		ws: ["auto"],
		wss: ["auto"],
		"webtransport-h3": ["auto"],
		h2: [9000],
	} satisfies Record<string, readonly (number | "auto")[]>);

/**
 * Top-level config keys upstream's `ConfigBuilder._default` accepts.
 *
 * `update()` raises `KeyError("unknown config override '%s'")` for anything else, so
 * a config carrying an unknown top-level key does not start at all. Refusing it here
 * turns that into a diagnosable error instead of a Python traceback.
 */
const UPSTREAM_CONFIG_KEYS: readonly string[] = Object.freeze([
	"browser_host",
	"alternate_hosts",
	"doc_root",
	"ws_doc_root",
	"ws_extra",
	"server_host",
	"ports",
	"check_subdomains",
	"bind_address",
	"ssl",
	"aliases",
	"logging",
]);

/**
 * Keys upstream's `update()` still accepts, renamed, with a deprecation warning.
 *
 * `wptserve/config.py` `_renamed_props`. They are genuinely accepted, so refusing
 * them here would be this launcher inventing a rejection upstream does not perform.
 * They are mapped to their modern names instead, exactly as upstream does.
 *
 * Note what is deliberately *absent*: `subdomains` and `not_subdomains`. Those are
 * constructor keyword arguments (`ConfigBuilder.__init__` writes them straight into
 * `_data`), not entries in `_default`, so `update()` never pops them and a config
 * file carrying one hits upstream's `KeyError`. Listing them as accepted would have
 * been a false capability.
 */
const UPSTREAM_RENAMED_KEYS: Readonly<Record<string, string>> = Object.freeze({
	host: "browser_host",
	bind_hostname: "bind_address",
	external_host: "server_host",
	host_ip: "server_host",
});

/** Schemes this boundary can prove something about, and how. */
const HTTP_SCHEME = "http";

/**
 * Reads the port list for one scheme.
 *
 * `"auto"` is refused rather than resolved. Upstream picks a free port inside its
 * own process and reports it only through debug logging, so a launcher that
 * accepted `"auto"` would have to guess which port it got — and a guessed origin is
 * an origin nobody can verify. Explicit ports are a prerequisite this boundary
 * states instead of working around.
 */
function readPorts(
	ports: Record<string, unknown>,
	scheme: string,
	configPath: string
): number[] {
	const raw = ports[scheme];
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		throw serverFailed(`ports.${scheme} must be an array in ${configPath}`, { scheme });
	}
	const required = REQUIRED_PORT_COUNT[scheme] ?? 1;
	if (raw.length !== 0 && raw.length !== required) {
		throw capabilityUnavailable(
			`ports.${scheme} lists ${raw.length} port(s); upstream requires exactly ${required}`,
			{ scheme, listed: raw.length, required, configPath },
			`Give ports.${scheme} exactly ${required} entr${required === 1 ? "y" : "ies"} or none. ` +
				"upstream's serve.py asserts this count in start_servers and would otherwise fail " +
				"with a bare AssertionError."
		);
	}
	const result: number[] = [];
	for (const item of raw) {
		// Upstream skips a `null` entry in start_servers (`if port is None: continue`),
		// so it is a legitimate way to declare a scheme off while still satisfying the
		// count above. It contributes no origin, so nothing is recorded for it.
		if (item === null) continue;
		if (item === "auto") {
			throw capabilityUnavailable(
				`ports.${scheme} contains "auto", which this launcher cannot verify`,
				{ scheme, configPath },
				'Give every port an explicit number in the config: wptserve resolves "auto" inside ' +
					"its own process and only reports the result through debug logging, so the origin " +
					"could not be read back and proved.",
			);
		}
		if (typeof item !== "number" || !Number.isInteger(item) || item < 1 || item > 65_535) {
			throw serverFailed(`ports.${scheme} contains a value that is not a TCP port`, {
				scheme,
				value: item,
				configPath,
			});
		}
		result.push(item);
	}
	return result;
}

/**
 * Computes the configuration upstream will actually use, in upstream's own order.
 *
 * `serve.py` defaults, then `<wptRoot>/config.json`, then the `--config` file. Only
 * the fields this launcher needs in order to name an origin are resolved; the rest
 * stays upstream's business.
 */
export async function resolveEffectiveConfig(request: {
	readonly wptRoot: string;
	readonly configPath: string;
}): Promise<WptEffectiveConfig> {
	// Upstream's own defaults, from tools/serve/serve.py ConfigBuilder._default.
	let browserHost = "web-platform.test";
	let alternateHosts: Record<string, string> = { alt: "not-web-platform.test" };
	let serverHost: string | null = null;
	let checkSubdomains = true;
	// Every scheme starts at upstream's default and is overridden per key, exactly
	// as _merge_dict does. Nothing is presumed absent.
	const effectivePorts = new Map<string, readonly (number | "auto" | null)[]>(
		Object.entries(UPSTREAM_DEFAULT_PORTS)
	);
	const explicitlyAddressed = new Set<string>();
	const renamedKeys: string[] = [];
	// Upstream default is a pregenerated cert, i.e. SSL enabled.
	let sslEnabled = true;

	const checkoutConfig = path.join(request.wptRoot, "config.json");
	let checkoutConfigPresent = false;
	try {
		checkoutConfigPresent = (await stat(checkoutConfig)).isFile();
	} catch {
		checkoutConfigPresent = false;
	}

	const layers: string[] = [];
	if (checkoutConfigPresent) layers.push(checkoutConfig);
	layers.push(request.configPath);

	for (const layer of layers) {
		const what =
			layer === checkoutConfig ? "wptserve config in the checkout root" : "wptserve config";
		const rawConfig = await readJsonFile(layer, what);
		// Upstream renames these before validating, so the same is done here rather
		// than pretending it rejects them.
		const config: Record<string, unknown> = { ...rawConfig };
		for (const [old, modern] of Object.entries(UPSTREAM_RENAMED_KEYS)) {
			if (!(old in config)) continue;
			if (modern in config) {
				throw serverFailed(
					`${layer} sets both ${old} and its modern name ${modern}`,
					{ config: layer, deprecated: old, modern },
					`upstream renames ${old} to ${modern}; setting both is ambiguous. Keep ${modern}.`
				);
			}
			config[modern] = config[old];
			delete config[old];
			renamedKeys.push(`${old} -> ${modern}`);
		}
		if (typeof config.browser_host === "string") browserHost = config.browser_host;
		if (config.alternate_hosts !== undefined) {
			if (
				config.alternate_hosts === null ||
				typeof config.alternate_hosts !== "object" ||
				Array.isArray(config.alternate_hosts)
			) {
				throw serverFailed(`alternate_hosts must be an object in ${layer}`, { config: layer });
			}
			const next: Record<string, string> = {};
			for (const [key, value] of Object.entries(config.alternate_hosts)) {
				if (typeof value !== "string") {
					throw serverFailed(`alternate_hosts.${key} must be a string in ${layer}`, {
						config: layer,
					});
				}
				next[key] = value;
			}
			alternateHosts = next;
		}
		if (config.server_host !== undefined) {
			if (config.server_host !== null && typeof config.server_host !== "string") {
				throw serverFailed(`server_host must be a string or null in ${layer}`, { config: layer });
			}
			serverHost = config.server_host as string | null;
		}
		if (config.ssl !== undefined) {
			if (config.ssl === null || typeof config.ssl !== "object" || Array.isArray(config.ssl)) {
				throw serverFailed(`ssl must be an object in ${layer}`, { config: layer });
			}
			const sslType = (config.ssl as Record<string, unknown>).type;
			if (sslType !== undefined) {
				if (typeof sslType !== "string") {
					throw serverFailed(`ssl.type must be a string in ${layer}`, { config: layer });
				}
				// wptserve/sslutils: `base.NoSSLEnvironment.ssl_enabled = False`, while the
				// openssl and pregenerated environments set it True. `_get_ports` skips
				// the https and wss schemes entirely when SSL is disabled, so those
				// listeners never start and must not be counted as enabled.
				sslEnabled = sslType !== "none";
			}
		}
		if (config.check_subdomains !== undefined) {
			if (typeof config.check_subdomains !== "boolean") {
				throw serverFailed(`check_subdomains must be a boolean in ${layer}`, { config: layer });
			}
			checkSubdomains = config.check_subdomains;
		}
		// Unknown top-level keys are refused, not ignored: upstream's
		// ConfigBuilder.update() raises KeyError for anything outside its defaults,
		// so such a config does not start at all.
		for (const key of Object.keys(config)) {
			if (!UPSTREAM_CONFIG_KEYS.includes(key)) {
				throw serverFailed(
					`${layer} sets the unknown top-level config key ${JSON.stringify(key)}`,
					{ config: layer, key, known: UPSTREAM_CONFIG_KEYS },
					"upstream's ConfigBuilder.update() raises KeyError for a key outside its " +
						"defaults, so this config would not start. Remove or correct the key."
				);
			}
		}
		if (config.ports !== undefined) {
			if (config.ports === null || typeof config.ports !== "object" || Array.isArray(config.ports)) {
				throw serverFailed(`ports must be an object in ${layer}`, { config: layer });
			}
			const ports = config.ports as Record<string, unknown>;
			for (const scheme of Object.keys(ports)) {
				// A scheme upstream's defaults do not contain is dropped by _merge_dict.
				// The caller thinks they configured or disabled something; nothing
				// happened. Refused rather than passed through as a false capability.
				if (!(scheme in UPSTREAM_DEFAULT_PORTS)) {
					throw serverFailed(
						`${layer} sets ports.${scheme}, which upstream's defaults do not contain`,
						{ config: layer, scheme, known: Object.keys(UPSTREAM_DEFAULT_PORTS) },
						"upstream merges the ports dict with _merge_dict, which iterates the default " +
							"keys only, so this entry is silently discarded and configures nothing. " +
							"Remove it, or use a scheme upstream actually serves."
					);
				}
				// Count is checked for every scheme, not only the ones that make an
				// origin: a bad count on ws or h2 fails just as hard inside upstream,
				// and finding out from a bare AssertionError is not a diagnosis.
				effectivePorts.set(scheme, readPorts(ports, scheme, layer));
				explicitlyAddressed.add(scheme);
			}
		}
	}

	/*
	 * Require the caller to have addressed every scheme upstream would start.
	 *
	 * Anything left at its default either carries "auto" — a port upstream assigns
	 * inside its own process and reports only through debug logging, so no origin
	 * for it could ever be read back and proved — or a fixed default port this
	 * launcher was not told to expect. Silently presuming "http only" would mean
	 * reporting a server that is not the one running, so the unaddressed schemes are
	 * named and the caller is asked to be explicit, including explicitly disabling
	 * what it does not want.
	 */
	/*
	 * Schemes upstream itself drops when SSL is off.
	 *
	 * Exactly two. `wptserve/config.py` `_get_ports` reads
	 * `if scheme in ["wss", "https"] and not ssl_enabled: continue` — so
	 * `https-local` and `https-public` are NOT skipped and their listeners are still
	 * started. Treating those as dropped would silently exclude them from the enabled
	 * set, and a listener that then failed to start would go unobserved: precisely the
	 * unnoticed-partial-server case the readiness check exists to catch.
	 */
	const sslDependent = new Set(["https", "wss"]);
	if (!sslEnabled) {
		for (const scheme of sslDependent) effectivePorts.set(scheme, []);
	}
	const unaddressed = [...effectivePorts.keys()]
		.filter((scheme) => !explicitlyAddressed.has(scheme))
		.filter((scheme) => (effectivePorts.get(scheme) ?? []).length > 0)
		.sort();
	if (unaddressed.length > 0) {
		throw capabilityUnavailable(
			`the wptserve config does not address ${unaddressed.length} scheme(s) upstream would ` +
				`still start: ${unaddressed.join(", ")}`,
			{
				configPath: request.configPath,
				unaddressed,
				defaults: Object.fromEntries(
					unaddressed.map((scheme) => [scheme, [...(UPSTREAM_DEFAULT_PORTS[scheme] ?? [])]])
				),
			},
			"upstream merges ports per scheme rather than replacing the dict, so a scheme you do " +
				"not mention keeps its default and its listener still starts. Give every scheme an " +
				"explicit entry: a numeric port list to enable it, or [] to disable it."
		);
	}

	// Anything still carrying "auto" was addressed explicitly but cannot be verified.
	const automatic = [...effectivePorts.entries()]
		.filter(([, ports]) => ports.includes("auto"))
		.map(([scheme]) => scheme)
		.sort();
	if (automatic.length > 0) {
		throw capabilityUnavailable(
			`ports for ${automatic.join(", ")} are "auto", which this launcher cannot verify`,
			{ configPath: request.configPath, automatic },
			'Give every enabled port an explicit number: wptserve resolves "auto" inside its own ' +
				"process and only reports the result through debug logging, so the origin could not " +
				"be read back and proved."
		);
	}

	const numericPorts = new Map<string, readonly number[]>();
	for (const [scheme, ports] of effectivePorts) {
		const numeric = ports.filter((port): port is number => typeof port === "number");
		if (numeric.length > 0) numericPorts.set(scheme, Object.freeze(numeric));
	}

	return Object.freeze({
		browserHost,
		alternateHosts: Object.freeze(alternateHosts),
		serverHost,
		httpPorts: Object.freeze(numericPorts.get("http") ?? []),
		httpsPorts: Object.freeze(numericPorts.get("https") ?? []),
		enabledPorts: Object.freeze(new Map(numericPorts)),
		checkSubdomains,
		checkoutConfigPresent,
		sslEnabled,
		renamedKeys: Object.freeze(renamedKeys),
	});
}

/** Host part of an origin, bracketed when it is a literal IPv6 address. */
function hostForUrl(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function originFor(scheme: "http" | "https", host: string, port: number): string {
	return `${scheme}://${hostForUrl(host)}:${port}`;
}

/** True when something is already listening. Used before launch, never after. */
function portInUse(host: string, port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host, port });
		const done = (value: boolean): void => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

async function assertCheckout(wptRoot: string): Promise<void> {
	const required = [
		"wpt",
		path.join("tools", "serve", "serve.py"),
		path.join("tools", "wptserve"),
		READINESS_PATH.slice(1),
	];
	for (const relative of required) {
		const target = path.join(wptRoot, relative);
		try {
			await stat(target);
		} catch {
			throw capabilityUnavailable(
				`the supplied WPT checkout is missing ${relative}`,
				{ wptRoot, missing: relative },
				"Pass the root of a complete upstream web-platform-tests checkout, including its " +
					"vendored tools/ directory. This launcher never downloads or repairs a checkout."
			);
		}
	}
}

async function hashFile(file: string): Promise<string> {
	const bytes = await readFile(file);
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Proves the server is ready by reading the harness back and hashing it.
 *
 * Returns the hash when the served bytes equal the checkout's. Anything else — a
 * connection error, a non-200, or different bytes — is `null`, so the caller keeps
 * waiting until the deadline and then fails with the last reason.
 */
async function probeReadiness(
	origin: string,
	expectedSha256: string
): Promise<{ readonly ok: true; readonly sha256: string } | { readonly ok: false; readonly reason: string }> {
	let response: Response;
	try {
		response = await fetch(`${origin}${READINESS_PATH}`, {
			redirect: "error",
			headers: { "cache-control": "no-cache" },
		});
	} catch (cause) {
		return { ok: false, reason: `request failed: ${cause instanceof Error ? cause.message : String(cause)}` };
	}
	if (response.status !== 200) {
		return { ok: false, reason: `the server answered ${response.status} for ${READINESS_PATH}` };
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	if (sha256 !== expectedSha256) {
		return {
			ok: false,
			reason:
				`${READINESS_PATH} was served with sha256 ${sha256}, but the checkout's copy is ` +
				`${expectedSha256}. Something other than this checkout is answering on this origin.`,
		};
	}
	return { ok: true, sha256 };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true }
		);
	});
}

/** Opens a TCP connection. Proves a listener exists; proves nothing about protocol. */
function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host, port });
		const done = (value: boolean): void => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(value);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

/** Outcome of asking the OS who holds a socket. Absence != emptiness. */
type PidQuery =
	| { readonly kind: "pids"; readonly pids: readonly number[] }
	/** The tool ran and matched nothing. A real answer: nothing is listening. */
	| { readonly kind: "none" }
	/** The tool is missing, failed, or timed out. Not an answer at all. */
	| { readonly kind: "unavailable"; readonly detail: string };

/**
 * Runs a utility resolved through `PATH`.
 *
 * Deliberately not an absolute path: `/usr/sbin/lsof` is a macOS layout, and on
 * Linux distributions it is `/usr/bin/lsof`. Hard-coding one makes ownership
 * silently unverifiable on the other, which — now that ownership is mandatory —
 * would turn into a confusing startup failure for an npm consumer on Linux.
 * `PATH` resolution plus an explicit "tool missing" state is what makes the
 * prerequisite diagnosable instead.
 */
function runTool(
	command: string,
	args: readonly string[],
	timeoutMs: number,
	env: NodeJS.ProcessEnv
): Promise<{ readonly code: number | null; readonly stdout: string; readonly error: Error | null }> {
	return new Promise((resolve) => {
		void import("node:child_process").then(({ execFile }) => {
			// A bounded deadline with `killSignal`, so a hung utility cannot hold the
			// startup path open; the callback fires once either way.
			const child = execFile(
				command,
				[...args],
				{ timeout: timeoutMs, killSignal: "SIGKILL", env },
				(error, stdout) => {
					resolve({
						code: child.exitCode,
						stdout: typeof stdout === "string" ? stdout : "",
						error: error ?? null,
					});
				}
			);
		});
	});
}

/**
 * PIDs holding a listening socket on `port`.
 *
 * This is what turns "something is serving the right bytes" into "the process this
 * launcher started is serving them". A content hash alone cannot do that: another
 * process serving the same checkout would produce an identical hash, and the
 * pre-launch port check is a reserve-and-close race that proves nothing about who
 * bound the port afterwards.
 *
 * `lsof -t` exits 1 when it simply matched nothing, which is a legitimate answer
 * ("no listener") and must not be confused with the tool being absent or failing —
 * they lead to opposite conclusions.
 */
async function listeningPids(
	port: number,
	env: NodeJS.ProcessEnv,
	tool: string
): Promise<PidQuery> {
	const result = await runTool(tool, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], 5_000, env);
	const pids = result.stdout
		.split("\n")
		.map((line) => Number.parseInt(line.trim(), 10))
		.filter((value) => Number.isInteger(value) && value > 0);
	if (pids.length > 0) return { kind: "pids", pids };
	if (result.error === null) return { kind: "none" };
	const code = (result.error as NodeJS.ErrnoException).code;
	if (code === "ENOENT") {
		return {
			kind: "unavailable",
			detail: `${tool} was not found on PATH`,
		};
	}
	// Exit 1 with no output is lsof's "no match", not a failure.
	if (result.code === 1) return { kind: "none" };
	return {
		kind: "unavailable",
		detail: `${tool} failed: ${result.error.message}`,
	};
}

/** The process group a pid belongs to. */
async function processGroupOf(
	pid: number,
	env: NodeJS.ProcessEnv,
	tool: string
): Promise<{ readonly kind: "pgid"; readonly pgid: number } | { readonly kind: "unavailable"; readonly detail: string }> {
	const result = await runTool(tool, ["-o", "pgid=", "-p", String(pid)], 5_000, env);
	const value = Number.parseInt(result.stdout.trim(), 10);
	if (Number.isInteger(value)) return { kind: "pgid", pgid: value };
	const code = (result.error as NodeJS.ErrnoException | null)?.code;
	if (code === "ENOENT") {
		return { kind: "unavailable", detail: `${tool} was not found on PATH` };
	}
	// ps exits 1 when the pid is gone; that is an answer, but not one that lets us
	// attribute the socket, so it stays unverifiable rather than becoming "foreign".
	return {
		kind: "unavailable",
		detail: `${tool} could not report a process group for pid ${pid}`,
	};
}

/** True while the process group is still reachable. `ESRCH` means it is gone. */
function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Starts the official wptserve and returns a handle only once it is proved ready.
 *
 * On any failure the child is torn down before the error propagates, so a failed
 * start never leaves a server behind.
 */
export async function startWptServer(request: WptServerRequest): Promise<WptServerHandle> {
	const wptRoot = path.resolve(request.wptRoot);
	const configPath = path.resolve(request.configPath);
	const readyTimeoutMs = request.readyTimeoutMs ?? 60_000;
	const shutdownStageTimeoutMs = request.shutdownStageTimeoutMs ?? 5_000;
	const python = request.python ?? "python3";
	const platform = request.platform ?? osPlatform();
	// One effective environment for the child and for the ownership tools.
	const effectiveEnv: NodeJS.ProcessEnv = { ...(request.env ?? process.env) };
	const lsofTool = request.ownershipTools?.lsof ?? "lsof";
	const psTool = request.ownershipTools?.ps ?? "ps";

	/*
	 * Declared before anything is spawned, not discovered after it fails.
	 *
	 * Teardown here is POSIX process-group semantics throughout: the child is spawned
	 * `detached` so it leads its own group, and shutdown addresses `kill(-pid, …)`.
	 * Windows has no process groups in that sense and no `SIGINT`/`SIGKILL` delivery
	 * to one, so a server started there could not be reliably torn down — it would
	 * leave wptserve's `multiprocessing` children running and holding the ports.
	 * Ownership proof below likewise uses `lsof`/`ps`. Refusing up front states that
	 * honestly, instead of starting a server and surfacing an obscure failure at
	 * shutdown, when a leaked server is already the outcome.
	 */
	if (platform === "win32") {
		throw capabilityUnavailable(
			"this wptserve launcher supports POSIX platforms only",
			{ platform },
			"Teardown depends on POSIX process groups (spawn detached, kill(-pid, SIGINT/TERM/KILL)) " +
				"and on lsof/ps for listener-ownership proof, none of which apply on win32. Running " +
				"here would risk leaving wptserve's multiprocessing children holding the ports."
		);
	}

	await assertCheckout(wptRoot);
	const config = await resolveEffectiveConfig({ wptRoot, configPath });

	if (config.checkSubdomains) {
		throw capabilityUnavailable(
			"the wptserve config leaves check_subdomains enabled",
			{ configPath, browserHost: config.browserHost },
			'Set "check_subdomains": false in the config. Upstream otherwise verifies that its ' +
				"subdomain hosts resolve, which requires entries in the system hosts file; this " +
				"launcher edits no host file and installs no resolver.",
		);
	}
	const httpPort = config.httpPorts[0];
	if (httpPort === undefined) {
		throw capabilityUnavailable(
			"the wptserve config declares no http port",
			{ configPath },
			'Declare at least one explicit port in "ports".http. This boundary serves testharness ' +
				"documents over plain HTTP only.",
		);
	}

	const origin = originFor("http", config.browserHost, httpPort);
	const effectiveOrigins = config.httpPorts.map((port) =>
		originFor("http", config.browserHost, port)
	);
	const declaredUnverifiedOrigins = config.httpsPorts.map((port) =>
		originFor("https", config.browserHost, port)
	);

	/*
	 * Collision check across every enabled scheme, not only http.
	 *
	 * This is a pre-flight courtesy, and it is deliberately not treated as proof of
	 * ownership: between this check and the child binding the port, anything could
	 * take it — the classic reserve-and-close race. Ownership is established after
	 * startup instead, by reading which PIDs hold the listening socket and checking
	 * they are in the group this launcher created.
	 */
	for (const [scheme, ports] of config.enabledPorts) {
		for (const port of ports) {
			if (await portInUse(config.browserHost, port, 1_000)) {
				throw capabilityUnavailable(
					`something is already listening on ${config.browserHost}:${port} (scheme ${scheme})`,
					{ port, scheme, browserHost: config.browserHost },
					"Stop the existing listener, or give this run its own ports. This launcher will " +
						"not adopt a server it did not start, because it cannot prove what that " +
						"server serves."
				);
			}
		}
	}

	const harnessFile = path.join(wptRoot, READINESS_PATH.slice(1));
	const expectedSha256 = await hashFile(harnessFile);

	let stdoutTail = "";
	let stderrTail = "";
	const appendTail = (current: string, chunk: string): string => {
		const next = current + chunk;
		return next.length > LOG_TAIL_BYTES ? next.slice(next.length - LOG_TAIL_BYTES) : next;
	};

	// Upstream's own `wpt serve`, reading the same `--config` this launcher resolved.
	// Nothing wraps it: server behaviour is upstream's, and this module only starts
	// it, proves readiness from its socket, and owns its shutdown.
	const serveArgv = [path.join(wptRoot, "wpt"), SERVE_COMMAND, "--config", configPath];

	let child: ChildProcess;
	try {
		child = spawn(python, serveArgv, {
			cwd: wptRoot,
			// Its own process group, so shutdown can signal the whole tree wptserve
			// spawns (it uses multiprocessing) and nothing outside it.
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...effectiveEnv,
				// Upstream's serve command declares no virtualenv and installs nothing;
				// this only keeps it from writing __pycache__ into the caller's checkout.
				PYTHONDONTWRITEBYTECODE: "1",
			},
		});
	} catch (cause) {
		throw serverFailed(
			`the wptserve process could not be spawned with ${python}`,
			{ python, wptRoot },
			"Install a Python 3 interpreter on PATH, or pass `python` explicitly. `wpt serve` " +
				"declares no virtualenv and needs no pip install.",
			cause
		);
	}

	const pid = child.pid;
	if (pid === undefined) {
		// Node reports a failed exec asynchronously via the "error" event and leaves
		// `pid` undefined. The common cause by far is the interpreter not being on
		// PATH, so say that rather than reporting the symptom.
		throw serverFailed(
			`the wptserve process could not be started with ${JSON.stringify(python)}`,
			{ python, wptRoot, path: effectiveEnv.PATH ?? null },
			"No process was created, which usually means the interpreter was not found. Pass an " +
				"absolute path via `python`, or make python3 resolvable on PATH."
		);
	}

	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdoutTail = appendTail(stdoutTail, chunk);
		request.onStdout?.(chunk);
	});
	child.stderr?.on("data", (chunk: string) => {
		stderrTail = appendTail(stderrTail, chunk);
		request.onStderr?.(chunk);
	});

	let exited: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null = null;
	const exit = new Promise<void>((resolve) => {
		child.once("exit", (code, signal) => {
			exited = { code, signal };
			resolve();
		});
	});
	let spawnError: Error | null = null;
	child.once("error", (error) => {
		spawnError = error;
	});

	let closed: Promise<WptShutdownReport> | null = null;
	const close = (): Promise<WptShutdownReport> => {
		if (closed) return closed;
		closed = (async (): Promise<WptShutdownReport> => {
			const leaderExit = (): { code: number | null; signal: NodeJS.Signals | null } | null =>
				exited as { code: number | null; signal: NodeJS.Signals | null } | null;
			/**
			 * Shutdown is only finished when the *group* is gone, not when the leader is.
			 *
			 * wptserve is a `multiprocessing` parent: `serve.py` asks each server
			 * subprocess to stop, waits one second, logs "shutdown timed out" for any
			 * straggler, and returns anyway. So the leader can exit 0 while its children
			 * are still holding the listening sockets. Treating the leader's exit as the
			 * end of shutdown is how a "clean" teardown leaks worker processes and keeps
			 * the ports bound for the next run.
			 */
			const settled = (): boolean => leaderExit() !== null && !groupAlive(pid);
			if (settled()) {
				const detail = leaderExit()!;
				return Object.freeze({
					endedBy: "already-exited" as const,
					exitCode: detail.code,
					signal: detail.signal,
					groupSurvived: false,
				});
			}
			// Escalation, bounded at each stage. SIGINT first because that is the path
			// upstream handles itself: serve.py catches KeyboardInterrupt and asks each
			// server subprocess to shut down. The target is always the negative pid of
			// the child this module spawned, which is its own group leader, so no
			// process outside that group is ever addressed.
			const stages: readonly {
				readonly signal: "SIGINT" | "SIGTERM" | "SIGKILL";
				readonly label: WptShutdownReport["endedBy"];
			}[] = [
				{ signal: "SIGINT", label: "sigint" },
				{ signal: "SIGTERM", label: "sigterm" },
				{ signal: "SIGKILL", label: "sigkill" },
			];
			let endedBy: WptShutdownReport["endedBy"] = "sigkill";
			for (const stage of stages) {
				try {
					process.kill(-pid, stage.signal);
				} catch (error) {
					// The group is already gone. Nothing outside it was ever addressed.
					if ((error as NodeJS.ErrnoException).code === "ESRCH") {
						endedBy = stage.label;
						break;
					}
					throw serverFailed(
						`the wptserve process group could not be signalled with ${stage.signal}`,
						{ pid, stage: stage.signal },
						undefined,
						error
					);
				}
				// Poll rather than waiting only on the leader's exit: the condition is the
				// group's disappearance, and only the leader has an exit event.
				const deadlineAt = Date.now() + shutdownStageTimeoutMs;
				while (Date.now() < deadlineAt) {
					if (settled()) break;
					await Promise.race([exit, delay(50)]);
					if (settled()) break;
				}
				if (settled()) {
					endedBy = stage.label;
					break;
				}
			}
			const detail = leaderExit();
			return Object.freeze({
				endedBy,
				exitCode: detail === null ? null : detail.code,
				signal: detail === null ? null : detail.signal,
				groupSurvived: !settled(),
			});
		})();
		return closed;
	};

	/**
	 * Tears down and reports, without ever replacing the caller's primary error.
	 *
	 * A failing start has one story worth telling — why it failed. If cleanup also
	 * fails, that is a second fact to carry, not a reason to lose the first, so this
	 * captures the teardown outcome (or its error) as data.
	 */
	const closeSafely = async (): Promise<Readonly<Record<string, unknown>>> => {
		try {
			const report = await close();
			return Object.freeze({
				endedBy: report.endedBy,
				exitCode: report.exitCode,
				signal: report.signal,
				groupSurvived: report.groupSurvived,
			});
		} catch (error) {
			return Object.freeze({
				cleanupFailed: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const deadline = Date.now() + readyTimeoutMs;
	let lastReason = "the server had not answered yet";
	let servedSha256: string | null = null;
	while (Date.now() < deadline) {
		if (request.signal?.aborted) {
			const teardown = await closeSafely();
			throw serverFailed(
				"starting wptserve was aborted before the server was ready",
				{ pid, origin, teardown }
			);
		}
		if (spawnError !== null) {
			const teardown = await closeSafely();
			throw serverFailed(
				`the wptserve process failed to start: ${(spawnError as Error).message}`,
				{ python, wptRoot, stderr: stderrTail.slice(-4_000), teardown },
				"`wpt serve` needs a Python 3 interpreter and the checkout's vendored tools.",
				spawnError
			);
		}
		if (exited !== null) {
			const detail = exited as { code: number | null; signal: NodeJS.Signals | null };
			// The leader is gone, but the group may not be: wptserve is a
			// multiprocessing parent, so a leader that dies during startup can leave
			// server children running and holding the ports. close() is therefore
			// awaited here too — a failed start must not leak a half-started server —
			// and its own outcome is reported alongside, never in place of, the
			// startup error that actually explains the failure.
			const teardown = await closeSafely();
			throw serverFailed(
				`wptserve exited before becoming ready (code ${detail.code}, signal ${detail.signal})`,
				{
					pid,
					exitCode: detail.code,
					signal: detail.signal,
					configPath,
					stdout: stdoutTail.slice(-4_000),
					stderr: stderrTail.slice(-4_000),
					teardown,
				},
				"Run the same command by hand to see upstream's own diagnostics: " +
					`${python} wpt serve --config <config> from ${wptRoot}.`
			);
		}
		const probe = await probeReadiness(origin, expectedSha256);
		if (probe.ok) {
			servedSha256 = probe.sha256;
			break;
		}
		lastReason = probe.reason;
		await delay(250, request.signal);
	}

	if (servedSha256 === null) {
		const teardown = await closeSafely();
		throw serverFailed(
			`wptserve did not become ready on ${origin} within ${readyTimeoutMs}ms: ${lastReason}`,
			{
				origin,
				readyTimeoutMs,
				lastReason,
				configPath,
				stdout: stdoutTail.slice(-4_000),
				stderr: stderrTail.slice(-4_000),
				teardown,
			},
			`Readiness is a real request for ${READINESS_PATH} whose bytes must hash to the ` +
				"checkout's copy. A server that answers with different bytes is not this checkout."
		);
	}

	/*
	 * Prove every enabled listener, not just the one that answered a single fetch.
	 *
	 * The HTTP hash probe above establishes that *an* http listener serves this
	 * checkout. It says nothing about the https, h2, ws or wss listeners the config
	 * enabled. upstream starts each scheme in its own subprocess, and one of them can
	 * fail while the leader stays healthy — `start_servers` logs and continues for an
	 * incompatible h2, for instance. Reporting readiness off one fetch would claim a
	 * server that is only partly running.
	 *
	 * So each enabled port is probed. The http ports already have a content proof;
	 * everything else gets a TCP connect, which proves a listener accepted a socket
	 * and explicitly does *not* establish the protocol — `protocolEstablished` stays
	 * false for those, and TLS in particular is never claimed from a connect.
	 */
	const proofs: ListenerProof[] = [];
	const missingListeners: string[] = [];
	const notOwned: string[] = [];
	for (const [scheme, ports] of config.enabledPorts) {
		for (const port of ports) {
			// Every http port gets a content proof, not just the primary one: the
			// secondary http port serves the same document root and is a real origin a
			// case can be loaded from, so claiming it "serves this checkout" on the
			// strength of a TCP connect would be an unproven claim about an origin the
			// handle publishes.
			const contentProvable = scheme === HTTP_SCHEME;
			let listening: boolean;
			let served: string | null = null;
			if (contentProvable) {
				const probe = await probeReadiness(
					originFor("http", config.browserHost, port),
					expectedSha256
				);
				listening = probe.ok;
				served = probe.ok ? probe.sha256 : null;
			} else {
				listening = await tcpProbe(config.browserHost, port, 2_000);
			}
			if (!listening) missingListeners.push(`${scheme}:${port}`);

			// Ownership, for every enabled listener. A foreign process holding any
			// configured port means this launcher is not the thing serving it.
			let ownership: ListenerProof["ownership"] = "unverifiable";
			let ownershipDetail: string | null = null;
			let pids: readonly number[] = [];
			if (listening) {
				const query = await listeningPids(port, effectiveEnv, lsofTool);
				if (query.kind === "unavailable") {
					ownershipDetail = query.detail;
				} else if (query.kind === "none") {
					ownershipDetail =
						"the OS reported no process holding this listening socket, so it could not be attributed";
				} else {
					pids = query.pids;
					const groups = await Promise.all(
						pids.map((candidate) => processGroupOf(candidate, effectiveEnv, psTool))
					);
					const unavailable = groups.find((group) => group.kind === "unavailable");
					const foreign = groups.filter(
						(group) => group.kind === "pgid" && group.pgid !== pid
					);
					if (foreign.length > 0) {
						ownership = "foreign";
						ownershipDetail =
							`process group(s) ${foreign
								.map((group) => (group.kind === "pgid" ? group.pgid : "?"))
								.join(", ")} hold this socket, not this launcher's group ${pid}`;
					} else if (unavailable !== undefined) {
						ownershipDetail =
							unavailable.kind === "unavailable" ? unavailable.detail : "unknown";
					} else {
						ownership = "owned";
					}
				}
			}
			if (listening && ownership !== "owned") {
				notOwned.push(`${scheme}:${port} (${ownership}: ${ownershipDetail ?? "no detail"})`);
			}
			proofs.push(
				Object.freeze({
					scheme,
					port,
					method: contentProvable ? ("http-hash" as const) : ("tcp-connect" as const),
					listening,
					...(served === null ? {} : { servedSha256: served }),
					protocolEstablished: contentProvable && listening,
					listeningPids: Object.freeze([...pids]),
					ownership,
					ownershipDetail,
				})
			);
		}
	}

	// A required listener that never came up is a failure, even though the leader is
	// healthy and the primary http probe succeeded. Tear down rather than hand back a
	// handle describing a server that is only partly there.
	if (missingListeners.length > 0) {
		const teardown = await closeSafely();
		throw serverFailed(
			`wptserve is running but ${missingListeners.length} enabled listener(s) never came up: ` +
				missingListeners.join(", "),
			{
				origin,
				missingListeners,
				configPath,
				stdout: stdoutTail.slice(-4_000),
				stderr: stderrTail.slice(-4_000),
				teardown,
			},
			"Every scheme enabled in the config must have a listening socket. upstream starts each " +
				"scheme in its own subprocess and can log-and-continue when one cannot start (an " +
				"h2 listener without the h2 module, for example), so the leader staying healthy is " +
				"not evidence that all of them did."
		);
	}

	/*
	 * Ownership is a precondition of the capability, not an annotation on it.
	 *
	 * Previously this was advisory: the handle always declared `fixtures/wpt-server`
	 * and merely recorded whether ownership had been proved. That means a run could
	 * be handed a server it could not attribute — a foreign process on a configured
	 * port, or a machine where the query tools are absent — and the canonical runner
	 * would accept the capability at face value. Failing the start is the simpler and
	 * safer contract: there is then no handle for anything downstream to accept.
	 *
	 * Teardown still only ever addresses this launcher's own process group. A foreign
	 * listener is reported, never signalled.
	 */
	if (notOwned.length > 0) {
		const teardown = await closeSafely();
		const foreign = proofs.filter((proof) => proof.ownership === "foreign");
		throw serverFailed(
			foreign.length > 0
				? `a process outside this launcher's group holds ${foreign.length} configured ` +
					`listening socket(s): ${notOwned.join("; ")}`
				: `ownership of ${notOwned.length} configured listening socket(s) could not be ` +
					`verified: ${notOwned.join("; ")}`,
			{
				origin,
				notOwned,
				launchedGroup: pid,
				configPath,
				teardown,
				foreignListeners: foreign.map((proof) => ({
					scheme: proof.scheme,
					port: proof.port,
					pids: [...proof.listeningPids],
				})),
			},
			foreign.length > 0
				? "Stop the other server, or give this run its own ports. The foreign process was " +
					"reported and deliberately not signalled: teardown only ever addresses the " +
					"process group this launcher created."
				: "Ownership is proved with lsof and ps, resolved through PATH. Install them (POSIX " +
					"utilities prerequisite) or run where they are permitted. The capability is not " +
					"granted on an unverifiable socket, because a handle that cannot prove what is " +
					"serving it could be accepted downstream as evidence."
		);
	}

	// Receipts are read only after readiness proved the configured listeners serve,
	// so the frozen set reflects a running server rather than a partial start.

	const provenance: FixtureProvenance = Object.freeze({
		kind: "wpt",
		origin,
		identity: Object.freeze({
			wptRoot,
			configPath,
			browserHost: config.browserHost,
			httpPorts: config.httpPorts.join(","),
			// The bytes the browser will actually load, read back off the wire.
			servedTestharnessSha256: servedSha256,
			checkoutTestharnessSha256: expectedSha256,
			checkoutConfigPresent: String(config.checkoutConfigPresent),
			// Never derived from a flag or from one fetch: TLS would require an actual
			// handshake against an enabled https listener, which this boundary does not
			// perform. A TCP connect to 8443 is not TLS.
			tlsEstablished: "false",
			tlsNotEstablishedReason:
				"no TLS handshake is performed by this launcher; https listeners are probed at the " +
				"TCP level only and no certificate is validated or trusted",
			declaredUnverifiedOrigins: declaredUnverifiedOrigins.join(","),
			// Per-listener evidence, so a reader can see exactly what was proved and how.
			listenerProofs: proofs
				.map(
					(proof) =>
						`${proof.scheme}:${proof.port}=${proof.method}` +
						`${proof.protocolEstablished ? "+protocol" : "+listen-only"}` +
						`+${proof.ownership}`
				)
				.join(","),
			// Every enabled listener is owned, or the start failed above.
			childOwnershipProven: "true",
		}),
		capabilities: Object.freeze([CAPABILITIES.wptServer as string]),
	});

	return Object.freeze({
		listenerProofs: Object.freeze(proofs),
		ownershipProven: true,
		effectiveOrigins: Object.freeze(effectiveOrigins),
		origin,
		declaredUnverifiedOrigins: Object.freeze(declaredUnverifiedOrigins),
		config,
		capabilities: Object.freeze([CAPABILITIES.wptServer]),
		provenance,
		pid,
		logTail: () => Object.freeze({ stdout: stdoutTail, stderr: stderrTail }),
		close,
	});
}
