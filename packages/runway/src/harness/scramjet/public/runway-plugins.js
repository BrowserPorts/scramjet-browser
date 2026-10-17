// Loads the plugin profile the host serves and publishes two things the host
// correlates: an initialization receipt naming every module that loaded and which
// of them declared a verifier, and the verifier hook itself.
//
// The receipt is written once, while the modules the profile just loaded are the
// modules in hand, and before any test navigates. That is what lets the host tell
// "this profile declared no verifier" from "the verifier that was declared is gone":
// a verifier reply also carries the module descriptors and the modules it actually
// invoked, so a hook that is later deleted, replaced with a stub, or asked about a
// URL it did not verify cannot be read as a clean self-report.
window.prepareRunwayPlugins = async function () {
  const response = await fetch("/runway-plugin-profile.json");
  if (!response.ok)
    throw new Error(`Plugin profile load failed: ${response.status}`);
  const profile = await response.json();
  window.__runwayPluginProfile = profile;
  const setups = [];
  const modules = [];
  for (const entry of profile.plugins) {
    const module = await import(entry.url);
    if (typeof module.default !== "function")
      throw new TypeError(`Plugin ${entry.url} must export a default factory`);
    const setup = await module.default({
      scramjet: window.$scramjet,
      controller: window.$scramjetController,
      options: entry.options,
      assets: profile.assets,
    });
    if (!setup || !Array.isArray(setup.plugins))
      throw new TypeError(`Plugin ${entry.url} must return a plugins array`);
    for (const plugin of setup.plugins) {
      if (
        !plugin ||
        typeof plugin.install !== "function" ||
        typeof plugin.name !== "string"
      )
        throw new TypeError(`Invalid managed plugin returned by ${entry.url}`);
    }
    setups.push(setup);
    // Declaring verify()/report() is optional, so what this module declared is
    // recorded rather than assumed.
    modules.push(
      Object.freeze({
        module: entry.url,
        sha256: typeof entry.sha256 === "string" ? entry.sha256 : null,
        verify: typeof setup.verify === "function",
        report: typeof setup.report === "function",
        configure: typeof setup.configure === "function",
      }),
    );
  }
  const descriptors = Object.freeze(modules);
  const expectedVerifiers = Object.freeze(
    descriptors.filter((entry) => entry.verify).map((entry) => entry.module),
  );

  window.__runwayPluginReports = async () => {
    const reports = [];
    for (const [index, setup] of setups.entries()) {
      if (!setup.report) continue;
      try {
        reports.push({
          module: profile.plugins[index].url,
          value: await setup.report(),
        });
      } catch (error) {
        reports.push({
          module: profile.plugins[index].url,
          error: String(error),
        });
      }
    }
    return reports;
  };

  // Called once per navigation the attempt actually made, with that navigation's
  // URL, so a test that navigates more than once is verified for each target.
  window.__runwayVerifyPlugins = async (context = {}) => {
    const invoked = [];
    const failures = [];
    for (const [index, setup] of setups.entries()) {
      if (typeof setup.verify !== "function") continue;
      const module = profile.plugins[index].url;
      invoked.push(module);
      try {
        await setup.verify(context);
      } catch (error) {
        failures.push({ module, error: String(error) });
      }
    }
    return {
      profile: profile.name,
      modules: descriptors,
      expected: expectedVerifiers,
      invoked,
      failures,
      // Echoed back so the host can tell a verified target from an unrelated one.
      testURL: typeof context.testURL === "string" ? context.testURL : null,
    };
  };

  window.__runwayPluginInit = Object.freeze({
    profile: profile.name,
    modules: descriptors,
    expectedVerifiers,
  });

  return {
    profile,
    plugins: setups.flatMap((setup) => setup.plugins),
    async configure(init) {
      for (const setup of setups) await setup.configure?.(init);
    },
  };
};
