// turns the SharedWorker this realm actually is into something that presents as
// a ServiceWorkerGlobalScope. the site's script runs here after we're done, so
// everything it can reach has to be in place before we return

import { ScramjetClient } from "@client/index";
import { swrealmscope } from "@client/entry";
import { MessagePortLike, RealmChannel } from "@/shared/realmchannel";
import {
  HostBound,
  RealmBound,
  ServiceWorkerClientSnapshot,
  ServiceWorkerFetchRequestInit,
  ServiceWorkerFetchResult,
} from "@/shared";
import { REWRITTEN_HEADER } from "@/fetch/util";
import { AnyFunction } from "@/types";
import {
  Array_isArray,
  Object_defineProperty,
  Object_getPrototypeOf,
  Promise_all,
  Reflect_deleteProperty,
  String,
  _Map,
  _URL,
  _WeakMap,
} from "@/shared/snapshot";

const SCOPE_EVENTS = [
  "install",
  "activate",
  "fetch",
  "message",
  "messageerror",
  "push",
  "pushsubscriptionchange",
  "sync",
  "periodicsync",
  "notificationclick",
  "notificationclose",
  "canmakepayment",
  "paymentrequest",
  "backgroundfetchsuccess",
  "backgroundfetchfail",
  "backgroundfetchabort",
  "backgroundfetchclick",
  "contentdelete",
];

