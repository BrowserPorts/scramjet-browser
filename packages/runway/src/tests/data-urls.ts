import { basicTest } from "../testcommon.ts";

// data: URLs travel through the proxy's codec, with their own fragment outside
// the encoded part, and are fetched by the platform with the page's method.
// Each case runs natively too, so the expectations are the browser's

export default [
	basicTest({
		name: "data-url-fetch-text",
		js: `
			const response = await fetch("data:text/plain,hello");
			assertEqual(await response.text(), "hello", "body");
			assertEqual(response.headers.get("content-type"), "text/plain", "type");
		`,
	}),
	basicTest({
		name: "data-url-fetch-fragment",
		js: `
			const response = await fetch("data:text/plain,hello#frag");
			assertEqual(await response.text(), "hello", "the fragment is not payload");
		`,
	}),
	basicTest({
		name: "data-url-fetch-dot-segments",
		js: `
			const response = await fetch("data:text/plain,x/../y");
			assertEqual(await response.text(), "x/../y", "dot segments are payload");
		`,
	}),
	basicTest({
		name: "data-url-fetch-base64",
		js: `
			const response = await fetch("data:application/octet-stream;base64,AAEC/w==");
			const bytes = new Uint8Array(await response.arrayBuffer());
			assertEqual(Array.from(bytes).join(","), "0,1,2,255", "bytes");
		`,
	}),
	basicTest({
		name: "data-url-fetch-head",
		js: `
			const response = await fetch("data:text/plain,hello", { method: "HEAD" });
			assertEqual(response.status, 200, "status");
			assertEqual(await response.text(), "", "a HEAD has no body");
		`,
	}),
	basicTest({
		name: "data-url-fetch-post",
		js: `
			const response = await fetch("data:text/plain,hello", { method: "POST", body: "ignored" });
			assertEqual(await response.text(), "hello", "a POST answers with the payload");
		`,
	}),
	basicTest({
		name: "data-url-fetch-lone-surrogate",
		js: `
			const response = await fetch("data:text/plain," + "\\ud800");
			assertEqual(await response.text(), "\\ufffd", "a lone surrogate becomes U+FFFD");
		`,
	}),
	basicTest({
		name: "data-url-fetch-oversized",
		js: `
			const payload = "a".repeat(2 * 1024 * 1024 + 4096);
			const response = await fetch("data:text/plain," + payload);
			const text = await response.text();
			assertEqual(text.length, payload.length, "length");
			assertEqual(text === payload, true, "content");
		`,
	}),
	basicTest({
		name: "data-url-fetch-invalid-rejects",
		js: `
			let rejected = false;
			try {
				await fetch("data:;base64,a");
			} catch (e) {
				rejected = e instanceof TypeError;
			}
			assertEqual(rejected, true, "an invalid base64 payload is a network error");
		`,
	}),
	basicTest({
		name: "data-url-forged-marker-keeps-blob",
		scramjetOnly: true,
		js: `
			// a page-made blob named by a forged fake-data marker is not fetched
			// as a data: URL, and is not revoked by the attempt
			const blob = URL.createObjectURL(new Blob(["https://example.com/"]));
			try {
				await fetch(blob + "?$fakedataurl=1");
			} catch {}
			const response = await fetch(blob);
			assertEqual(await response.text(), "https://example.com/", "the blob still loads");
		`,
	}),
];
