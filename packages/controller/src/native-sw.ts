/// <reference lib="WebWorker" />

// This file must remain a network-served, same-origin service-worker script.
// The transformed virtual worker is supplied by the registering page because
// service-worker update fetches intentionally bypass other service workers.
const source = new URL(location.href).searchParams.get("$source");
if (!source) throw new TypeError("Missing transformed service-worker source");

const bytes = Uint8Array.from(atob(source), (char) => char.charCodeAt(0));
const script = new TextDecoder().decode(bytes);
(0, eval)(script);
