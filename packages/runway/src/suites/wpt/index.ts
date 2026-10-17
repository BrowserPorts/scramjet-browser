/**
 * WPT foundation: the integration surface.
 *
 * Three independent pieces, each usable on its own and none of them a runner:
 *
 * - `manifest.ts` reads the inventory manifest produced from a real upstream
 *   checkout by `scripts/generate-wpt.py` (which uses WPT's own
 *   `tools/manifest` parser).
 * - `inventory.ts` turns that manifest into `InventoryEntry` values, retaining
 *   every case this boundary cannot execute with a concrete reason.
 * - `server.ts` starts the official wptserve from the caller's checkout and proves
 *   it is ready by reading the unmodified upstream harness back off the wire.
 * - `harness.ts` bridges upstream's real completion protocol to protocol subtests.
 *
 * - `suite.ts` is the canonical suite adapter: manifest -> `InventoryEntry[]`, plus
 *   the executability gate every entry must pass.
 * - `execute.ts` runs one case on the lanes the run hands it and emits records
 *   through the run's own `emit`.
 *
 * What is deliberately *not* here: a suite registration, a plan, a browser launch, a
 * Playwright object, or any edit to the run/config/lane owner's modules. The adapter
 * is code-ready and **not wired**: `executeWptCase` requires a `WptHostAttachment`
 * the current `Lane` contract cannot yet supply, and it refuses to produce a record
 * without one rather than inventing the attribution qualification depends on.
 * `INTEGRATION.md` states the exact core changes required. Nothing in this directory
 * claims a WPT case has ever been executed in a browser.
 */
export {
	UPSTREAM_HARNESS_TIMEOUT_MS,
	WPT_MANIFEST_SCHEMA_VERSION,
	decodeUpstreamUrl,
	encodeUpstreamUrl,
	harnessTimeoutMsOf,
	manifestIdentityRecord,
	parseWptManifest,
	readWptManifest,
	requiresTestDriver,
	timeoutClassOf,
	variantOf,
	wptSuiteId,
	type WptManifest,
	type WptManifestIdentity,
	type WptManifestProvenance,
	type WptManifestTest,
	type WptOtherCase,
	type WptOtherCaseItem,
	type WptTimeoutClass,
} from "./manifest.ts";

export {
	RUNNER_DEADLINE_MARGIN_MS,
	SUPPORTED_KIND,
	buildWptInventory,
	caseUrl,
	unsupportedReasonFor,
	type UnsupportedReason,
	type WptInventory,
	type WptInventoryEntry,
	type WptInventoryOptions,
	type WptInventorySummary,
} from "./inventory.ts";

export {
	READINESS_PATH,
	resolveEffectiveConfig,
	startWptServer,
	type WptEffectiveConfig,
	type WptServerHandle,
	type WptServerRequest,
	type WptShutdownReport,
} from "./server.ts";

export {
	COLLECTOR_BINDING,
	COLLECTOR_GLOBAL,
	HARNESS_STATUS,
	SUBTEST_STATUS,
	collectorInitScript,
	convertHarnessCompletion,
	parseRawHarnessRecord,
	readRawHarnessRecord,
	runnerTimeoutOutcome,
	type HarnessConversion,
	type HarnessConversionContext,
	type RawCollectionOverflow,
	type RawCompletion,
	type RawHarnessRecord,
	type RawSubtest,
} from "./harness.ts";

export {
	WPT_SUITE_CAPABILITIES,
	assertExecutable,
	discoverWptCases,
	type ExecutabilityVerdict,
	type WptDiscovery,
	type WptDiscoveryRequest,
} from "./suite.ts";

export {
	executeWptCase,
	type WptArrival,
	type WptCaseFrame,
	type WptExecutionContext,
	type WptHostAttachment,
	type WptTerminalRecordInput,
} from "./execute.ts";

export { type HarnessAdmissionEvidence } from "./harness.ts";

export {
	createWptHostAttachment,
	iframeCase,
	mainFrameCase,
	type WptCaseFrameLocator,
	type WptHostAttachmentOptions,
	type WptRouteMapping,
} from "./host-attachment.ts";
