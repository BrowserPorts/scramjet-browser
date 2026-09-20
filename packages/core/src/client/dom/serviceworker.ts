// Preserve the browser's ServiceWorker objects and lifecycle. Scramjet only maps
// virtual URLs to an encoded native scope and supplies transformed script source
// to a small network-served loader.
import { ScramjetClient } from "@client/index";
import { QP } from "@/fetch/parse";
import { String, String_startsWith, _RegExp, _URL } from "@/shared/snapshot";
import { isJavascriptMimeType } from "@/shared/mime";

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
  const installer = client.init.installServiceWorkerClient ?? (
    client.init.serviceWorkerClientName
      ? ScramjetClient.getServiceWorkerClientInstaller(client.init.serviceWorkerClientName)
      : undefined
  );
  if (installer) {
    installer(client, self);
    return;
  }
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

  let readyResolve:
    | ((registration: ServiceWorkerRegistration) => unknown)
    | null = null;
  const ready = new NativePromise<ServiceWorkerRegistration>((resolve) => {
    readyResolve = resolve;
  });

  function registerError(message: string) {
    return new TypeError(`Failed to register a ServiceWorker: ${message}`);
  }

  function securityError(message: string) {
    return new DOMException(
      `Failed to register a ServiceWorker: ${message}`,
      "SecurityError",
    );
  }

  function resolveReady(registration: ServiceWorkerRegistration) {
    const scope = virtualScopeOf(registration);
    if (scope && client.url.href.startsWith(scope) && registration.active) {
      readyResolve?.(registration);
      readyResolve = null;
    }
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
      const scope = client.unrewriteUrl(nativeScope);
      return new _URL(scope).origin === client.url.origin ? scope : null;
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
    await new NativePromise<undefined>((resolve, reject) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve(undefined);
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
      ctx.return(
        (async () => {
          if (!ctx.args.length) throw registerError("A scriptURL is required.");
          const raw = String(ctx.args[0]);
          const dictionary = ctx.args[1];
          if (
            dictionary != null &&
            typeof dictionary !== "object" &&
            typeof dictionary !== "function"
          ) {
            throw new TypeError("RegistrationOptions must be a dictionary");
          }
          const options: RegistrationOptions = {};
          if (dictionary?.scope !== undefined)
            options.scope = String(dictionary.scope);
          options.type =
            dictionary?.type === undefined
              ? "classic"
              : (String(dictionary.type) as WorkerType);
          options.updateViaCache =
            dictionary?.updateViaCache === undefined
              ? "imports"
              : (String(
                  dictionary.updateViaCache,
                ) as ServiceWorkerUpdateViaCache);
          if (
            !["classic", "module"].includes(options.type) ||
            !["imports", "all", "none"].includes(options.updateViaCache)
          ) {
            throw new TypeError("Invalid service worker registration option");
          }
          const scriptURL = new _URL(raw, client.meta.base.href);
          scriptURL.hash = "";
          if (!["http:", "https:"].includes(scriptURL.protocol))
            throw registerError("Unsupported script URL scheme.");
          if (scriptURL.origin !== client.url.origin) {
            throw securityError(
              `The origin of the provided scriptURL ('${scriptURL.origin}') does not match the current origin ('${client.url.origin}').`,
            );
          }
          if (ESCAPED_SLASH.test(scriptURL.pathname)) {
            throw registerError(
              `The provided scriptURL ('${scriptURL.href}') includes a disallowed escape.`,
            );
          }

          const defaultScope = new _URL("./", scriptURL);
          const scope =
            options.scope !== undefined
              ? new _URL(options.scope, client.meta.base.href)
              : defaultScope;
          scope.hash = "";
          if (!["http:", "https:"].includes(scope.protocol))
            throw registerError("Unsupported scope URL scheme.");
          if (scope.origin !== client.url.origin) {
            throw securityError(
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
            credentials: "same-origin",
            redirect: "error",
            cache: options.updateViaCache === "none" ? "no-store" : "default",
          });
          if (!response.ok) {
            throw registerError(
              `The script resource returned HTTP status ${response.status}.`,
            );
          }

          if (
            !isJavascriptMimeType(response.headers.get("Content-Type") ?? "")
          ) {
            throw securityError("The script has an unsupported MIME type.");
          }

          const allowedHeader = response.headers.get("Service-Worker-Allowed");
          const maxScope = allowedHeader
            ? new _URL(allowedHeader, scriptURL)
            : defaultScope;
          if (
            maxScope.origin !== scriptURL.origin ||
            !String_startsWith(scope.pathname, maxScope.pathname)
          ) {
            throw securityError(
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
          waitForActive(registration).then(resolveReady, () => {});
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
      ctx.return(
        (async () => {
          const target = new _URL(
            ctx.args[0] === undefined ? client.url.href : String(ctx.args[0]),
            client.meta.base.href,
          );
          if (target.origin !== client.url.origin) {
            throw new DOMException(
              "The documentURL origin does not match the current origin.",
              "SecurityError",
            );
          }
          const nativeTarget =
            client.context.prefix.href +
            client.context.interface.codecEncode(target.href);
          const registration = await nativeGetRegistration.call(
            container,
            nativeTarget,
          );
          return registration && virtualScopeOf(registration)
            ? registration
            : undefined;
        })(),
      );
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

  // Match this document; an active registration elsewhere must not resolve ready.
  const nativeTarget =
    client.context.prefix.href +
    client.context.interface.codecEncode(client.url.href);
  nativeGetRegistration
    .call(container, nativeTarget)
    .then((registration) => {
      if (registration && virtualScopeOf(registration)) {
        return waitForActive(registration).then(resolveReady, () => {});
      }
    })
    .catch(() => {});
}
