import { ScramjetClient } from "@client/index";
import { Type } from "@client/webidl";

export default function (client: ScramjetClient, _self: Self) {
	client.Intercept(class extends Document {
		@Type("USVString")
		get cookie(): string {
			void super.cookie;
			const jar = client.context.cookieJar;

			return jar.getDocumentCookie
				? jar.getDocumentCookie({ url: client.url })
				: jar.getCookies(client.url, true);
		}
		@Type("USVString")
		set cookie(value: string) {
			void super.cookie;
			const jar = client.context.cookieJar;
			const result = jar.setDocumentCookie
				? jar.setDocumentCookie({ url: client.url, cookie: value })
				: jar.setCookies(value, client.url, true);
			// a store that settles later settles on its own: `document.cookie`
			// is synchronous, and its failure is not the page's
			if (result && typeof (result as Promise<unknown>).then === "function")
				(result as Promise<unknown>).then(undefined, () => undefined);
			client.init.sendSetCookie([
				{
					url: client.url,
					cookie: value,
				},
			]);
		}
	});
}
