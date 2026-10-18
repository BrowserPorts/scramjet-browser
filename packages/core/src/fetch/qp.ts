// Query parameters the proxy's URL wire format carries, apart from the fetch handler so the
// rewriters that write them need nothing else from it
export const QP = {
	referrerPolicy: "$rfp",
	referrerSource: "$rfs",
	isModule: "$module",
	topFrame: "$tf",
	parentFrame: "$pf",
	isIframe: "$iframe",
	mode: "$mode",
	credentials: "$cred",
	destination: "$dest",
	initiatorOrigin: "$io",
	fetchSite: "$fs",
	crossSiteRedirect: "$csr",
	fakeDataURL: "$fakedataurl",
	workerName: "$wname",
	workerCorrelation: "$wcorr",
} as const;
