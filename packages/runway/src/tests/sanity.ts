import { scriptTest } from "../testkit.ts";

export default scriptTest({
	name: "sanity-01",
	js: `
		runTest(async () => {
			assert(document.body !== null, "document.body should exist");
			assert(typeof window === "object", "window should be an object");
		});
	`,
});
