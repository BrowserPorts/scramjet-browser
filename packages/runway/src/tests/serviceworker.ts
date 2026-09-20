import http from "http";
import { originTest, type NativeTest } from "../testkit.ts";

/**
 * A page plus the service worker script it registers. `originTest` already
 * answers `/` and `/script.js`; anything else this test needs is served by a
 * second listener that only runs when the first one declined.
 */
function swTest(props: {
  name: string;
  js: string;
  sw: string | ((requestCount: number) => string);
  routes?: Record<
    string,
    { type: string; body: string; headers?: Record<string, string> }
  >;
  autoPass?: boolean;
  expectedOkCalls?: number;
}): NativeTest {
  return originTest({
    name: props.name,
    autoPass: props.autoPass ?? false,
    candidateOnly: false,
    expectedOkCalls: props.expectedOkCalls,
    js: props.js,
    async start(server: http.Server) {
      const serviceWorkerRequests = new Map<string, number>();
      server.on("request", (req, res) => {
        if (res.headersSent || res.writableEnded) return;

        const url = (req.url ?? "").split("?")[0];

        if (url === "/sw.js") {
          res.writeHead(200, {
            "Content-Type": "application/javascript",
            "Cache-Control": "no-store",
          });
          const requestKey = req.url ?? "/sw.js";
          const requestCount = (serviceWorkerRequests.get(requestKey) ?? 0) + 1;
          serviceWorkerRequests.set(requestKey, requestCount);
          res.end(
            typeof props.sw === "function"
              ? props.sw(requestCount)
              : props.sw,
          );

          return;
        }

        const route = props.routes?.[url];
        if (route) {
          res.writeHead(200, {
            "Content-Type": route.type,
            ...route.headers,
          });
          res.end(route.body);

          return;
        }

        res.writeHead(404);
        res.end("Not found");
      });
    },
  });
}

// register() resolves as soon as the job is queued, so tests that care about a
// running worker wait for the registration to reach `activated`
const waitForActive = `
	async function waitForActive(registration) {
		for (let i = 0; i < 200; i++) {
			const worker = registration.active;
			if (worker && worker.state === "activated") return worker;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error("service worker never activated");
	}
`;