export default function (client: ScramjetClient, self: Self) {
  const scope = swrealmscope!;
  const scriptURL = client.url.href;
  const closeRealm = Reflect.get(self, "close");

  // a SharedWorker realm is reached over a connect port, a dedicated one over
  // the global itself. check before the scope stops looking like either
  const isShared = "SharedWorkerGlobalScope" in self;

  // scramjet proxies postMessage everywhere to wrap payloads in an envelope,
  // which would mangle protocol frames, so the channel talks over the natives
  function nativePort(target: MessagePort | Self): MessagePortLike {
    const isGlobal = (target as Self) === self;

    return {
      postMessage: (data, transfer) => {
        // the transferable-list overload, not the options one the Window
        // typings resolve to first
        const list = transfer as unknown as StructuredSerializeOptions;
        if (isGlobal) {
          client.natives.call("self.postMessage", self, data, list);
        } else {
          client.natives.call(
            "MessagePort.prototype.postMessage",
            target as MessagePort,
            data,
            list,
          );
        }
      },
      addEventListener: (type, listener) => {
        client.natives.call(
          "EventTarget.prototype.addEventListener",
          target,
          type,
          listener as EventListener,
        );
      },
      start: () => {
        if (!isGlobal) {
          client.natives.call(
            "MessagePort.prototype.start",
            target as MessagePort,
          );
        }
      },
    };
  }

  // a real service worker never sees a raw message event, only the
  // ExtendableMessageEvents we synthesize, so keep protocol frames away from
  // site listeners entirely
  client.init.shouldBlockMessageEvent = () => true;

  let channel: RealmChannel<RealmBound, HostBound> | null = null;
  const queued: (() => undefined)[] = [];

  function attach(port: MessagePortLike) {
    // later tabs connect to the same realm; the first port owns lifecycle and
    // the rest only need to be able to reach us
    if (channel) return;
    channel = new RealmChannel<RealmBound, HostBound>(port, handlers, "realm");
    for (const fn of queued) fn();
    queued.length = 0;
    channel.call("ready", {}).catch((error) => {
      console.error(
        "service worker realm ready acknowledgement failed:",
        error,
      );
    });
  }

  function host<M extends keyof HostBound & string>(
    method: M,
    args: HostBound[M] extends [infer A, ...any[]] ? A : undefined,
    transfer: Transferable[] = [],
  ): Promise<HostBound[M] extends [any, infer R] ? R : undefined> {
    if (channel) return channel.call(method, args, transfer);

    return new self.Promise((resolve, reject) => {
      queued.push(() => {
        channel!.call(method, args, transfer).then(resolve, reject);
      });
    });
  }

  // waitUntil / respondWith state, kept off the event objects so site code
  // can't see it
  const extended = new _WeakMap([]) as WeakMap<object, Promise<unknown>[]>;
  const responded = new _WeakMap([]) as WeakMap<
    object,
    Promise<Response> | null
  >;

  class ExtendableEvent extends self.Event {
    waitUntil(promise: Promise<unknown>) {
      const list = extended.get(this);
      if (!list) {
        throw new self.DOMException(
          "waitUntil called outside of event dispatch",
          "InvalidStateError",
        );
      }
      list.push(self.Promise.resolve(promise));
    }
  }

  class FetchEvent extends ExtendableEvent {
    request: Request;
    clientId: string;
    resultingClientId: string;
    replacesClientId = "";
    preloadResponse: Promise<undefined>;
    handled: Promise<undefined>;

    constructor(type: string, init: any) {
      super(type, init);
      this.request = init.request;
      this.clientId = init.clientId;
      this.resultingClientId = init.resultingClientId;
      this.preloadResponse = self.Promise.resolve(undefined);
      this.handled = init.handled;
    }

    respondWith(response: Response | Promise<Response>) {
      if (responded.get(this) !== null) {
        throw new self.DOMException(
          "respondWith has already been called",
          "InvalidStateError",
        );
      }
      responded.set(this, self.Promise.resolve(response));
    }
  }

  class ExtendableMessageEvent extends ExtendableEvent {
    data: unknown;
    origin: string;
    lastEventId = "";
    source: any;
    ports: readonly MessagePort[];

    constructor(type: string, init: any) {
      super(type, init);
      this.data = init.data;
      this.origin = init.origin ?? "";
      this.source = init.source ?? null;
      this.ports = init.ports ?? [];
    }
  }

  class PushMessageData {
    constructor(private raw: string) {}
    arrayBuffer() {
      return new self.TextEncoder().encode(this.raw).buffer;
    }
    blob() {
      return new self.Blob([this.raw]);
    }
    json() {
      return self.JSON.parse(this.raw);
    }
    text() {
      return this.raw;
    }
  }

  class PushEvent extends ExtendableEvent {
    data: PushMessageData | null;
    constructor(type: string, init: any) {
      super(type, init);
      this.data =
        init.data === null || init.data === undefined
          ? null
          : new PushMessageData(String(init.data));
    }
  }

  class SyncEvent extends ExtendableEvent {
    tag: string;
    lastChance: boolean;
    constructor(type: string, init: any) {
      super(type, init);
      this.tag = init.tag;
      this.lastChance = !!init.lastChance;
    }
  }

  class PeriodicSyncEvent extends ExtendableEvent {
    tag: string;
    constructor(type: string, init: any) {
      super(type, init);
      this.tag = init.tag;
    }
  }

  class PaymentRequestEvent extends ExtendableEvent {
    topOrigin: string;
    paymentRequestOrigin: string;
    paymentRequestId: string;
    methodData: unknown[];
    total: unknown;
    modifiers: unknown[];
    instrumentKey: string;
    constructor(type: string, init: any) {
      super(type, init);
      this.topOrigin = init.topOrigin;
      this.paymentRequestOrigin = init.paymentRequestOrigin;
      this.paymentRequestId = init.paymentRequestId;
      this.methodData = init.methodData ?? [];
      this.total = init.total ?? null;
      this.modifiers = init.modifiers ?? [];
      this.instrumentKey = init.instrumentKey ?? "";
    }

    async openWindow(url: string) {
      const snapshot = await host("openWindow", {
        url: new _URL(String(url), scope).href,
      });

      return snapshot ? wrapClient(snapshot) : null;
    }

    respondWith(response: unknown) {
      if (responded.get(this) !== null) {
        throw new self.DOMException(
          "respondWith has already been called",
          "InvalidStateError",
        );
      }
      responded.set(this, self.Promise.resolve(response) as any);
    }
  }

  class CanMakePaymentEvent extends ExtendableEvent {
    respondWith(response: unknown) {
      if (responded.get(this) !== null) {
        throw new self.DOMException(
          "respondWith has already been called",
          "InvalidStateError",
        );
      }
      responded.set(this, self.Promise.resolve(response) as any);
    }
  }

  class NotificationEvent extends ExtendableEvent {
    notification: unknown;
    action: string;
    constructor(type: string, init: any) {
      super(type, init);
      this.notification = init.notification;
      this.action = init.action ?? "";
    }
  }

  class Client {
    constructor(private snapshot: ServiceWorkerClientSnapshot) {}
    get id() {
      return this.snapshot.id;
    }
    get url() {
      return this.snapshot.url;
    }
    get type() {
      return this.snapshot.type;
    }
    get frameType() {
      return this.snapshot.frameType;
    }
    postMessage(data: unknown, transfer?: Transferable[] | any) {
      const ports = Array_isArray(transfer)
        ? transfer
        : (transfer?.transfer ?? []);
      host(
        "postMessageToClient",
        { id: this.snapshot.id, data, ports },
        ports,
      ).catch(() => {
        self.dispatchEvent(new Event("messageerror"));
      });
    }
  }

  class WindowClient extends Client {
    constructor(private windowSnapshot: ServiceWorkerClientSnapshot) {
      super(windowSnapshot);
    }
    get visibilityState() {
      return this.windowSnapshot.visibilityState;
    }
    get focused() {
      return this.windowSnapshot.focused;
    }
    get ancestorOrigins() {
      return [];
    }
    async focus() {
      const snapshot = await host("focusClient", { id: this.id });

      return snapshot ? wrapClient(snapshot) : null;
    }
    async navigate(url: string) {
      const snapshot = await host("navigateClient", {
        id: this.id,
        url: new _URL(String(url), scope).href,
      });

      return snapshot ? wrapClient(snapshot) : null;
    }
  }

  function wrapClient(snapshot: ServiceWorkerClientSnapshot) {
    return snapshot.type === "window"
      ? new WindowClient(snapshot)
      : new Client(snapshot);
  }

  class Clients {
    async get(id: string) {
      const snapshot = await host("getClient", { id: String(id) });

      return snapshot ? wrapClient(snapshot) : undefined;
    }
    async matchAll(options: any = {}) {
      const provider = registrationProvider();
      if (provider) {
        return provider.matchAll({
          type: options.type,
          includeUncontrolled: options.includeUncontrolled,
        });
      }
      const snapshots = await host("matchAll", {
        type: options.type ?? "window",
        includeUncontrolled: !!options.includeUncontrolled,
      });

      return snapshots.map(wrapClient);
    }
    async openWindow(url: string) {
      const snapshot = await host("openWindow", {
        url: new _URL(String(url), scope).href,
      });

      return snapshot ? wrapClient(snapshot) : null;
    }
    async claim() {
      const provider = registrationProvider();
      if (provider) {
        await provider.claim();
        return;
      }
      await host("claim", {});
    }
  }

  class NavigationPreloadManager {
    async enable() {}
    async disable() {}
    async setHeaderValue() {}
    async getState() {
      return { enabled: false, headerValue: "" };
    }
  }

  // an embedder that owns the registration (connected over `connectEmbedder`)
  // installs a provider under this symbol; when present every registration and
  // worker fact is read from it and every request is routed to it. Without it
  // the site path below is unchanged.
  interface RegistrationProvider {
    readonly updateViaCache: string;
    readonly installing: object | null;
    readonly waiting: object | null;
    readonly active: object | null;
    readonly serviceWorker: { readonly scriptURL: string; readonly state: string };
    update(): Promise<unknown>;
    unregister(): Promise<boolean>;
    skipWaiting(): Promise<undefined>;
    claim(): Promise<undefined>;
    matchAll(options: {
      readonly type: unknown;
      readonly includeUncontrolled: unknown;
    }): Promise<readonly object[]>;
  }
  function registrationProvider(): RegistrationProvider | null {
    const key = self.Symbol.for("scramjet.serviceWorker.registrationProvider");
    const provider = Reflect.get(self, key);
    return typeof provider === "object" && provider !== null
      ? (provider as RegistrationProvider)
      : null;
  }

  class ServiceWorker extends self.EventTarget {
    get scriptURL() {
      const provider = registrationProvider();
      return provider ? provider.serviceWorker.scriptURL : scriptURL;
    }
    get state() {
      const provider = registrationProvider();
      return provider ? provider.serviceWorker.state : "activated";
    }
    onstatechange: AnyFunction | null = null;
    onerror: AnyFunction | null = null;
    postMessage() {
      // a worker can't message itself
    }
  }

  class ServiceWorkerRegistration extends self.EventTarget {
    scope = scope;
    onupdatefound: AnyFunction | null = null;
    navigationPreload = new NavigationPreloadManager();

    get updateViaCache() {
      const provider = registrationProvider();
      return provider ? provider.updateViaCache : "imports";
    }

    get installing() {
      const provider = registrationProvider();
      return provider ? provider.installing : null;
    }

    get waiting() {
      const provider = registrationProvider();
      return provider ? provider.waiting : null;
    }

    get active() {
      const provider = registrationProvider();
      return provider ? provider.active : serviceWorker;
    }

    async update() {
      const provider = registrationProvider();
      if (provider) {
        await provider.update();
        return;
      }
      await host("update", {});
    }

    async unregister() {
      const provider = registrationProvider();
      if (provider) return await provider.unregister();
      return await host("unregister", {});
    }

    async showNotification(title: string, options: unknown) {
      await host("showNotification", { title: String(title), options });
    }

    async getNotifications(filter: any = {}) {
      return await host("getNotifications", { tag: filter.tag });
    }
  }

  const serviceWorker = new ServiceWorker();
  const registration = new ServiceWorkerRegistration();
  const clients = new Clients();

  // dispatch and wait out every waitUntil the handlers registered
  async function dispatch(event: Event): Promise<undefined> {
    const promises: Promise<unknown>[] = [];
    extended.set(event, promises);
    self.dispatchEvent(event);
    extended.delete(event);

    if (promises.length) await Promise_all(promises);
    return undefined;
  }

  // an embedder that connected over `connectEmbedder` drives install/activate
  // itself (its own lifecycle owner decides ordering); this reach-in exposes the
  // same dispatch the realm channel handlers use so both paths execute one
  // scope-owned dispatch with waitUntil accounting
  const lifecycle = {
    install: async () => {
      try {
        await dispatch(new ExtendableEvent("install", {}));

        return { ok: true };
      } catch (err) {
        return { ok: false, error: String((err as Error)?.message ?? err) };
      }
    },
    activate: async () => {
      try {
        await dispatch(new ExtendableEvent("activate", {}));

        return { ok: true };
      } catch (err) {
        return { ok: false, error: String((err as Error)?.message ?? err) };
      }
    },
  };
  Object_defineProperty(self, self.Symbol.for("scramjet.serviceWorker.lifecycle"), {
    value: lifecycle,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const handlers = {
    connectEmbedder: async (args: { data: unknown }, ports: MessagePort[]) => {
      if (ports.length !== 1) {
        throw new Error("service worker embedder connection requires one port");
      }
      const key = self.Symbol.for("scramjet.serviceWorker.embedderConnect");
      const connect = Reflect.get(self, key);
      if (typeof connect !== "function") {
        throw new Error(
          "service worker embedder connection handler is unavailable",
        );
      }
      await Reflect.apply(connect, self, [args.data, ports[0]]);
    },
    install: lifecycle.install,
    activate: lifecycle.activate,
    fetch: async (
      init: ServiceWorkerFetchRequestInit,
    ): Promise<
      ServiceWorkerFetchResult | [ServiceWorkerFetchResult, any[]]
    > => {
      // build the Request against the rewritten url so that handing it straight
      // to fetch() works, while Request.prototype.url still reports the site
      // url. the native constructor is required here - the proxied one would
      // rewrite a second time
      const request = client.natives.construct(
        "Request",
        client.rewriteUrl(init.url, {
          destination: init.destination,
          mode: init.mode,
          credentials: init.credentials,
        }),
        {
          method: init.method,
          headers: init.headers,
          // the Request constructor rejects a body on GET/HEAD
          body:
            init.method === "GET" || init.method === "HEAD"
              ? undefined
              : (init.body ?? undefined),
          mode: init.mode === "navigate" ? undefined : init.mode,
          credentials: init.credentials,
          cache: init.cache,
          redirect: init.redirect,
          referrerPolicy: init.referrerPolicy as ReferrerPolicy,
          integrity: init.integrity,
        },
      );

      const event = new FetchEvent("fetch", {
        request,
        clientId: init.clientId,
        resultingClientId: init.resultingClientId,
        handled: self.Promise.resolve(),
      });
      responded.set(event, null);

      await dispatch(event);

      const pending = responded.get(event);
      responded.delete(event);
      if (!pending) return { handled: false };

      try {
        const response = await pending;
        // read the native headers, not the trapped ones, so the marker the
        // rewriter left is still visible
        const native: Headers = client.descriptors.get(
          "Response.prototype.headers",
          response,
        );
        const headers: [string, string][] = [];
        let rewritten = false;
        for (const [key, value] of native.entries()) {
          if (key.toLowerCase() === REWRITTEN_HEADER) {
            rewritten = true;
            continue;
          }
          headers.push([key, value]);
        }

        const body = response.body;

        return [
          {
            handled: true,
            response: {
              body,
              status: response.status,
              statusText: response.statusText,
              headers,
              rewritten,
              redirected: response.redirected,
              type: response.type,
              url: response.url,
            },
          },
          body ? [body] : [],
        ];
      } catch (err) {
        return {
          handled: true,
          error: String((err as Error)?.message ?? err),
        };
      }
    },
    message: async (args: any, ports: MessagePort[]) => {
      await dispatch(
        new ExtendableMessageEvent("message", {
          data: args.data,
          origin: args.origin,
          source: args.source ? wrapClient(args.source) : null,
          ports: args.ports?.length ? args.ports : ports,
        }),
      );
    },
    push: async (args: any) => {
      await dispatch(new PushEvent("push", { data: args.data }));
    },
    pushsubscriptionchange: async () => {
      await dispatch(new ExtendableEvent("pushsubscriptionchange", {}));
    },
    sync: async (args: any) => {
      await dispatch(
        new SyncEvent("sync", { tag: args.tag, lastChance: args.lastChance }),
      );
    },
    periodicsync: async (args: any) => {
      await dispatch(new PeriodicSyncEvent("periodicsync", { tag: args.tag }));
    },
    notificationclick: async (args: any) => {
      await dispatch(
        new NotificationEvent("notificationclick", {
          notification: args.notification,
          action: args.action,
        }),
      );
    },
    notificationclose: async (args: any) => {
      await dispatch(
        new NotificationEvent("notificationclose", {
          notification: args.notification,
        }),
      );
    },
    canmakepayment: async () => {
      const event = new CanMakePaymentEvent("canmakepayment", {});
      responded.set(event, null);
      await dispatch(event);
      const pending = responded.get(event);
      responded.delete(event);
      if (!pending) return false;

      return !!(await pending);
    },
    paymentrequest: async (args: any) => {
      const event = new PaymentRequestEvent("paymentrequest", args);
      responded.set(event, null);
      await dispatch(event);
      const pending = responded.get(event);
      responded.delete(event);
      if (!pending) return { handled: false };

      try {
        return { handled: true, response: await pending };
      } catch (err) {
        return {
          handled: true,
          error: String((err as Error)?.message ?? err),
        };
      }
    },
    terminate: async () => {
      if (typeof closeRealm !== "function") {
        throw new Error("service worker realm close operation is unavailable");
      }
      Reflect.apply(closeRealm, self, []);
    },
  } as any;

  // handlers exist now, so the host can be let in
  if (isShared) {
    client.natives.call(
      "EventTarget.prototype.addEventListener",
      self,
      "connect",
      ((event: MessageEvent) => {
        const port = event.ports[0];
        if (port) attach(nativePort(port));
      }) as EventListener,
    );
  } else {
    attach(nativePort(self));
  }

  // present the scope. reuse the real global's own constructor under the name a
  // service worker would have, rather than faking a second class the global
  // isn't an instance of
  const globalCtor = Object_getPrototypeOf(self)?.constructor;
  if (globalCtor) {
    Object_defineProperty(globalCtor, "name", {
      value: "ServiceWorkerGlobalScope",
      configurable: true,
    });
    Object_defineProperty(globalCtor.prototype, self.Symbol.toStringTag, {
      value: "ServiceWorkerGlobalScope",
      configurable: true,
    });
    Object_defineProperty(self, "ServiceWorkerGlobalScope", {
      value: globalCtor,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    Reflect_deleteProperty(self, "SharedWorkerGlobalScope");
    Reflect_deleteProperty(self, "DedicatedWorkerGlobalScope");
    Reflect_deleteProperty(globalCtor.prototype, "onconnect");
    Reflect_deleteProperty(globalCtor.prototype, "close");
  }

  const scopeProps: Record<string, unknown> = {
    registration,
    serviceWorker,
    clients,
    ExtendableEvent,
    FetchEvent,
    ExtendableMessageEvent,
    PushEvent,
    PushMessageData,
    SyncEvent,
    PeriodicSyncEvent,
    NotificationEvent,
    PaymentRequestEvent,
    CanMakePaymentEvent,
    Client,
    WindowClient,
    Clients,
    ServiceWorkerRegistration,
    NavigationPreloadManager,
  };

  for (const name in scopeProps) {
    Object_defineProperty(self, name, {
      value: scopeProps[name],
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }

  for (const ctor of [
    ExtendableEvent,
    FetchEvent,
    ExtendableMessageEvent,
    PushEvent,
    SyncEvent,
    PeriodicSyncEvent,
    NotificationEvent,
    PaymentRequestEvent,
    CanMakePaymentEvent,
  ]) {
    Object_defineProperty(ctor.prototype, self.Symbol.toStringTag, {
      value: ctor.name,
      configurable: true,
    });
  }

  Object_defineProperty(self, "skipWaiting", {
    value: async function skipWaiting() {
      const provider = registrationProvider();
      if (provider) {
        await provider.skipWaiting();
        return;
      }
      await host("skipWaiting", {});
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });

  // onfetch, oninstall and friends, which don't exist on a SharedWorker scope
  const inlineHandlers = new _Map<string, AnyFunction>();
  for (const event of SCOPE_EVENTS) {
    const prop = `on${event}`;
    Object_defineProperty(self, prop, {
      get() {
        return inlineHandlers.get(prop) ?? null;
      },
      set(value: any) {
        const existing = inlineHandlers.get(prop);
        if (existing) self.removeEventListener(event, existing as any);
        if (typeof value === "function") {
          inlineHandlers.set(prop, value);
          self.addEventListener(event, value);
        } else {
          inlineHandlers.delete(prop);
        }
      },
      configurable: true,
      enumerable: true,
    });
  }
}
