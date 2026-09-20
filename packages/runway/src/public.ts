/**
 * Runway's public API.
 *
 * Consumers get three things: the test authoring API, the run API (resolve a plan,
 * execute it, compare a recorded run), and the record protocol types needed to read
 * a run directory. Nothing else is exported, and nothing pre-v2 is re-exported.
 */

// ---- test authoring ------------------------------------------------------
export {
	buildTarget,
	documentTest,
	fixtureTest,
	frameTreeTest,
	nodeTest,
	originTest,
	pageTest,
	scriptTest,
	type CommonOptions,
	type Fixture,
	type FixtureTarget,
	type FrameNode,
	type HostMapping,
	type LaneScope,
	type NativeTest,
	type NodeTestContext,
	type OriginOptions,
	type PageControlContext,
	type ResultHooks,
} from "./testkit.ts";

// ---- planning and running ------------------------------------------------
export {
	resolveRunConfiguration,
	KNOWN_LANES,
	KNOWN_SUITES,
	type ResolveContext,
} from "./config/resolve.ts";
export {
	option,
	type OptionValue,
	type RunwayOptions,
} from "./config/options.ts";
export {
	createRunConfiguration,
	createRunPlan,
	loadPlan,
	planHashFor,
	savePlan,
	type BrowserPlan,
	type DiagnosticsPlan,
	type LanePlan,
	type LocalFixturePlan,
	type OutputPlan,
	type RunConfiguration,
	type RunConfigurationDraft,
	type RunPlan,
	type SchedulePlan,
	type SuiteSelection,
} from "./core/plan.ts";
export {
	executeRun,
	gapTerminalsFor,
	prepareRun,
	REPORT_NAME,
	type PreparedRun,
	type RunResult,
} from "./run.ts";

// ---- inventory -----------------------------------------------------------
export {
	buildInventory,
	CAPABILITIES,
	createInventorySnapshot,
	filterEntries,
	INVENTORY_SNAPSHOT_VERSION,
	inventoryFromSnapshot,
	inventorySnapshotDigest,
	planPairs,
	serializableConfiguration,
	validateInventorySnapshot,
	VERDICT_SOURCES,
	type CapabilityId,
	type Inventory,
	type InventoryEntry,
	type PlanInventorySnapshot,
	type PlannedPair,
	type PlannedTestSnapshot,
	type VerdictSource,
} from "./core/inventory.ts";
export {
	discoverNativeTests,
	NATIVE_SUITE,
	NATIVE_TESTS_ROOT,
	type NativeDiscovery,
} from "./suites/native.ts";

// ---- records, comparison, reproduction -----------------------------------
export {
	ARTIFACTS_DIRECTORY,
	EVENT_LOG_NAME,
	loadRun,
	PLAN_NAME,
	PROTECTED_RUN_ENTRIES,
	RunRecorder,
	writeDerivedReport,
	writeReport,
	writeReportToPath,
	type LoadedRun,
	type RejectedLine,
	type RunBinding,
	type TerminalRecordInput,
} from "./core/recorder.ts";
export {
	verifyRecordArtifacts,
	ARTIFACT_ISSUE_CODES,
	type ArtifactIssue,
	type ArtifactIssueCode,
	type ArtifactVerification,
} from "./core/artifacts.ts";
export {
	evaluateRecordedRun,
	type OfflineEvaluation,
	type OfflineEvaluationOptions,
} from "./core/offline.ts";
export {
	PROTOCOL_VERSION,
	validateRunEvent,
	validateTerminalRecord,
	type ArtifactRef,
	type BrowserProvenance,
	type FixtureProvenance,
	type LaneEvidence,
	type LaneProvenance,
	type OwnerSignal,
	type ProvenanceBundle,
	type RunEvent,
	type SourcePortProvenance,
	type SubtestRecord,
	type TerminalRecord,
} from "./core/protocol.ts";
export {
	compareRun,
	EMPTY_EXPECTATIONS,
	EXPECTABLE_OUTCOMES,
	type ComparisonInput,
	type ComparisonReport,
	type ExpectableOutcome,
	type ExpectationEntry,
	type Expectations,
	type IntegrityIssue,
	type PairVerdict,
	type TestVerdict,
} from "./core/compare.ts";
export { loadExpectations, NO_EXPECTATIONS, type LoadedExpectations } from "./core/expectations.ts";
export {
	isExecuted,
	isFailureForExit,
	isInfrastructural,
	isNotRun,
	isRawPass,
	isTerminalOutcome,
	TERMINAL_OUTCOMES,
	type TerminalOutcome,
} from "./core/outcome.ts";
export {
	qualifyRecord,
	requirementsFor,
	type EvidenceRequirement,
	type Qualification,
	type QualificationMiss,
} from "./core/verification.ts";
export {
	RUNWAY_ERROR_CODES,
	RunwayError,
	serializeError,
	toRunwayError,
	type RunwayErrorCode,
	type SerializedRunwayError,
} from "./core/errors.ts";
export {
	composeTestId,
	createNonce,
	createRunId,
	laneId,
	suiteId,
	testId,
	type LaneId,
	type Nonce,
	type RunId,
	type SuiteId,
	type TestId,
} from "./core/ids.ts";

// ---- plugin profiles (browser-side contract lives in `runway/plugin-api`) --
export {
	loadPluginProfile,
	type BrowserPluginProfile,
	type LoadedPluginProfile,
	type PluginManifest,
} from "./fixtures/plugin-profile.ts";
