/**
 * Artifact integrity verification.
 *
 * A record that names artifacts is only evidence if those bytes are still the
 * bytes it named. This module reads every declared artifact inside the canonical
 * run root and checks its size and SHA-256 against the record.
 *
 * What it deliberately does *not* do:
 *   * follow a path out of the run root — absolute paths, traversal and symlinks
 *     are rejected outright rather than resolved;
 *   * import, execute or interpret an artifact — bytes are streamed and hashed;
 *   * write anything — verification is read-only, so a comparison can never
 *     modify the evidence it is judging.
 *
 * Scope: this verifies the artifacts a record declares. It is not a transitive
 * asset audit — an artifact that references further files does not make those
 * files part of the verified set.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { LaneId, TestId } from "./ids.ts";
import { terminalKey } from "./ids.ts";
import type { ArtifactRef, TerminalRecord } from "./protocol.ts";

export const ARTIFACT_ISSUE_CODES = [
	/** The recorded path is absolute, traverses, or is otherwise not run-relative. */
	"artifact/path-rejected",
	/** The resolved path leaves the canonical run root. */
	"artifact/escapes-run-root",
	/** A path component is a symbolic link. Runway does not follow them. */
	"artifact/symlink",
	/** The file the record names is gone. */
	"artifact/missing",
	/** The path exists but is not a regular file. */
	"artifact/not-a-file",
	/** The bytes on disk could not be read. */
	"artifact/unreadable",
	/** The size on disk differs from the recorded size. */
	"artifact/size-mismatch",
	/** The content hash differs from the recorded hash. */
	"artifact/hash-mismatch",
] as const;

export type ArtifactIssueCode = (typeof ARTIFACT_ISSUE_CODES)[number];

export type ArtifactIssue = {
	readonly testId: TestId;
	readonly laneId: LaneId;
	readonly name: string;
	/** Path exactly as the record declared it, never a rewritten one. */
	readonly path: string;
	readonly code: ArtifactIssueCode;
	readonly detail: string;
};

export type ArtifactVerification = {
	/** Canonical run root every artifact path was resolved against. */
	readonly runRoot: string;
	readonly declared: number;
	readonly verified: number;
	readonly verifiedBytes: number;
	readonly issues: readonly ArtifactIssue[];
	/** Issue keys by `(testId, laneId)`, for comparison. */
	readonly issuesByPair: ReadonlyMap<string, readonly ArtifactIssue[]>;
};

const SEGMENT_SPLIT = /[/\\]/;

function pathRejection(reference: string): string | null {
	if (reference.includes("\0")) return "the path contains NUL";
	if (path.isAbsolute(reference) || reference.startsWith("\\") || /^[a-zA-Z]:/.test(reference)) {
		return "the path is absolute; artifact paths are relative to the run root";
	}
	for (const segment of reference.split(SEGMENT_SPLIT)) {
		if (segment === "") return "the path has an empty segment";
		if (segment === "." || segment === "..") {
			return `the path contains the traversal segment ${JSON.stringify(segment)}`;
		}
	}
	return null;
}

async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
	const hash = createHash("sha256");
	let bytes = 0;
	// Streamed as bytes. Nothing about an artifact is parsed, imported or executed.
	const stream = createReadStream(file);
	for await (const chunk of stream as AsyncIterable<Buffer>) {
		bytes += chunk.byteLength;
		hash.update(chunk);
	}
	return { sha256: hash.digest("hex"), bytes };
}

