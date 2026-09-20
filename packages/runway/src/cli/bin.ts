#!/usr/bin/env node
/**
 * Dedicated CLI entry.
 *
 * This file owns everything about being a process: the working directory it
 * captures once, the stdio writers, the interrupt handlers, and the exit code.
 * Nothing below it calls `process.exit`, reads `process.cwd()` or installs a
 * signal handler, so the same commands run unchanged in-process from a test.
 *
 * Signal policy, stated once because everything about shutdown hangs off it:
 * the CLI listens for SIGINT and SIGTERM, exactly those two, and turns the first
 * one into an abort of the running command, which then cancels in-flight work,
 * accounts every planned pair, flushes its records and reports. The process then
 * exits with the code Runway itself chose — 0 for success, 1 for failure or a
 * cancelled run, 2 for misuse — and never with 130: that number belonged to a
 * Playwright handler this process no longer installs (see `browser/owner.ts`).
 * SIGHUP is not handled; a hangup kills the process with the platform's default
 * disposition, which is what "no SIGHUP cleanup" must look like rather than a
 * half-run report pretending the run ended cleanly.
 *
 * Library consumers do not get this policy for free: importing the public API
 * installs no handlers, and callers pass their own `AbortSignal` when they want
 * cancellation. Only this file owns whole-process signals.
 *
 * It does not compare `import.meta.url` to `argv[1]`, which breaks under `.bin`
 * symlinks; importing the public API never starts a run.
 */
import { runCli } from "./main.ts";

const controller = new AbortController();
let interrupted = false;
const onSignal = (): void => {
	if (interrupted) return;
	interrupted = true;
	process.stderr.write("cancelling: finishing in-flight tests and flushing records\n");
	controller.abort(new Error("interrupted"));
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

try {
	process.exitCode = await runCli(process.argv.slice(2), {
		cwd: process.cwd(),
		writers: {
			out: (text) => process.stdout.write(text),
			err: (text) => process.stderr.write(text),
		},
		signal: controller.signal,
	});
} finally {
	process.off("SIGINT", onSignal);
	process.off("SIGTERM", onSignal);
}
