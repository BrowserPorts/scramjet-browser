import { playwrightTest } from "../../testcommon.ts";

// A page that runs in the realm is slower to draw, and the harness says how much slower through RUNWAY_TIMEOUT_SCALE
const wait = 30000 * Math.max(1, Number(process.env.RUNWAY_TIMEOUT_SCALE ?? 1));

export default [
	playwrightTest({
		name: "site-youtube-frontpage",
		fn: async ({ frame, navigate }) => {
			await navigate("https://www.youtube.com/");

			// Wait for the YouTube logo to be visible
			const logo = frame.locator("#logo-icon > span > div").first();
			await logo.waitFor({ state: "visible", timeout: wait });
		},
	}),

	playwrightTest({
		name: "site-youtube-search",
		fn: async ({ frame, navigate }) => {
			await navigate("https://www.youtube.com/results?search_query=bad+apple");

			// Wait for search results to load
			const title = frame.locator("#video-title > yt-formatted-string").first();
			await title.waitFor({ state: "visible", timeout: wait });

			const thumbnail = frame.locator(
				"#contents > ytd-video-renderer:nth-child(1) > #dismissible > ytd-thumbnail > a > yt-image > img"
			);
			await thumbnail.waitFor({ state: "visible", timeout: wait });
		},
	}),
];
