import { identityName } from "@/runtime-identity";

// Query parameters the proxy's URL wire format carries, apart from the fetch handler so the
// rewriters that write them need nothing else from it
export const QP = {
	referrerPolicy: identityName("$rfp"),
	referrerSource: identityName("$rfs"),
	isModule: identityName("$module"),
	topFrame: identityName("$tf"),
	parentFrame: identityName("$pf"),
	isIframe: identityName("$iframe"),
	mode: identityName("$mode"),
	credentials: identityName("$cred"),
	destination: identityName("$dest"),
	initiatorOrigin: identityName("$io"),
	fetchSite: identityName("$fs"),
	crossSiteRedirect: identityName("$csr"),
	fakeDataURL: identityName("$fakedataurl"),
	workerName: identityName("$wname"),
	workerCorrelation: identityName("$wcorr"),
} as const;
