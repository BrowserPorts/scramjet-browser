import type {
  ControllerInit,
  ManagedPlugin,
} from "@mercuryworkshop/scramjet-controller";

export type RunwayPluginContext = {
  scramjet: typeof import("@mercuryworkshop/scramjet");
  controller: typeof import("@mercuryworkshop/scramjet-controller");
  options: Record<string, unknown>;
  assets: Readonly<Record<string, string>>;
};

export type RunwayPluginSetup = {
  plugins: ManagedPlugin[];
  configure?: (init: ControllerInit) => undefined | Promise<undefined>;
  report?: () => unknown | Promise<unknown>;
  /**
   * Asserts this plugin's own behaviour for one tested URL.
   *
   * Called once per navigation the attempt actually made, with that navigation's
   * URL in `testURL`; a test that navigates twice calls it twice, and every
   * rejection is collected. Throwing fails the attempt. Returning cleanly is a
   * self-report and never qualifies a pass: the runner records it as the plugin
   * speaking about itself, not as verification of the candidate.
   *
   * Declaring this is optional. Whether a module declared it is recorded when the
   * profile initializes, so a verifier that is declared and later unavailable fails
   * the attempt instead of being read as a profile with nothing to check.
   */
  verify?: (context: { testURL?: string }) => undefined | Promise<undefined>;
};

export type RunwayPluginFactory = (
  context: RunwayPluginContext,
) => RunwayPluginSetup | Promise<RunwayPluginSetup>;
