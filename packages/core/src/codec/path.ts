import type { CodecConfig, UrlCodec } from "@/plugins/types";

type PathCodecConfig = Extract<CodecConfig, { type: "path" }>;

const NativeURL = globalThis.URL;

/**
 * Original URLs laid out under one prefix by host and path:
 *
 *   https://cdn.example.net/build/data.unityweb
 *     -> <prefix>cdn.example.net/build/data.unityweb
 *
 * Relative URLs inside a game keep working with no rewriting, since the path below the host is
 * the original one. The query and hash stay as they are. A host on a non-default port keeps its
 * port in the segment, and an http host is marked `http~host`.
 */
export class PathCodec implements UrlCodec {
	readonly id: string;
	readonly prefix: URL;
	#hosts: Set<string>;
	#scheme: "https:" | "http:";

	constructor(config: PathCodecConfig) {
		this.prefix = new NativeURL(config.prefix);
		if (!this.prefix.pathname.endsWith("/")) this.prefix.pathname += "/";
		this.#hosts = new Set(config.hosts.map((host) => host.toLowerCase()));
		this.#scheme = config.defaultScheme === "http" ? "http:" : "https:";
		this.id = `path:${this.prefix.href}`;
	}

	#segment(url: URL): string {
		const host = url.host.toLowerCase();
		return url.protocol === this.#scheme ? host : `${url.protocol.slice(0, -1)}~${host}`;
	}

	owns(url: URL): boolean {
		if (url.protocol !== "https:" && url.protocol !== "http:") return false;
		return this.#hosts.has(this.#segment(url)) || this.#hosts.has(url.host.toLowerCase());
	}

	encode(url: URL): string | null {
		if (!this.owns(url)) return null;
		return `${this.prefix.href}${this.#segment(url)}${url.pathname}${url.search}${url.hash}`;
	}

	decode(input: string | URL): string | null {
		let url: URL;
		try {
			url = new NativeURL(String(input));
		} catch {
			return null;
		}
		if (url.origin !== this.prefix.origin || !url.pathname.startsWith(this.prefix.pathname))
			return null;
		const rest = url.pathname.slice(this.prefix.pathname.length);
		const slash = rest.indexOf("/");
		const segment = slash === -1 ? rest : rest.slice(0, slash);
		if (!segment) return null;
		const path = slash === -1 ? "/" : rest.slice(slash);
		const marker = segment.indexOf("~");
		const scheme = marker === -1 ? this.#scheme : `${segment.slice(0, marker)}:`;
		const host = marker === -1 ? segment : segment.slice(marker + 1);
		if (scheme !== "http:" && scheme !== "https:") return null;
		return `${scheme}//${host}${path}${url.search}${url.hash}`;
	}
}
