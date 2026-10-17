export const CDP_INIT_SCRIPT = `
(() => {
	try {
		window.__eval = window.eval;
		window.__topEval = window.eval;
		function getRunwayToken() {
			try {
				// The host injects the attempt nonce into this browser profile only, so
				// every result reported from it is attributable to that attempt. The URL
				// forms are a fallback for documents that carry the token themselves.
				if (typeof globalThis.__runwayAttemptNonce === "string") {
					return globalThis.__runwayAttemptNonce;
				}
				const url = new URL(location.href);
				const searchToken = url.searchParams.get("runway_token");
				if (searchToken) return searchToken;
				const hash = url.hash;
				if (!hash) return undefined;
				const params = new URLSearchParams(
					hash.startsWith("#") ? hash.slice(1) : hash
				);
				return params.get("runway_token") || undefined;
			} catch {
				return undefined;
			}
		}
		
		// Test helper functions.
		//
		// Every helper returns the host binding's promise. The host decides things
		// the page cannot (is this result attributable to the attempt? did the other
		// lane agree?), so dropping that promise is how a page turns a host-side
		// refusal into a silent pass. Returning it makes the helpers awaitable and
		// lets host errors propagate into the test body.
		// Serializes a report for the host, attaching the attempt nonce. This is the
		// one place that touches the payload's contents, and it can throw: a report
		// carrying a bigint, a circular structure or a toJSON that throws cannot
		// cross the binding at all. Callers that must not throw pre-frame their body
		// and handle the failure themselves.
		function frameBody(payload) {
			const token = getRunwayToken();
			return payload && typeof payload === "object"
				? JSON.stringify({ ...payload, __runwayToken: token })
				: JSON.stringify({ value: payload, __runwayToken: token });
		}

		// Hands an already-serialized report to a host binding. An undefined return means the
		// binding is not installed, which is a different thing from the host
		// refusing, and the two are never conflated.
		function deliver(name, body) {
			const fn = window[name];
			if (typeof fn !== "function") return undefined;
			try {
				return Promise.resolve(fn(body));
			} catch (err) {
				return Promise.reject(err);
			}
		}

		function emitBinding(name, payload) {
			// The binding is checked before the payload is serialized, so a page
			// without the binding never pays for framing a report nobody receives.
			if (typeof window[name] !== "function") return undefined;
			return deliver(name, frameBody(payload));
		}

		// Keeps a returned promise from becoming an unhandled rejection when a
		// caller ignores it, without hiding it from a caller that awaits it.
		// Attaching a handler does not settle or consume the original promise;
		// awaiting it still observes the same outcome.
		function handled(promise) {
			if (promise && typeof promise.catch === "function") {
				promise.catch(function () {});
			}
			return promise;
		}

		function pass(message, details) {
			return handled(emitBinding("__testPass", { message, details }));
		}

		// The failure report goes through the fail channel when it exists. That
		// channel itself may be absent, when a page loads before the host has
		// installed it, and a missing channel can never be reported through
		// itself, so it is distinguished from a refusal, not retried.
		function reportFailure(message, details) {
			const sent = emitBinding("__testFail", { message, details });
			if (!sent) return { reported: false, reason: "__testFail is not installed in this page" };
			return { reported: true, emission: handled(sent) };
		}

		function fail(message, details) {
			const report = reportFailure(message, details);
			if (report.reported) return report.emission;
			// The one case with no host channel at all: a promise that still
			// rejects with the reason, so an awaiting caller observes it, while
			// callers that drop it leave no unhandled rejection behind.
			return handled(Promise.reject(new Error(report.reason)));
		}

		// The single refusal path for every consistency submission that does not
		// reach a host decision, whether the defect is local (an unusable label, a
		// missing binding) or the host's own. The failure is reported through the
		// fail channel exactly once, and the returned rejection is marked handled,
		// so an unawaited invalid call still fails the test without leaving an
		// unhandled rejection; awaiting it still observes the same rejection.
		function refusedConsistency(labelText, reason) {
			reportFailure(
				"consistency submission for " + labelText + " was refused: " + reason
			);
			return handled(Promise.reject(new Error(reason)));
		}

		// Names a label in a diagnostic without serializing it.
		//
		// An invalid label is arbitrary page data, and the refusal path must survive
		// it: JSON.stringify on a bigint throws, on a circular object throws, and on
		// an object whose toJSON throws propagates that. Any of those turns the
		// refusal into a synchronous throw from assertConsistent, so nothing is
		// reported through the fail channel and the defect is attributed to whatever
		// caught it, or to nobody. The description is therefore a typeof
		// classification: it invokes no toJSON, no toString, no valueOf and no
		// getter on the value. Only a string — which cannot throw — is quoted.
		function describeLabel(label) {
			const kind = typeof label;
			if (kind === "string") return JSON.stringify(label);
			if (kind === "number" || kind === "boolean") return String(label);
			if (kind === "undefined") return "undefined";
			if (kind === "object") return label === null ? "null" : "an object label";
			return "a " + kind + " label";
		}

		// Names the type of a submitted value, for the same reason and under the same
		// rule as describeLabel: nothing about the value is invoked or observed
		// beyond its typeof. Not even Array.isArray, which throws on a revoked
		// proxy — a throw from inside the diagnostic defeats the very refusal it is
		// being written for, and "an object" is all a reader needs here anyway.
		function describeValueType(value) {
			const kind = typeof value;
			if (kind !== "object") return "a " + kind;
			return value === null ? "null" : "an object";
		}

		// Reads a thrown reason's message without trusting it.
		//
		// The reason is usually JSON.stringify's own error ("Do not know how to
		// serialize a BigInt", "Converting circular structure to JSON"), which is the
		// most useful thing to report, but it can also be whatever a hostile toJSON
		// threw. So the message is read exactly once, into a local, inside the guard:
		// a getter that answers with a string and then with something else cannot
		// smuggle that something else out, because the value that was type-checked is
		// the value returned. Nothing here coerces or concatenates the reason itself.
		function describeThrown(reason) {
			try {
				const captured = reason ? reason.message : undefined;
				if (typeof captured === "string") return captured;
			} catch (ignored) {
				// The read itself threw; there is nothing readable to report.
			}
			return "no readable reason was reported";
		}

		// The label is the rendezvous key: it must be explicit and unique per test
		// and lane, so a missing one is an authoring error rather than a silent
		// "default" bucket that quietly pairs unrelated observations. It must be a
		// non-empty string; nothing is coerced into one.
		function assertConsistent(label, value) {
			if (arguments.length < 2) {
				return refusedConsistency(
					describeLabel(label),
					"assertConsistent(label, value) requires an explicit label"
				);
			}
			if (typeof label !== "string" || label.trim() === "") {
				return refusedConsistency(
					describeLabel(label),
					"assertConsistent() needs a non-empty string label"
				);
			}
			if (typeof window.__testConsistent !== "function") {
				return refusedConsistency(
					describeLabel(label),
					"the consistency binding is not installed in this page"
				);
			}
			// Serializing the submission is the other way this call can fail without
			// ever reaching the host: a bigint, a circular structure or a throwing
			// toJSON makes JSON.stringify throw, and a synchronous throw here would
			// leave the rendezvous neither submitted nor refused — the label would
			// simply never arrive, and the other lane would wait for it. One attempt,
			// then the same refusal path as any other local defect; the value is
			// described by type and is never serialized again.
			let body;
			try {
				body = frameBody({ label: label, value: value });
			} catch (error) {
				return refusedConsistency(
					describeLabel(label),
					"the submitted value (" +
						describeValueType(value) +
						") could not be serialized: " +
						describeThrown(error)
				);
			}
			const emitted = deliver("__testConsistent", body);
			if (!emitted) {
				return refusedConsistency(
					describeLabel(label),
					"the consistency binding is not installed in this page"
				);
			}
			// A refused or unpaired rendezvous fails the test even if the caller
			// forgot to await it; awaiting callers still see the rejection. The
			// failure report goes through the same channel and shape as any other
			// failure, and the derived promise is itself handled, so the extra
			// branch never leaves an unhandled rejection behind either.
			// The rejection reason is read under the same rule: a host refusal is
			// normally an Error, but this branch must not be the one place a strange
			// rejection value gets read twice or coerced into a string.
			handled(emitted.catch(function (error) {
				reportFailure(
					"consistency submission for " +
						describeLabel(label) +
						" was refused: " +
						describeThrown(error)
				);
			}));
			return emitted;
		}
		
		function assert(condition, message) {
			if (!condition) {
				fail(message || 'Assertion failed');
				throw new Error(message || 'Assertion failed');
			}
		}
		
		function assertEqual(actual, expected, message) {
			if (actual !== expected) {
				const msg = message || \`Expected \${JSON.stringify(expected)}, got \${JSON.stringify(actual)}\`;
				fail(msg, { actual, expected });
				throw new Error(msg);
			}
		}
		
		const assertEquals = assertEqual;
		
		function assertDeepEqual(actual, expected, message) {
			if (JSON.stringify(actual) !== JSON.stringify(expected)) {
				const msg = message || \`Deep equality failed\`;
				fail(msg, { actual, expected });
				throw new Error(msg);
			}
		}
		
		function ok(message, details) {
			return handled(emitBinding("__testOk", { message, details }));
		}
		
		async function runTest(testFn, autoPass) {
			try {
				await testFn();
				if (autoPass) {
					await pass();
				}
			} catch (err) {
				try {
					await fail(
						err && err.message ? err.message : String(err),
						{ stack: err && err.stack }
					);
				} catch (reportError) {
					// The host rejected the report itself; there is no further channel
					// to use, and runTest must not leave a rejected promise behind.
					console.error("[runway] the failure report was refused", reportError);
				}
			}
		}
		
		// Make functions available globally
		window.pass = pass;
		window.fail = fail;
		window.assertConsistent = assertConsistent;
		window.assert = assert;
		window.assertEqual = assertEqual;
		window.assertEquals = assertEquals;
		window.assertDeepEqual = assertDeepEqual;
		window.ok = ok;
		window.runTest = runTest;
		
		function checkglobal(global) {
			const evalFn = window.__eval || window.eval;
			const realtop = evalFn("top");
			const reallocation = evalFn("location");
			const realparent = evalFn("top");
			const realeval = evalFn;
			assert(global !== realtop, "top was leaked");
			assert(global !== reallocation, "location was leaked");
			assert(global !== realparent, "parent was leaked");
			assert(global !== realeval, "eval was leaked");
		}
		window.checkglobal = checkglobal;
	} catch (err) {
		// ignore
	}
})();
`;
