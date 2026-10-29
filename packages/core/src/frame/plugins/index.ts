import frames from "./frames";
import history from "./history";
import identity from "./identity";
import modules from "./modules";
import navigation from "./navigation";
import prefetch from "./prefetch";
import worklets from "./worklets";

/** The plugins a frame client installs beside the embedder's; each is off outside frame mode */
export const FRAME_PLUGINS = [identity, modules, prefetch, history, navigation, frames, worklets];
