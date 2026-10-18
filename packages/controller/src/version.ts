declare const SCRAMJET_RUNTIME_NAMESPACE: string | undefined;
declare const SCRAMJET_EXPECTED_VERSION: string;
declare const CONTROLLER_VERSION: string;

export const VERSION = CONTROLLER_VERSION;

function assertVersionMatch(
	packageName: string,
	expected: string,
	actual: string
) {
	if (expected !== actual) {
		throw new Error(
			`${packageName} version mismatch: this build expects ${expected}, but the loaded runtime is ${actual}`
		);
	}
}

export function assertRuntimeScramjetVersion() {
	const name =
		typeof SCRAMJET_RUNTIME_NAMESPACE === "undefined"
			? "$scramjet"
			: SCRAMJET_RUNTIME_NAMESPACE;
	const runtime = (
		globalThis as unknown as Record<string, typeof $scramjet | undefined>
	)[name];
	if (!runtime) {
		throw new Error(
			"@mercuryworkshop/scramjet is not loaded. Load scramjet before the controller."
		);
	}

	assertVersionMatch(
		"@mercuryworkshop/scramjet",
		SCRAMJET_EXPECTED_VERSION,
		runtime.versionInfo.version
	);
}