export default [
  // --- the container itself ------------------------------------------------

  originTest({
    name: "serviceworker-container-is-native",
    autoPass: true,
    candidateOnly: true,
    js: `
			const container = navigator.serviceWorker;
			assert(container, "navigator.serviceWorker should exist");
			assert(
				container instanceof ServiceWorkerContainer,
				"container should be a ServiceWorkerContainer"
			);
			assertEqual(
				Object.prototype.toString.call(container),
				"[object ServiceWorkerContainer]",
				"toStringTag should be native"
			);
			assertEqual(
				Object.getPrototypeOf(container),
				ServiceWorkerContainer.prototype,
				"prototype should be the native one"
			);
			assert(
				container.register.toString().includes("[native code]"),
				"register should look native"
			);
			assertEqual(
				Object.getOwnPropertyDescriptor(Navigator.prototype, "serviceWorker")
					.get.toString().includes("[native code]"),
				true,
				"the serviceWorker accessor should look native"
			);
			assert(
				"ready" in ServiceWorkerContainer.prototype,
				"ready should be on the prototype"
			);
			assert(
				container.ready instanceof Promise,
				"ready should be a promise"
			);
		`,
    async start() {},
  }),

  // --- registration errors -------------------------------------------------

  swTest({
    name: "serviceworker-register-cross-origin-rejects",
    sw: `/* never loaded */`,
    autoPass: false,
    js: `
			try {
				await navigator.serviceWorker.register("https://example.com/sw.js");
				fail("cross-origin register should have thrown");
			} catch (err) {
				assertEqual(err.name, "SecurityError", "registration origin and scope restrictions use SecurityError");
				assert(
					String(err.message).includes("does not match the current origin"),
					"message should match the platform's, got: " + err.message
				);
				pass();
			}
		`,
  }),

  swTest({
    name: "serviceworker-register-scope-above-script-rejects",
    sw: `/* never loaded */`,
    autoPass: false,
    routes: {
      "/nested/sw.js": {
        type: "application/javascript",
        body: `/* never loaded */`,
      },
    },
    js: `
			try {
				await navigator.serviceWorker.register("/nested/sw.js", { scope: "/" });
				fail("out-of-range scope should have thrown");
			} catch (err) {
				assertEqual(err.name, "SecurityError", "registration origin and scope restrictions use SecurityError");
				assert(
					String(err.message).includes("max scope"),
					"message should mention the max scope, got: " + err.message
				);
				pass();
			}
		`,
  }),

  // --- lifecycle -----------------------------------------------------------

  swTest({
    name: "serviceworker-register-lifecycle",
    sw: `
			self.addEventListener("install", (event) => {
				event.waitUntil(self.skipWaiting());
			});
			self.addEventListener("activate", (event) => {
				event.waitUntil(self.clients.claim());
			});
		`,
    autoPass: false,
    js: `
			${waitForActive}

			const registration = await navigator.serviceWorker.register("/sw.js");
			assert(
				registration instanceof ServiceWorkerRegistration,
				"register should resolve to a ServiceWorkerRegistration"
			);
			assertEqual(
				Object.prototype.toString.call(registration),
				"[object ServiceWorkerRegistration]",
				"registration should carry the native brand"
			);
			assertEqual(
				registration.scope,
				location.origin + "/",
				"scope should be the unrewritten page origin"
			);

			const worker = await waitForActive(registration);
			assert(
				worker instanceof ServiceWorker,
				"active should be a ServiceWorker"
			);
			assertEqual(
				worker.scriptURL,
				location.origin + "/sw.js",
				"scriptURL should be unrewritten"
			);
			assertEqual(worker.state, "activated", "state should be activated");

			const ready = await navigator.serviceWorker.ready;
			assertEqual(ready.scope, registration.scope, "ready should resolve to the registration");

			pass();
		`,
  }),

  swTest({
    name: "serviceworker-controller-and-controllerchange",
    sw: `
			self.addEventListener("install", (event) => {
				event.waitUntil(self.skipWaiting());
			});
			self.addEventListener("activate", (event) => {
				event.waitUntil(self.clients.claim());
			});
		`,
    autoPass: false,
    js: `
			${waitForActive}

			assertEqual(
				navigator.serviceWorker.controller,
				null,
				"an unregistered page should have no controller"
			);

			let sawControllerChange = false;
			navigator.serviceWorker.addEventListener("controllerchange", () => {
				sawControllerChange = true;
			});

			const registration = await navigator.serviceWorker.register("/sw.js");
			await waitForActive(registration);

			for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++) {
				await new Promise((r) => setTimeout(r, 50));
			}

			const controller = navigator.serviceWorker.controller;
			assert(controller, "claim() should have installed a controller");
			assert(
				controller instanceof ServiceWorker,
				"controller should be a ServiceWorker"
			);
			assertEqual(
				controller.scriptURL,
				location.origin + "/sw.js",
				"controller.scriptURL should be unrewritten"
			);
			assert(sawControllerChange, "controllerchange should have fired");

			pass();
		`,
  }),

  // --- fetch interception --------------------------------------------------

  swTest({
    name: "serviceworker-fetch-intercept",
    sw: `
			self.addEventListener("install", (event) => {
				event.waitUntil(self.skipWaiting());
			});
			self.addEventListener("activate", (event) => {
				event.waitUntil(self.clients.claim());
			});
			self.addEventListener("fetch", (event) => {
				const url = new URL(event.request.url);
				if (url.pathname === "/intercepted") {
					event.respondWith(
						new Response("from the service worker", {
							status: 200,
							headers: { "Content-Type": "text/plain" },
						})
					);
				}
			});
		`,
    routes: {
      "/passthrough": { type: "text/plain", body: "from the network" },
    },
    autoPass: false,
    js: `
			${waitForActive}

			const registration = await navigator.serviceWorker.register("/sw.js");
			await waitForActive(registration);
			for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++) {
				await new Promise((r) => setTimeout(r, 50));
			}
			assert(navigator.serviceWorker.controller, "page should be controlled");

			const intercepted = await fetch("/intercepted").then((r) => r.text());
			assertEqual(
				intercepted,
				"from the service worker",
				"the worker's response should win"
			);

			// a request the worker declines still has to reach the network
			const passthrough = await fetch("/passthrough").then((r) => r.text());
			assertEqual(
				passthrough,
				"from the network",
				"an unhandled request should fall through"
			);

			pass();
		`,
  }),

  swTest({
    name: "serviceworker-fetch-request-url-is-unrewritten",
    sw: `
			self.addEventListener("install", (event) => {
				event.waitUntil(self.skipWaiting());
			});
			self.addEventListener("activate", (event) => {
				event.waitUntil(self.clients.claim());
			});
			self.addEventListener("fetch", (event) => {
				const url = new URL(event.request.url);
				if (url.pathname !== "/echo-url") return;
				event.respondWith(
					new Response(
						JSON.stringify({
							url: event.request.url,
							method: event.request.method,
							scope: self.registration.scope,
							location: self.location.href,
							globalBrand: Object.prototype.toString.call(self),
							isServiceWorkerGlobal: self instanceof ServiceWorkerGlobalScope,
							hasWindow: typeof Window !== "undefined",
							hasSharedWorkerGlobal:
								typeof SharedWorkerGlobalScope !== "undefined",
						}),
						{ headers: { "Content-Type": "application/json" } }
					)
				);
			});
		`,
    autoPass: false,
    js: `
			${waitForActive}

			const registration = await navigator.serviceWorker.register("/sw.js");
			await waitForActive(registration);
			for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++) {
				await new Promise((r) => setTimeout(r, 50));
			}

			const seen = await fetch("/echo-url").then((r) => r.json());
			assertEqual(
				seen.url,
				location.origin + "/echo-url",
				"the worker should see the site url, not the proxied one"
			);
			assertEqual(seen.method, "GET", "method should survive");
			assertEqual(
				seen.scope,
				location.origin + "/",
				"registration.scope should be unrewritten inside the realm"
			);
			assertEqual(
				seen.location,
				location.origin + "/sw.js",
				"self.location should be the unrewritten script url"
			);
			assertEqual(
				seen.globalBrand,
				"[object ServiceWorkerGlobalScope]",
				"the worker should have the native global brand"
			);
			assert(seen.isServiceWorkerGlobal, "the worker should pass native instanceof");
			assertEqual(seen.hasWindow, false, "Window should not exist in the worker");
			assertEqual(
				seen.hasSharedWorkerGlobal,
				false,
				"the worker must not expose a SharedWorker global"
			);

			pass();
		`,
  }),

  // --- messaging -----------------------------------------------------------

  swTest({
    name: "serviceworker-message-roundtrip",
    sw: `
			self.addEventListener("install", (event) => {
				event.waitUntil(self.skipWaiting());
			});
			self.addEventListener("activate", (event) => {
				event.waitUntil(self.clients.claim());
			});
			self.addEventListener("message", (event) => {
				event.waitUntil((async () => {
					const clients = await self.clients.matchAll({ includeUncontrolled: true });
					for (const client of clients) {
						client.postMessage({
							echo: event.data,
							origin: event.origin,
							sourceUrl: event.source ? event.source.url : null,
							clientCount: clients.length,
						});
					}
				})());
			});
		`,
    autoPass: false,
    js: `
			${waitForActive}

			const registration = await navigator.serviceWorker.register("/sw.js");
			const worker = await waitForActive(registration);
			for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++) {
				await new Promise((r) => setTimeout(r, 50));
			}

			const reply = await new Promise((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("no reply from the service worker")),
					10000
				);
				navigator.serviceWorker.addEventListener("message", (event) => {
					clearTimeout(timer);
					resolve(event);
				});
				navigator.serviceWorker.controller.postMessage({ hello: "worker" });
			});

			assertEqual(reply.data.echo.hello, "worker", "payload should round-trip");
			assertEqual(
				reply.data.origin,
				location.origin,
				"event.origin inside the worker should be the site origin"
			);
			assertEqual(
				reply.data.sourceUrl,
				location.href,
				"event.source should be the page that sent it"
			);
			assertEqual(reply.data.clientCount, 1, "matchAll must only expose clients of this virtual origin");
			assertEqual(
				reply.origin,
				location.origin,
				"the reply's origin should be the site origin"
			);

			pass();
		`,
  }),

  // --- registration bookkeeping -------------------------------------------

  swTest({
    name: "serviceworker-getregistration-and-unregister",
    sw: `
			self.addEventListener("install", (event) => {
				event.waitUntil(self.skipWaiting());
			});
			self.addEventListener("activate", (event) => {
				event.waitUntil(self.clients.claim());
			});
		`,
    autoPass: false,
    js: `
			${waitForActive}

			const registration = await navigator.serviceWorker.register("/sw.js");
			await waitForActive(registration);

			const found = await navigator.serviceWorker.getRegistration();
			assert(found, "getRegistration should find the registration");
			assertEqual(found.scope, registration.scope, "scopes should match");
			assertEqual(found, registration, "the same object should come back");

			const all = await navigator.serviceWorker.getRegistrations();
			assert(Array.isArray(all), "getRegistrations should return an array");
			assert(
				all.some((r) => r.scope === registration.scope),
				"the registration should be listed"
			);

			const unregistered = await registration.unregister();
			assertEqual(unregistered, true, "unregister should report success");

			const afterwards = await navigator.serviceWorker.getRegistrations();
			assert(
				!afterwards.some((r) => r.scope === registration.scope),
				"the registration should be gone"
			);

			pass();
		`,
  }),

  // --- native internal slots and update jobs -------------------------------

  swTest({
    name: "serviceworker-native-internal-slots",
    sw: `
			self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
			self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
		`,
    autoPass: false,
    js: `
			${waitForActive}
			const registration = await navigator.serviceWorker.register("/sw.js");
			const worker = await waitForActive(registration);
			assertEqual(Object.getPrototypeOf(registration), ServiceWorkerRegistration.prototype);
			assertEqual(Object.getPrototypeOf(worker), ServiceWorker.prototype);

			const scopeGetter = Object.getOwnPropertyDescriptor(
				ServiceWorkerRegistration.prototype, "scope"
			).get;
			let scopeBrandChecked = false;
			try { scopeGetter.call({}); } catch (error) {
				scopeBrandChecked = error instanceof TypeError;
			}
			assert(scopeBrandChecked, "scope getter should enforce its native internal slot");

			const stateGetter = Object.getOwnPropertyDescriptor(
				ServiceWorker.prototype, "state"
			).get;
			let stateBrandChecked = false;
			try { stateGetter.call({}); } catch (error) {
				stateBrandChecked = error instanceof TypeError;
			}
			assert(stateBrandChecked, "state getter should enforce its native internal slot");

			let registerBrandChecked = false;
			try {
				await ServiceWorkerContainer.prototype.register.call({}, "/sw.js");
			} catch (error) {
				registerBrandChecked = error instanceof TypeError;
			}
			assert(registerBrandChecked, "register should reject an incompatible receiver");
			await registration.unregister();
			pass();
		`,
  }),

  swTest({
    name: "serviceworker-service-worker-allowed-expands-scope",
    sw: `/* unused */`,
    routes: {
      "/nested/sw.js": {
        type: "application/javascript",
        headers: { "Service-Worker-Allowed": "/" },
        body: `
					self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
					self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
				`,
      },
    },
    autoPass: false,
    js: `
			${waitForActive}
			const registration = await navigator.serviceWorker.register(
				"/nested/sw.js", { scope: "/" }
			);
			await waitForActive(registration);
			assertEqual(registration.scope, location.origin + "/");
			await registration.unregister();
			pass();
		`,
  }),

  swTest({
    name: "serviceworker-update-installs-new-script",
    sw: (requestCount) => `
			const VERSION = ${requestCount};
			self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
			self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
			self.addEventListener("fetch", (event) => {
				if (new URL(event.request.url).pathname === "/version") {
					event.respondWith(new Response(String(VERSION)));
				}
			});
		`,
    autoPass: false,
    js: `
			${waitForActive}
			const registration = await navigator.serviceWorker.register("/sw.js?run=" + crypto.randomUUID());
			await waitForActive(registration);
			for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assertEqual(await fetch("/version").then((r) => r.text()), "1");

			const updated = await registration.update();
			assertEqual(updated, registration, "update should preserve registration identity");
			let version = "1";
			for (let i = 0; i < 200 && version !== "2"; i++) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				version = await fetch("/version").then((r) => r.text());
			}
			assertEqual(version, "2", "update should activate freshly fetched source");
			await registration.unregister();
			pass();
		`,
  }),
];
