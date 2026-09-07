// Preserve the browser's ServiceWorker objects and lifecycle. Scramjet only maps
// virtual URLs to an encoded native scope and supplies transformed script source
// to a small network-served loader.
import { ScramjetClient } from "@client/index";
import { QP } from "@/fetch/parse";
import { String, String_startsWith, _RegExp, _URL } from "@/shared/snapshot";

const ESCAPED_SLASH = new _RegExp("%2f|%5c", "i");
const SOURCE_PARAM = "$source";
const SCRIPT_PARAM = "$script";
const TYPE_PARAM = "$type";
const NativePromise = globalThis.Promise;

export const order = -20;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += globalThis.String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export default function (client: ScramjetClient, self: Window) {
  const loaderPath = client.context.interface.nativeServiceWorkerPath;
  if (!loaderPath) return;

  const container = client.descriptors.get(
    "Navigator.prototype.serviceWorker",
    self.navigator,
  ) as ServiceWorkerContainer | undefined;
  if (!container) return;
  const NativeServiceWorker = globalThis.ServiceWorker;

  // Capture these before the generic request hooks replace fetch/register.
  const nativeFetch = client.natives.store.fetch as typeof fetch;
  const nativeRegister = client.natives.store[
    "ServiceWorkerContainer.prototype.register"
  ] as ServiceWorkerContainer["register"];
  const nativeGetRegistration = client.natives.store[
    "ServiceWorkerContainer.prototype.getRegistration"
  ] as ServiceWorkerContainer["getRegistration"];
  const nativeGetRegistrations = client.natives.store[
    "ServiceWorkerContainer.prototype.getRegistrations"
  ] as ServiceWorkerContainer["getRegistrations"];

  let readyResolve: ((registration: ServiceWorkerRegistration) => void) | null =
    null;
  const ready = new NativePromise<ServiceWorkerRegistration>((resolve) => {
    readyResolve = resolve;
  });

  function registerError(message: string) {
    return new TypeError(`Failed to register a ServiceWorker: ${message}`);
  }

  function virtualScopeOf(
    registration: ServiceWorkerRegistration,
  ): string | null {
    const nativeScope = client.descriptors.get(
      "ServiceWorkerRegistration.prototype.scope",
      registration,
    ) as string;
    if (!String_startsWith(nativeScope, client.context.prefix.href))
      return null;
    try {
      return client.unrewriteUrl(nativeScope);
    } catch {
      return null;
    }
  }

  function virtualScriptOf(worker: ServiceWorker | null): string | null {
    if (!worker) return null;
    const raw = client.descriptors.get(
      "ServiceWorker.prototype.scriptURL",
      worker,
    ) as string;
    try {
      return new _URL(raw).searchParams.get(SCRIPT_PARAM);
    } catch {
      return null;
    }
  }

  function isSiteWorker(worker: ServiceWorker | null): boolean {
    return virtualScriptOf(worker) !== null;
  }

  async function waitForActive(registration: ServiceWorkerRegistration) {
    if (registration.active) return registration;
    const worker = registration.installing || registration.waiting;
    if (!worker) return registration;
    await new NativePromise<void>((resolve, reject) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
        else if (worker.state === "redundant") {
          reject(
            new TypeError(
              "Service worker became redundant during installation",
            ),
          );
        }
      });
    });
    return registration;
  }

  client.Proxy("ServiceWorkerContainer.prototype.register", {
    apply(ctx) {
      if (ctx.this !== container) return;
      const raw = String(ctx.args[0]);
      const options = (ctx.args[1] ?? {}) as RegistrationOptions;
      ctx.return(
        (async () => {
          const scriptURL = new _URL(raw, client.url.href);
          if (scriptURL.origin !== client.url.origin) {
            throw registerError(
              `The origin of the provided scriptURL ('${scriptURL.origin}') does not match the current origin ('${client.url.origin}').`,
            );
          }
          if (ESCAPED_SLASH.test(scriptURL.pathname)) {
            throw registerError(
              `The provided scriptURL ('${scriptURL.href}') includes a disallowed escape.`,
            );
          }

          const defaultScope = new _URL("./", scriptURL);
          const scope = options.scope
            ? new _URL(String(options.scope), client.url.href)
            : defaultScope;
          if (scope.origin !== client.url.origin) {
            throw registerError(
              `The origin of the provided scope ('${scope.origin}') does not match the current origin ('${client.url.origin}').`,
            );
          }
          if (ESCAPED_SLASH.test(scope.pathname)) {
            throw registerError(
              `The provided scope ('${scope.href}') includes a disallowed escape.`,
            );
          }

          const transformedURL = client.rewriteUrl(scriptURL.href, {
            destination: "serviceworker",
            isModule: options.type === "module",
            swScope: scope.href,
          });
          const response = await nativeFetch.call(self, transformedURL, {
            credentials: "include",
            cache: options.updateViaCache === "none" ? "no-store" : "default",
          });
          if (!response.ok) {
            throw registerError(
              `The script resource returned HTTP status ${response.status}.`,
            );
          }

          const allowedHeader = response.headers.get("Service-Worker-Allowed");
          const maxScope = allowedHeader
            ? new _URL(allowedHeader, scriptURL)
            : defaultScope;
          if (!String_startsWith(scope.pathname, maxScope.pathname)) {
            throw registerError(
              `The path of the provided scope ('${scope.pathname}') is not under the max scope allowed ('${maxScope.pathname}').`,
            );
          }

          const source = new Uint8Array(await response.arrayBuffer());
          const loader = new _URL(loaderPath, self.location.origin);
          loader.searchParams.set(SOURCE_PARAM, bytesToBase64(source));
          loader.searchParams.set(SCRIPT_PARAM, scriptURL.href);
          loader.searchParams.set(TYPE_PARAM, options.type ?? "classic");
          loader.searchParams.set(QP.swScope, scope.href);
          const nativeScope =
            client.context.prefix.href +
            client.context.interface.codecEncode(scope.href);
          const registration = await nativeRegister.call(
            container,
            loader.href,
            {
              scope: nativeScope,
              type: options.type,
              updateViaCache: options.updateViaCache,
            },
          );
          void waitForActive(registration).then((active) => {
            readyResolve?.(active);
            readyResolve = null;
          });
          return registration;
        })(),
      );
    },
  });

  client.Proxy("ServiceWorkerRegistration.prototype.update", {
    apply(ctx) {
      const registration = ctx.this as ServiceWorkerRegistration;
      const scope = virtualScopeOf(registration);
      const worker =
        registration.installing ?? registration.waiting ?? registration.active;
      const scriptURL = virtualScriptOf(worker);
      if (!scope || !scriptURL || !worker) return;

      const nativeScriptURL = client.descriptors.get(
        "ServiceWorker.prototype.scriptURL",
        worker,
      ) as string;
      const type = new _URL(nativeScriptURL).searchParams.get(TYPE_PARAM);
      ctx.return(
        container.register(scriptURL, {
          scope,
          type: type === "module" ? "module" : "classic",
          updateViaCache: registration.updateViaCache,
        }),
      );
    },
  });

  client.Proxy("ServiceWorkerContainer.prototype.getRegistration", {
    apply(ctx) {
      if (ctx.this !== container) return;
      const target = new _URL(
        ctx.args[0] === undefined ? client.url.href : String(ctx.args[0]),
        client.url.href,
      );
      if (target.origin !== client.url.origin) {
        ctx.return(
          NativePromise.reject(
            new TypeError(
              "The documentURL origin does not match the current origin.",
            ),
          ),
        );
        return;
      }
      const nativeTarget =
        client.context.prefix.href +
        client.context.interface.codecEncode(target.href);
      ctx.return(nativeGetRegistration.call(container, nativeTarget));
    },
  });

  client.Proxy("ServiceWorkerContainer.prototype.getRegistrations", {
    apply(ctx) {
      if (ctx.this !== container) return;
      ctx.return(
        nativeGetRegistrations
          .call(container)
          .then((items) =>
            items.filter((item) => virtualScopeOf(item) !== null),
          ),
      );
    },
  });

  client.Trap("ServiceWorkerContainer.prototype.ready", {
    get(ctx) {
      if (ctx.this !== container) return ctx.get();
      return ready;
    },
  });
  client.Trap("ServiceWorkerContainer.prototype.controller", {
    get(ctx) {
      const worker = ctx.get() as ServiceWorker | null;
      return isSiteWorker(worker) ? worker : null;
    },
  });
  client.Trap("ServiceWorkerRegistration.prototype.scope", {
    get(ctx) {
      return virtualScopeOf(ctx.this as ServiceWorkerRegistration) ?? ctx.get();
    },
  });
  client.Trap("ServiceWorker.prototype.scriptURL", {
    get(ctx) {
      return virtualScriptOf(ctx.this as ServiceWorker) ?? ctx.get();
    },
  });
  client.Trap("MessageEvent.prototype.origin", {
    get(ctx) {
      const source = client.descriptors.get(
        "MessageEvent.prototype.source",
        ctx.this,
      );
      if (
        source instanceof NativeServiceWorker &&
        isSiteWorker(source as ServiceWorker)
      ) {
        return client.url.origin;
      }
      return ctx.get();
    },
  });

  // Resolve ready for a registration restored by the browser before this page loaded.
  void nativeGetRegistrations.call(container).then((items) => {
    const registration = items.find(
      (item) => virtualScopeOf(item) !== null && item.active,
    );
    if (registration && readyResolve) {
      readyResolve(registration);
      readyResolve = null;
    }
  });
}
