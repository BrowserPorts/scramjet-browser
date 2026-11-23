/**
 * Scramjet's frame mode: the minimal client for a sandboxed srcdoc frame that loads nothing from
 * the network. A boot stub asks the frame's host for a link, runs the runtime the host sent from a
 * blob the frame made, and builds the document from markup the host sent, at a URL in the codec's
 * space it never loads from. Every request travels over the link; elements, stylesheets, modules,
 * worklets and workers load from blobs the frame or its workers made; frames inside become stubs;
 * the document's identity and history are the URL it stands for.
 *
 * Everything the minimal export has is here too, so a runtime bundle built on this export holds
 * one client. The host's side is the separate `./frame/host` export.
 */
export * from "@/minimal/index";
export { startFrame, withBase, type StartFrameOptions } from "./boot";
export { frameStub, FRAME_POLICY, FRAME_CHANNEL, type FrameStubOptions } from "./stub";
export { frameOf, identityUrl, FRAME_PLUGIN, type FrameConfig, type FrameState } from "./state";
export { rewriteModule } from "./plugins/modules";
export { FRAME_PLUGINS } from "./plugins";
export type * from "./types";
