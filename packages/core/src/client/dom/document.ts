import { unrewriteUrl } from "@rewriters/url";
import { IncrementalHtmlRewriter, rewriteHtml } from "@rewriters/html";
import { ScramjetClient } from "@client/index";
import { String, _RegExp } from "@/shared/snapshot";

export default function (client: ScramjetClient, _self: Self) {
	function resetDocumentWriter(document: Document) {
		client.box.writeRewriters.delete(document);
	}

	// The client of the frame a document belongs to, which is another frame's when a page writes into the document of a
	// frame it holds. Its address, its base and its nonce are what the markup written is rewritten against
	const ownerOf = (document: Document): ScramjetClient =>
		client.box.documents.get(document) ?? client;

	function getDocumentWriter(document: Document) {
		let writer = client.box.writeRewriters.get(document);
		if (!writer) {
			const owner = ownerOf(document);
			writer = new IncrementalHtmlRewriter(owner.context, owner.meta, {
				loadScripts: false,
				inline: true,
				source: owner.url.href,
				apisource: "Document.prototype.write",
			});
			client.box.writeRewriters.set(document, writer);
		}

		return writer;
	}

	client.Proxy("Document.prototype.open", {
		apply(ctx) {
			resetDocumentWriter(ctx.this);
			const owner = ownerOf(ctx.this);
			if (owner.realm) {
				// Opening a document erases the listeners that reach the realm, so they are
				// put back as soon as the browser has erased them. The document may be another
				// frame's, whose realm is the one that listens
				const document = ctx.call();
				owner.realm.reinstall();
				return ctx.return(document);
			}
		},
	});

	// The first write after a document was last opened or closed may open it itself, which erases the listeners that
	// reach the realm as an open does
	const written = (document: Document, text: string, first: boolean) => {
		const owner = ownerOf(document);
		if (
			first &&
			owner.realm &&
			client.descriptors.get("Document.prototype.readyState", document) !== "loading"
		) {
			// A document that is not being parsed is opened by the write, which erases the listeners that reach the realm, and the
			// stub of a script in the markup runs before the write returns. It is opened here so they are back by then
			client.natives.call("Document.prototype.open", document);
			owner.realm.reinstall();
		}
		const writer = getDocumentWriter(document);
		const result = client.natives.call(
			"Document.prototype.write",
			document,
			writer.write(text)
		);
		// A frame the markup made is in the document, and its window can be reached
		owner.realm?.hookFramesUnder(document);
		return result;
	};

	client.Proxy("Document.prototype.write", {
		apply(ctx) {
			const first = !client.box.writeRewriters.has(ctx.this);
			ctx.return(written(ctx.this, ctx.args.join(""), first));
		},
	});

	client.Proxy("Document.prototype.writeln", {
		apply(ctx) {
			const first = !client.box.writeRewriters.has(ctx.this);
			ctx.return(written(ctx.this, ctx.args.join("") + "\n", first));
		},
	});

	client.Proxy("Document.prototype.close", {
		apply(ctx) {
			const writer = client.box.writeRewriters.get(ctx.this);
			if (!writer) {
				return;
			}

			try {
				const remaining = writer.end();
				if (remaining) {
					client.natives.call("Document.prototype.write", ctx.this, remaining);
				}
			} finally {
				resetDocumentWriter(ctx.this);
			}
		},
	});

	client.Proxy("Document.prototype.parseHTMLUnsafe", {
		apply(ctx) {
			const html = String(ctx.args[0]);
			ctx.args[0] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				// Builds a document of its own: it inherits no base selection from the
				// document that called it.
				newDocument: true,
				apisource: "Document.prototype.parseHTMLUnsafe",
			});
		},
	});

	// The address a document has, which is another frame's when a page reads the document of a frame it holds. That
	// frame's own client knows it, and a frame this client holds nothing of has the proxy's address natively
	const addressOf = (ctx: { this: unknown; get(): unknown }): URL => {
		const doc = ctx.this as Document;
		if (doc === client.global.document) return client.url;
		const owner = client.box.documents.get(doc);
		if (owner) return owner.url;
		try {
			return new URL(unrewriteUrl(String(ctx.get()), client.context));
		} catch {
			return client.url;
		}
	};

	client.Trap("Document.prototype.domain", {
		get(ctx) {
			return addressOf(ctx).hostname;
		},
		set() {
			return false;
		},
	});

	client.Trap("Document.prototype.documentURI", {
		get(ctx) {
			return addressOf(ctx).href;
		},
		set() {
			return false;
		},
	});

	client.Trap("Document.prototype.URL", {
		get(ctx) {
			return addressOf(ctx).href;
		},
		set() {
			return false;
		},
	});

	client.Trap("Document.prototype.referrer", {
		get(ctx) {
			if (ctx.this !== client.global.document) {
				return client.descriptors.get("Document.prototype.referrer", ctx.this);
			}
			const navigation = client.history?.[client.history.length - 1];
			return navigation?.referrer ?? "";
		},
	});

	// Rewrite the URL-attribute selectors Scramjet understands, and neutralise any
	// selector that probes Scramjet's own attributes (`[scramjet-attr-*]`,
	// `[scramjet-injected]`) so that branch matches nothing — exactly as it would
	// on a page that was never proxied. querySelector(All) exists on Document,
	// Element and DocumentFragment, so cover them all; the per-attribute masking
	// on getAttribute is otherwise bypassed by a selector match.
	const maskSelector = (selector: unknown): string => {
		let s = String(selector).replace(
			/((?:^|\s)\b\w+\[(?:src|href|data-href))[\^]?(=['"]?(?:https?[:])?\/\/)/,
			"$1*$2"
		);
		s = s.replace(
			new _RegExp("\\[\\s*scramjet-(?:attr[\\w-]*|injected)[^\\]]*\\]", "gi"),
			":not(*)"
		);

		return s;
	};

	client.Proxy(
		[
			"Document.prototype.querySelector",
			"Document.prototype.querySelectorAll",
			"Element.prototype.querySelector",
			"Element.prototype.querySelectorAll",
			"DocumentFragment.prototype.querySelector",
			"DocumentFragment.prototype.querySelectorAll",
		],
		{
			apply(ctx) {
				ctx.args[0] = maskSelector(ctx.args[0]);
			},
		}
	);
}
