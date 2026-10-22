import { Reflect_get } from "@/shared/snapshot";
import type { ScramjetClient } from "@client/index";

/**
 * In realm mode the browser runs a script only if it holds the document's
 * nonce, and the client gives it that for the length of the call that inserts it.
 * A script the page builds is inserted by one of these calls, so each is wrapped:
 * the scripts in its arguments are checked, turned into stubs where they hold the
 * page's own text, and given the nonce while the browser inserts them.
 *
 * An insertion path that is not listed here leaves its scripts without a nonce,
 * and the browser refuses them.
 */

// The parent node methods, on every interface that has them
const INSERTION_METHODS = [
	"Node.prototype.appendChild",
	"Node.prototype.insertBefore",
	"Node.prototype.replaceChild",
	"Element.prototype.append",
	"Element.prototype.prepend",
	"Element.prototype.before",
	"Element.prototype.after",
	"Element.prototype.replaceWith",
	"Element.prototype.replaceChildren",
	"Element.prototype.insertAdjacentElement",
	"CharacterData.prototype.before",
	"CharacterData.prototype.after",
	"CharacterData.prototype.replaceWith",
	"DocumentFragment.prototype.append",
	"DocumentFragment.prototype.prepend",
	"DocumentFragment.prototype.replaceChildren",
	"Document.prototype.append",
	"Document.prototype.prepend",
	"Document.prototype.replaceChildren",
	"Range.prototype.insertNode",
] as const;

export const enabled = (client: ScramjetClient) =>
	client.flagEnabled("realmExecution");

export default function (client: ScramjetClient) {
	const realm = client.realm;
	if (!realm) return;

	// The browser reports each policy violation to a ReportingObserver as well, with the policy
	// it enforced, which holds the document's nonce. The page is shown none of them
	if (typeof Reflect_get(client.global, "ReportingObserver") === "function") {
		type Report = { type?: unknown };
		const withoutViolations = (reports: readonly Report[]) =>
			reports.filter((report) => report.type !== "csp-violation");
		client.Proxy("ReportingObserver", {
			construct(ctx) {
				const callback = ctx.args[0];
				if (typeof callback !== "function") return;
				ctx.args[0] = function (
					this: unknown,
					reports: Report[],
					observer: unknown
				) {
					const kept = withoutViolations(reports);
					if (kept.length === 0) return;
					return callback.call(this, kept, observer);
				};
			},
		});
		client.Proxy("ReportingObserver.prototype.takeRecords", {
			apply(ctx) {
				ctx.return(withoutViolations(ctx.call() as Report[]));
			},
		});
	}

	client.Proxy(INSERTION_METHODS, {
		apply(ctx) {
			const { scripts, frames } = realm.insertedIn(ctx.args);
			// Text added to a script in the document runs it, so that script is checked too
			const target = realm.isScriptElement(ctx.this) ? ctx.this : null;
			if (scripts.length === 0 && frames.length === 0 && target === null) return;
			const insert = () => realm.withNonce(scripts, () => ctx.call());
			const result =
				target === null ? insert() : realm.withTextNonce(target, insert);
			// A frame that is in the document has a window the page can reach at once
			realm.hookFrames(frames);
			ctx.return(result);
		},
	});

	// A range that wraps its contents in a frame puts the frame in the document too
	client.Proxy("Range.prototype.surroundContents", {
		apply(ctx) {
			const { frames } = realm.insertedIn([ctx.args[0]]);
			if (frames.length === 0) return;
			const result = ctx.call();
			realm.hookFrames(frames);
			ctx.return(result);
		},
	});
}
