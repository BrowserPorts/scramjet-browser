/**
 * The real Playwright host attachment for WPT cases.
 *
 * This is the integration `execute.ts` demands and refuses to fake: it designates a
 * concrete `Frame` before navigation, reads completion arrivals off a Playwright
 * binding whose `source.frame` is authoritative, and bounds what it retains.
 *
 * Declared limit, not a closed race: `source.frame` is a stable object across a
 * same-frame navigation, so a document replacing the case document in that frame
 * would still compare equal. What separates them is the route owner's
 * `locationVerdict`, which the converter requires to be `match` — a replacement at
 * a different URL is refused there. A replacement at the *same* URL is not
 * distinguished, and this module does not claim otherwise. A fresh page per
 * reference attempt keeps that window small; it does not eliminate it.
 *
 * It is **not** a runner. It launches no browser, owns no lifecycle, schedules
 * nothing and records nothing. It is handed a `BrowserContext` and a `Page` that the
 * canonical browser owner created, and it hands back a {@link WptHostAttachment}.
 *
 * Three boundaries are deliberate and load-bearing:
 *
 * 1. **Frame identity comes from Playwright, never from the page.** Arrivals are
 *    attributed by comparing `source.frame` to the retained `Frame` object. A URL in
 *    the payload, a `caseFrameId` the guest echoes, or an `isMainFrame`-style flag
 *    are all guest-controlled and are never consulted for attribution.
 * 2. **The logical→physical mapping is an injected dependency.** Under a proxy lane
 *    the document's real URL is rewritten, so only the route owner can say whether a
 *    frame is at the expected case. There is no default implementation, and
 *    deliberately no "always match" fallback: without a mapping every arrival is
 *    `unverified`, which admits nothing.
 * 3. **Nothing here is route proof.** A binding call proves a frame ran the
 *    collector. It says nothing about which network path the bytes took, so this
 *    module never sets, implies or contributes to `routeInstrumentation`. That
 *    requirement stays separate and fails closed until a real ingress receipt exists.
 */
import type { BrowserContext, Frame, Page } from "playwright";
import { RunwayError } from "../../core/errors.ts";
import type { HarnessAdmissionEvidence } from "./harness.ts";
import { COLLECTOR_BINDING } from "./harness.ts";
import type {
	WptArrival,
	WptCaseFrame,
	WptHostAttachment,
} from "./execute.ts";

/**
 * The route owner's logical→physical mapping.
 *
 * Supplied by whatever owns rewriting for the lane. The reference lane's
 * implementation is the identity mapping; a proxy lane's is its own rewriter. There
 * is no default: see {@link createWptHostAttachment}.
 */
export type WptRouteMapping = {
	/**
	 * Resolves the URL to actually navigate to for an upstream logical URL.
	 *
	 * For a reference lane this returns the logical URL unchanged. For a proxy lane
	 * it returns the rewritten URL the guest frame will really load.
	 */
	readonly toPhysical: (logicalUrl: string) => Promise<string> | string;
	/**
	 * Decides whether a frame's observed URL is the expected case document.
	 *
	 * `observedUrl` is read from the `Frame` by this module, not reported by the page.
	 * Implementations must return `unverified` when they cannot decide — that is not
	 * an admission, and it is the correct answer for an unmapped URL.
	 */
	readonly verify: (input: {
		readonly observedUrl: string;
		readonly logicalUrl: string;
		readonly physicalUrl: string;
	}) => "match" | "mismatch" | "unverified";
};

/**
 * Locates the frame a case will run in, before it is navigated.
 *
 * The distinction this exists for: on a reference lane the case document *is* the
 * page's main frame, while on a proxy lane the main frame is the controller wrapper
 * and the case runs in a guest child frame. Attributing to the wrapper would accept
 * completions from the controller and reject the real ones.
 */
export type WptCaseFrameLocator = {
	readonly describe: string;
	readonly locate: (page: Page) => Promise<Frame>;
};

/** The case document is the page's own main frame. Typical for a reference lane. */
export function mainFrameCase(): WptCaseFrameLocator {
	return {
		describe: "page main frame",
		locate: async (page) => page.mainFrame(),
	};
}

/**
 * The case document is a guest frame inside an iframe element.
 *
 * Resolved through `elementHandle.contentFrame()`, which is Playwright's own
 * element→frame link, rather than by matching on a frame's URL or name — both of
 * which the guest can influence. The handle is resolved **before** navigation so the
 * retained identity is the frame the host chose, not whichever frame happens to look
 * right afterwards.
 */
