import { ScramjetClient } from "@client/index";

export default function (client: ScramjetClient, self: Self) {
	client.Trap("Document.prototype.cookie", {
		get() {
			return client.context.cookieJar.getDocumentCookie
				? client.context.cookieJar.getDocumentCookie({ url: client.url })
				: client.context.cookieJar.getCookies(client.url, true);
		},
		set(ctx, value: string) {
			const result = client.context.cookieJar.setDocumentCookie
				? client.context.cookieJar.setDocumentCookie({
						url: client.url,
						cookie: value,
					})
				: client.context.cookieJar.setCookies(value, client.url, true);
			if (typeof result === "object" && result !== null) {
				result.catch(() => false);
			}
			client.init.sendSetCookie([
				{
					url: client.url,
					cookie: value,
				},
			]);
		},
	});

	// @ts-ignore
	delete self.cookieStore;
}
