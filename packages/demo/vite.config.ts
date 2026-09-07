import { viteStaticCopy } from "vite-plugin-static-copy";

export default {
	server: {
		headers: {
			"Origin-Agent-Cluster": "?1",
		},
	},
	plugins: [
		viteStaticCopy({
			structured: false,
			targets: [
				{
					src: "node_modules/@mercuryworkshop/scramjet/dist/*",
					dest: "scramjet",
				},
				{
					src: "node_modules/@mercuryworkshop/scramjet-controller/dist/*",
					dest: "controller",
				},
			],
			watch: {
				reloadPageOnChange: true,
			},
		}),
	],
};
