import { scriptTest } from "runway/testkit";

export default scriptTest({
	name: "consumer-plugin-contract",
	candidateOnly: true,
	js: `
		const response = await fetch("/script.js");
		assertEqual(response.status, 200, "plugin forwards fixture requests");
		assert((await response.text()).length > 0, "forwarded response has a body");
	`,
});