export function iframeCase(selector: string, options: { readonly timeoutMs?: number } = {}): WptCaseFrameLocator {
	return {
		describe: `iframe ${selector}`,
		locate: async (page) => {
			const element = await page.waitForSelector(selector, {
				state: "attached",
				timeout: options.timeoutMs ?? 30_000,
			});
			const frame = await element.contentFrame();
			if (frame === null) {
				throw new RunwayError(
					"lane/init-failed",
					`the element ${selector} has no content frame, so no case frame could be designated`,
					{ details: { selector } }
				);
			}
			return frame;
		},
	};
}

export type WptHostAttachmentOptions = {
	readonly context: BrowserContext;
	readonly page: Page;
	/** How to find the case frame for this lane. */
	readonly caseFrame: WptCaseFrameLocator;
	/**
	 * The route owner's mapping. Required.
	 *
	 * Omitting it is not supported and there is no permissive default: a mapping that
	 * always answered `match` would manufacture exactly the attribution the adapter
	 * exists to check.
	 */
	readonly routeMapping: WptRouteMapping;
	/** Binding name. Defaults to the collector's. */
	readonly bindingName?: string;
	/**
	 * Largest completion accepted from the designated case frame. Default 8 MiB.
	 *
	 * Sized well above a genuine completion (a 394-subtest upstream file is orders of
	 * magnitude smaller) so the bound protects memory without being the reason a real
	 * case is lost.
	 */
	readonly caseFramePayloadBytes?: number;
	readonly navigationTimeoutMs?: number;
};

type QueuedArrival = WptArrival;

/**
 * Creates the attachment.
 *
 * One attachment serves one attempt. `designateCaseFrame` may be called once; a
 * second call is refused rather than silently rebinding, because two attempts
 * sharing one binding is how a late callback from attempt N lands in attempt N+1.
 */
