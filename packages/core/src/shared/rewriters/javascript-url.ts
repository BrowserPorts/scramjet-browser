/**
 * The URL as the URL parser first reads it: leading control characters and spaces are
 * dropped, and tabs and newlines are removed wherever they are. The scheme check and the
 * script a `javascript:` URL runs both come from this text.
 */
export function parserReadableUrl(url: string): string {
	// eslint-disable-next-line no-control-regex
	return url.replace(/^[\u0000-\u0020]+/u, "").replace(/[\t\n\r]/gu, "");
}

/** Whether a browser would take this string for a `javascript:` URL, whatever its case or spacing */
export function isJavascriptUrl(url: string): boolean {
	const readable = parserReadableUrl(url);
	return (
		readable.length >= "javascript:".length &&
		readable.slice(0, "javascript:".length).toLowerCase() === "javascript:"
	);
}
