/**
 * Offline evaluation of a recorded run.
 *
 * One function turns a run directory plus its saved plan into a verdict, and both
 * `runway run` and `runway compare` go through it. A live run therefore prints the
 * same verdict a later offline comparison recomputes, because it is literally the
 * same pipeline reading the same files.
 *
 * Offline means offline: this reads `plan.json`, `events.jsonl` and the artifact
 * bytes. It discovers no tests from source, imports no suite module, starts no
 * fixture server, launches no browser and resolves no asset directory. The plan's
 * inventory snapshot is the denominator.
 */
import { verifyRecordArtifacts, type ArtifactVerification } from "./artifacts.ts";
import { compareRun, type ComparisonReport, type Expectations } from "./compare.ts";
import { inventoryFromSnapshot } from "./inventory.ts";
import type { RunPlan } from "./plan.ts";
import { loadRun, type LoadedRun } from "./recorder.ts";
import { admissionIntegrityFaults } from "./verification.ts";

export type OfflineEvaluation = {
	readonly plan: RunPlan;
	readonly loaded: LoadedRun;
	readonly artifacts: ArtifactVerification;
	readonly report: ComparisonReport;
};

export type OfflineEvaluationOptions = {
	readonly plan: RunPlan;
	/** Directory holding `events.jsonl` and the artifact tree. */
	readonly runDirectory: string;
	readonly expectations?: Expectations;
	readonly notes?: readonly string[];
};

/**
 * Recomputes a run's verdict from its immutable evidence.
 *
 * Every record must carry this plan's run id and plan hash and name a pair the
 * plan planned; every declared artifact must still hash to what the record said.
 * Both checks change the verdict and the exit code rather than adding a footnote.
 */
export async function evaluateRecordedRun(
	options: OfflineEvaluationOptions
): Promise<OfflineEvaluation> {
	const plan = options.plan;
	const loaded = await loadRun(options.runDirectory, {
		runId: plan.runId,
		planHash: plan.planHash,
		pairs: plan.inventory.pairs,
	});
	const artifacts = await verifyRecordArtifacts({
		runDirectory: options.runDirectory,
		records: loaded.records,
	});
	const report = compareRun({
		plan,
		records: loaded.records,
		rejectedRecords: loaded.rejected,
		artifacts,
		// Read back out of the run's own diagnostics, so the pair-level withdrawal of
		// qualification is recomputed from the log rather than remembered in memory by
		// whoever happened to be running. A live run and `runway compare` therefore
		// reach the same verdict for the same reason.
		admissionIntegrityFaults: admissionIntegrityFaults(loaded.events),
		...(options.expectations ? { expectations: options.expectations } : {}),
		// The run's own completion status, as its log declared it. `compareRun`
		// turns an unfinished, aborted or failed run into a failing verdict; it is
		// not something this layer may summarise as a note.
		completion: { finished: loaded.finished, reason: loaded.finishReason },
		notes: [...(options.notes ?? [])],
	});
	return Object.freeze({ plan, loaded, artifacts, report });
}
