#!/usr/bin/env node
/**
 * WPT fixture generation is not part of this build. The producers live under
 * `migration/wpt` until the v2 WPT adapters land. This command refuses rather
 * than importing a path that no longer exists.
 */
console.error(
	"runway: generate-wpt is not available in this build. WPT suite adapters are not migrated yet."
);
process.exit(2);
