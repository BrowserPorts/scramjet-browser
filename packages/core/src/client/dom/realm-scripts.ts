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

	client.Proxy(INSERTION_METHODS, {
		apply(ctx) {
			const scripts = realm.scriptsIn(ctx.args);
			// Text added to a script in the document runs it, so that script is checked too
			const target = realm.isScriptElement(ctx.this) ? ctx.this : null;
			if (scripts.length === 0 && target === null) return;
			const insert = () => realm.withNonce(scripts, () => ctx.call());
			ctx.return(
				target === null ? insert() : realm.withTextNonce(target, insert)
			);
		},
	});
}
