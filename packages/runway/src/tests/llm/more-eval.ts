import { scriptTest } from "../../testkit.ts";

export default [
	scriptTest({
		name: "moreeval-modify-locals",
		js: `
			let x = 10;
			eval("x = 20");
			assertEqual(x, 20, "eval should modify local variable");
		`,
	}),
	scriptTest({
		name: "moreeval-return-value",
		js: `
			let result = eval("1 + 1");
			assertEqual(result, 2, "eval should return the result of the expression");
		`,
	}),
	scriptTest({
		name: "moreeval-nested",
		js: `
			let x = 1;
			eval("eval('x = 2')");
			assertEqual(x, 2, "nested eval should modify local variable");
		`,
	}),
	scriptTest({
		name: "moreeval-indirect-var-leak",
		js: `
			(0,eval)("var leakedGlobal = 'yes'");
			assertEqual(window.leakedGlobal, 'yes', "indirect eval should leak var to global");
			delete window.leakedGlobal;
		`,
	}),
	scriptTest({
		name: "moreeval-direct-var-scope",
		js: `
			eval("var leakedLocal = 'yes'");
			assertEqual(leakedLocal, 'yes', "direct eval should introduce var to local scope");
			assertEqual(window.leakedLocal, undefined, "direct eval inside function should not leak var to global");
		`,
	}),
];