export function createWptHostAttachment(options: WptHostAttachmentOptions): WptHostAttachment {
	if (typeof options.routeMapping?.verify !== "function") {
		throw new RunwayError(
			"lane/init-failed",
			"a WPT host attachment requires the route owner's logical/physical mapping",
			{
				remedy:
					"Pass `routeMapping`. There is no default: without it every arrival is " +
					"unverified and nothing can be admitted, and a mapping that always returned " +
					"`match` would fabricate the attribution the adapter is there to check.",
			}
		);
	}

	let designated = false;

	return {
		designateCaseFrame: async ({ initScript, logicalUrl }) => {
			if (designated) {
				throw new RunwayError(
					"lane/init-failed",
					"this host attachment has already designated a case frame",
					{
						remedy:
							"Create one attachment per attempt. Reusing one would let a callback from " +
							"the previous attempt be admitted against this one.",
					}
				);
			}
			designated = true;

			const bindingName = options.bindingName ?? COLLECTOR_BINDING;
			// A real testharness completion for a large upstream file is big:
			// /url/a-element-origin.html alone reports 394 subtests. 8 MiB is chosen to
			// be far above any genuine completion while still bounded.
			const payloadByteLimit = options.caseFramePayloadBytes ?? 8 * 1024 * 1024;

			// The collector must be installed before anything loads, or it misses
			// upstream's registrars. Disposable so this attempt removes exactly its own.
			const initHandle = await options.context.addInitScript(initScript);

			// Designate BEFORE navigation. This is the identity every later arrival is
			// compared against.
			const caseFrame = await options.caseFrame.locate(options.page);
			if (caseFrame.isDetached()) {
				throw new RunwayError(
					"lane/init-failed",
					`the designated case frame (${options.caseFrame.describe}) is already detached`,
					{ details: { locator: options.caseFrame.describe } }
				);
			}
			const caseFrameId = options.caseFrame.describe;

			/* ---- per-attempt completion queue and its barrier ---- */
			const queue: QueuedArrival[] = [];
			const waiters: ((arrival: QueuedArrival | null) => void)[] = [];
			let closed = false;
			let physicalUrl: string | null = null;
			/**
			 * Why no completion could be collected, when that is the reason.
			 *
			 * Kept so the adapter can tell an oversized or excess completion from a
			 * document that never reported at all. Without it both looked like a
			 * deadline, and a real result was reported as a timeout.
			 */
			let fault: string | null = null;
			/**
			 * Whether a completion has already been taken for this attempt.
			 *
			 * A boolean, not a queue bound: a queue-length check let a second
			 * completion be accepted as soon as the first had been dequeued. Upstream
			 * calls its completion callback once per document, so the first is the whole
			 * result and every later one is a fault.
			 */
			let receivedCompletion = false;

			/** Wakes anything waiting, so a fault is never waited out to the deadline. */
			const wake = (): void => {
				for (const waiter of waiters.splice(0, waiters.length)) waiter(null);
			};

			const deliver = (arrival: QueuedArrival): void => {
				if (receivedCompletion) {
					// An accepted result is never replaced by a later one.
					fault ??= "the page sent more than one completion for this attempt";
					wake();
					return;
				}
				receivedCompletion = true;
				const waiter = waiters.shift();
				if (waiter) waiter(arrival);
				else queue.push(arrival);
			};

			const binding = await options.context.exposeBinding(
				bindingName,
				// `source` is Playwright's, not the page's: this is the authoritative
				// frame identity the whole attribution rests on.
				(source, payload: unknown) => {
					// Identity first, and both halves of it: the frame, and the page that
					// frame belongs to. A helper frame or the outer document reporting the
					// same URL is refused here, before anything is queued.
					const fromCaseFrame = source.frame === caseFrame && source.page === options.page;
					if (!fromCaseFrame || closed) return;

					// The collector always sends a string. Anything else is refused rather
					// than stringified, so no unbounded object is serialized on this side.
					if (typeof payload !== "string") {
						fault ??= "the page sent a completion that was not a string";
						wake();
						return;
					}
					// Actual UTF-8 bytes, not UTF-16 code units: `payload.length` undercounts
					// every non-ASCII byte, so a real completion could exceed the intended
					// bound and be dropped — silently, which then read as a timeout.
					const bytes = Buffer.byteLength(payload, "utf8");
					if (bytes > payloadByteLimit) {
						fault ??=
							`the page's completion is ${bytes} bytes, over the ${payloadByteLimit}-byte ` +
							"budget, so it was not retained";
						wake();
						return;
					}

					let observedUrl: string | null = null;
					try {
						observedUrl = source.frame.url();
					} catch {
						observedUrl = null;
					}
					const admission: HarnessAdmissionEvidence = {
						caseFrameDesignated: true,
						bindingSourceIsCaseFrame: true,
						locationVerdict:
							physicalUrl === null || observedUrl === null
								? "unverified"
								: options.routeMapping.verify({ observedUrl, physicalUrl, logicalUrl }),
						observedLocation: observedUrl,
						caseFrameId,
					};
					deliver({ payload, admission });
				}
			);

			const frame: WptCaseFrame = {
				caseFrameId,

				navigate: async (logical) => {
					if (caseFrame.isDetached()) {
						throw new RunwayError(
							"lane/navigation-failed",
							"the designated case frame was detached before navigation",
							{ details: { caseFrameId } }
						);
					}
					physicalUrl = String(await options.routeMapping.toPhysical(logical));
					await caseFrame.goto(physicalUrl, {
						waitUntil: "commit",
						timeout: options.navigationTimeoutMs ?? 30_000,
					});
					return { physicalUrl };
				},

				nextCompletion: async (signal) => {
					if (closed) return null;
					const queued = queue.shift();
					if (queued !== undefined) return queued;
					// A fault already recorded ends the wait now. Waiting it out would
					// reach the deadline and report a timeout for a document that did
					// report.
					if (fault !== null) return null;
					if (signal.aborted) return null;
					return new Promise<WptArrival | null>((resolve) => {
						const onAbort = (): void => {
							const index = waiters.indexOf(settle);
							if (index >= 0) waiters.splice(index, 1);
							resolve(null);
						};
						const settle = (arrival: QueuedArrival | null): void => {
							signal.removeEventListener("abort", onAbort);
							resolve(arrival);
						};
						waiters.push(settle);
						signal.addEventListener("abort", onAbort, { once: true });
					});
				},

				collectionFault: () => fault,

				dispose: async () => {
					if (closed) return;
					// Set synchronously, before any await: the binding checks this flag, so
					// acceptance stops at this instant rather than somewhere inside the
					// teardown. A fault raised by a callback that lands during teardown is
					// still recorded, and `collectionFault()` is read after dispose.
					closed = true;
					wake();
					// Remove exactly what this attempt installed, so nothing survives into
					// a later one and nothing belonging to the lane is touched.
					const failures: string[] = [];
					for (const [what, handle] of [
						["binding", binding],
						["init script", initHandle],
					] as const) {
						try {
							await handle.dispose();
						} catch (error) {
							failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
					if (failures.length > 0) {
						throw new RunwayError(
							"lane/init-failed",
							`this attempt's host bindings could not be removed: ${failures.join("; ")}`,
							{ details: { caseFrameId } }
						);
					}
				},
			};
			return frame;
		},
	};
}
