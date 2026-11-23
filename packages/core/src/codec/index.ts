import type { CodecConfig, UrlCodec } from "@/plugins/types";
import { PathCodec } from "./path";

/** A codec that owns nothing, for pages whose files all live at their real URLs */
export const noCodec: UrlCodec = {
	id: "none",
	owns: () => false,
	encode: () => null,
	decode: () => null,
};

/** Builds a codec from its plain description */
export function createCodec(config: CodecConfig | undefined): UrlCodec {
	if (config?.type === "path") return new PathCodec(config);
	return noCodec;
}

export { PathCodec };