async function verifyOne(
	runRoot: string,
	record: TerminalRecord,
	artifact: ArtifactRef
): Promise<{ issue: ArtifactIssue | null; bytes: number }> {
	const issue = (code: ArtifactIssueCode, detail: string): { issue: ArtifactIssue; bytes: number } => ({
		issue: {
			testId: record.testId,
			laneId: record.laneId,
			name: artifact.name,
			path: artifact.path,
			code,
			detail,
		},
		bytes: 0,
	});

	const rejection = pathRejection(artifact.path);
	if (rejection) return issue("artifact/path-rejected", rejection);

	const segments = artifact.path.split(SEGMENT_SPLIT);
	const resolved = path.resolve(runRoot, ...segments);
	if (resolved !== runRoot && !resolved.startsWith(runRoot + path.sep)) {
		return issue(
			"artifact/escapes-run-root",
			`the path resolves to ${resolved}, which is outside the run root ${runRoot}`
		);
	}

	// Walk the chain so a symlinked *directory* cannot smuggle bytes in either.
	let walked = runRoot;
	for (const [index, segment] of segments.entries()) {
		walked = path.join(walked, segment);
		let info;
		try {
			info = await lstat(walked);
		} catch (cause) {
			if ((cause as { code?: string }).code === "ENOENT") {
				return issue(
					"artifact/missing",
					`${walked} does not exist; the record declares ${artifact.bytes} byte(s) there`
				);
			}
			return issue(
				"artifact/unreadable",
				`${walked} could not be inspected: ${(cause as Error).message}`
			);
		}
		if (info.isSymbolicLink()) {
			return issue(
				"artifact/symlink",
				`${walked} is a symbolic link; Runway does not follow links into or out of a run root`
			);
		}
		const last = index === segments.length - 1;
		if (!last && !info.isDirectory()) {
			return issue("artifact/not-a-file", `${walked} is not a directory`);
		}
		if (last) {
			if (!info.isFile()) {
				return issue("artifact/not-a-file", `${walked} is not a regular file`);
			}
			if (info.size !== artifact.bytes) {
				return issue(
					"artifact/size-mismatch",
					`the record declares ${artifact.bytes} byte(s), the file holds ${info.size}`
				);
			}
		}
	}

	let hashed;
	try {
		hashed = await hashFile(resolved);
	} catch (cause) {
		return issue("artifact/unreadable", `the bytes could not be read: ${(cause as Error).message}`);
	}
	if (hashed.bytes !== artifact.bytes) {
		return issue(
			"artifact/size-mismatch",
			`the record declares ${artifact.bytes} byte(s), reading produced ${hashed.bytes}`
		);
	}
	if (hashed.sha256 !== artifact.sha256) {
		return issue(
			"artifact/hash-mismatch",
			`the record declares sha256 ${artifact.sha256}, the bytes hash to ${hashed.sha256}`
		);
	}
	return { issue: null, bytes: hashed.bytes };
}

/**
 * Verifies every artifact declared by every record, relative to the run root.
 *
 * Read-only. Every failure is returned; nothing is repaired and nothing is
 * downgraded to a note, because a missing or altered artifact changes what the
 * run proves.
 */
export async function verifyRecordArtifacts(options: {
	readonly runDirectory: string;
	readonly records: readonly TerminalRecord[];
}): Promise<ArtifactVerification> {
	// The canonical root: comparisons resolve every artifact against this exact
	// directory, so a symlinked run directory cannot widen what counts as "inside".
	const runRoot = await realpath(path.resolve(options.runDirectory));
	const issues: ArtifactIssue[] = [];
	const issuesByPair = new Map<string, ArtifactIssue[]>();
	let declared = 0;
	let verified = 0;
	let verifiedBytes = 0;

	for (const record of options.records) {
		for (const artifact of record.evidence.artifacts) {
			declared += 1;
			const outcome = await verifyOne(runRoot, record, artifact);
			if (outcome.issue) {
				issues.push(outcome.issue);
				const key = terminalKey(record.testId, record.laneId);
				const list = issuesByPair.get(key) ?? [];
				list.push(outcome.issue);
				issuesByPair.set(key, list);
				continue;
			}
			verified += 1;
			verifiedBytes += outcome.bytes;
		}
	}

	return Object.freeze({
		runRoot,
		declared,
		verified,
		verifiedBytes,
		issues: Object.freeze(issues),
		issuesByPair: new Map([...issuesByPair].map(([key, list]) => [key, Object.freeze(list)])),
	});
}
