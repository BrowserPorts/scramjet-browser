/**
 * Browser selection.
 *
 * Exactly one selector is accepted. Conflicts are errors, a named executable is
 * validated before anything launches, and a run that did not name its binary is
 * marked as not selection proof rather than being quietly treated as one.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { RunwayError } from "../core/errors.ts";
import type { BrowserSelectionPlan } from "../core/plan.ts";

export type BrowserSelectionInput = {
	readonly executablePath?: { readonly value: string; readonly source: string };
	readonly channel?: { readonly value: string; readonly source: string };
	readonly bundled?: { readonly value: boolean; readonly source: string };
	/**
	 * Directory a relative executable path is resolved against. Required, so a
	 * programmatic caller cannot end up launching a binary from the runner's own
	 * working directory instead of the one it named.
	 */
	readonly cwd: string;
};

/** Validates the inputs and produces the plan fragment. */
export function resolveBrowserSelection(
	input: BrowserSelectionInput
): BrowserSelectionPlan {
	type Choice = {
		readonly kind: "executable" | "channel" | "bundled";
		readonly value: string | boolean;
		readonly source: string;
	};
	const candidates: (Choice | null)[] = [
		input.executablePath ? { kind: "executable", ...input.executablePath } : null,
		input.channel ? { kind: "channel", ...input.channel } : null,
		input.bundled?.value ? { kind: "bundled", ...input.bundled } : null,
	];
	const named: Choice[] = candidates.filter((entry): entry is Choice => entry !== null);

	if (named.length > 1) {
		throw new RunwayError(
			"browser/selection-invalid",
			"more than one browser selector was supplied",
			{
				details: Object.fromEntries(named.map((entry) => [entry.source, entry.value])),
				remedy:
					"Pass exactly one of --browser-executable, --browser-channel or --browser-bundled.",
			}
		);
	}

	const choice = named[0];
	if (!choice) {
		return Object.freeze({
			kind: "bundled",
			selector: null,
			explicitlySelected: false,
		});
	}

	if (choice.kind === "executable") {
		const resolved = path.resolve(input.cwd, String(choice.value));
		if (!existsSync(resolved)) {
			throw new RunwayError(
				"browser/selection-invalid",
				`the selected browser executable does not exist: ${resolved}`,
				{ details: { source: choice.source }, remedy: "Check the path." }
			);
		}
		const stats = statSync(resolved);
		if (!stats.isFile()) {
			throw new RunwayError(
				"browser/selection-invalid",
				`the selected browser executable is not a file: ${resolved}`,
				{
					details: { source: choice.source },
					remedy: resolved.endsWith(".app")
						? "Pass the binary inside the bundle, e.g. <app>/Contents/MacOS/<binary>."
						: "Pass the browser binary itself.",
				}
			);
		}
		return Object.freeze({
			kind: "executable",
			selector: resolved,
			explicitlySelected: true,
		});
	}

	if (choice.kind === "channel") {
		return Object.freeze({
			kind: "channel",
			selector: String(choice.value),
			explicitlySelected: true,
		});
	}

	// `--browser-bundled` is an explicit acknowledgement of the bundled download,
	// but the binary is still not one the consumer named, so it is not proof.
	return Object.freeze({
		kind: "bundled",
		selector: null,
		explicitlySelected: false,
	});
}

export function describeSelection(selection: BrowserSelectionPlan): string {
	switch (selection.kind) {
		case "executable":
			return `executable ${selection.selector}`;
		case "channel":
			return `channel ${selection.selector}`;
		default:
			return "Playwright's bundled Chromium (not selection proof)";
	}
}
