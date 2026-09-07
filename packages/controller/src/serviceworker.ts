import {
  RealmChannel,
  rewriteUrl,
  type HostBound,
  type RealmBound,
  type SerializedNotification,
  type ServiceWorkerClientSnapshot,
  type ServiceWorkerFetchRequestInit,
  type ServiceWorkerFetchResult,
  type ServiceWorkerHostEvent,
  type ServiceWorkerPaymentRequest,
  type ServiceWorkerRegisterOptions,
  type ServiceWorkerRegistrationSnapshot,
  type ServiceWorkerState,
  type ServiceWorkerUpdateViaCache,
} from "@mercuryworkshop/scramjet";
import type { Frame } from ".";

// embedder-launched registrations (`launchEmbedder`): the registry boots the
// realm and hands the embedder its port over `connectEmbedder`, then stops.
// It does not run or record install/activate for that registration; the
// embedder drives those through the realm's own lifecycle dispatch and owns
// the resulting state. The site-scope path below `boot` is unchanged.

// a live browsing context the registry can run a realm's client operations in.
// there is one per proxied document, established when its container starts
export type PageChannel = {
  clientUrl: string;
  openWindow(url: string): Promise<string | null>;
  focus(): Promise<undefined>;
  navigate(url: string): Promise<string | null>;
  showNotification(title: string, options: unknown): Promise<undefined>;
};

function makeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

type PersistedRegistration = {
  storagePartitionKey: string;
  id: string;
  origin: string;
  scope: string;
  scriptURL: string;
  type: "classic" | "module";
  updateViaCache: ServiceWorkerUpdateViaCache;
  // a real registration stays activated with no tabs open, so this has to
  // survive the realm it was established in
  activated: boolean;
};

// an embedder registration's controllee owner: it decides whether a request
// from a client in the registration's scope is dispatched to the realm's fetch
// handler. The registry transports the decision; it never asserts activation,
// fetch-handler presence, or client control for an embedder registration
export type ServiceWorkerEmbedderControlleeRequest = {
  url: string;
  clientUrl: string;
  clientOrigin: string;
  clientId: string;
  resultingClientId: string;
  destination: string;
};

export type ServiceWorkerEmbedderControlleeDecision =
  | { dispatch: "worker" }
  | { dispatch: "fallback"; reason: string }
  | { dispatch: "reject"; reason: string };

export type ServiceWorkerEmbedderControllee = {
  match(
    request: ServiceWorkerEmbedderControlleeRequest,
  ): Promise<ServiceWorkerEmbedderControlleeDecision>;
};

export type ServiceWorkerEmbedderLaunchOptions = {
  id: string;
  scope: string;
  scriptURL: string;
  realmScriptURL: string;
  type: "classic" | "module";
  data: unknown;
  port: MessagePort;
  controllee: ServiceWorkerEmbedderControllee;
  // "dedicated" gives the embedder one terminable Worker per launch; the
  // site path keeps the SharedWorker realm that every tab can reach
  realmWorkerKind?: "shared" | "dedicated";
  // script type of the embedder's realm entry (the script the realm boots
  // from), distinct from `type`, which records the registration's own script
  realmType?: "classic" | "module";
};

export type ServiceWorkerEmbedderLaunchHandle = {
  ready: Promise<undefined>;
  terminate(): Promise<boolean>;
  onStopped(listener: (reason: string) => unknown): () => boolean;
};

const SW_DB_NAME = "__scramjet_serviceworkers";
const SW_DB_VERSION = 2;
const SW_STORE_NAME = "registrations";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SW_DB_NAME, SW_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(SW_STORE_NAME)) {
        db.deleteObjectStore(SW_STORE_NAME);
      }
      db.createObjectStore(SW_STORE_NAME, {
        keyPath: ["storagePartitionKey", "id"],
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("failed to open service worker db"));
  });

  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("indexeddb request failed"));
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<undefined> {
  return new Promise<undefined>((resolve, reject) => {
    transaction.oncomplete = () => resolve(undefined);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("indexeddb transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("indexeddb transaction failed"));
  });
}

function readPersistedRegistration(
  value: unknown,
  expectedStoragePartitionKey: string,
): PersistedRegistration {
  if (typeof value !== "object" || value === null) {
    throw new Error("persisted service worker registration was malformed");
  }
  const storagePartitionKey = Reflect.get(value, "storagePartitionKey");
  const id = Reflect.get(value, "id");
  const origin = Reflect.get(value, "origin");
  const scope = Reflect.get(value, "scope");
  const scriptURL = Reflect.get(value, "scriptURL");
  const type = Reflect.get(value, "type");
  const updateViaCache = Reflect.get(value, "updateViaCache");
  const activated = Reflect.get(value, "activated");
  if (
    typeof storagePartitionKey !== "string" ||
    storagePartitionKey !== expectedStoragePartitionKey ||
    typeof id !== "string" ||
    id.length === 0 ||
    typeof origin !== "string" ||
    origin.length === 0 ||
    typeof scope !== "string" ||
    scope.length === 0 ||
    typeof scriptURL !== "string" ||
    scriptURL.length === 0 ||
    (type !== "classic" && type !== "module") ||
    (updateViaCache !== "all" &&
      updateViaCache !== "imports" &&
      updateViaCache !== "none") ||
    typeof activated !== "boolean"
  ) {
    throw new Error(
      "persisted service worker registration fields were malformed",
    );
  }
  return {
    activated,
    id,
    origin,
    scope,
    scriptURL,
    storagePartitionKey,
    type,
    updateViaCache,
  };
}

async function readPersisted(
  storagePartitionKey: string,
): Promise<PersistedRegistration[]> {
  const db = await openDatabase();
  const transaction = db.transaction(SW_STORE_NAME, "readonly");
  const completion = transactionToPromise(transaction);
  const records = await requestToPromise(
    transaction
      .objectStore(SW_STORE_NAME)
      .getAll(
        IDBKeyRange.bound(
          [storagePartitionKey, ""],
          [storagePartitionKey, "\uffff"],
        ),
      ),
  );
  await completion;
  return records.map((record) =>
    readPersistedRegistration(record, storagePartitionKey),
  );
}

async function writePersisted(
  record: PersistedRegistration,
): Promise<undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(SW_STORE_NAME, "readwrite");
  const completion = transactionToPromise(transaction);
  await requestToPromise(transaction.objectStore(SW_STORE_NAME).put(record));
  await completion;
  return undefined;
}

async function deletePersisted(
  storagePartitionKey: string,
  id: string,
): Promise<undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(SW_STORE_NAME, "readwrite");
  const completion = transactionToPromise(transaction);
  await requestToPromise(
    transaction.objectStore(SW_STORE_NAME).delete([storagePartitionKey, id]),
  );
  await completion;
  return undefined;
}

// one emulated registration and the realm running its script
class EmulatedRegistration {
  id: string;
  scope: string;
  scriptURL: string;
  type: "classic" | "module";
  updateViaCache: ServiceWorkerUpdateViaCache;
  origin: string;

  workerId = makeId();
  state: ServiceWorkerState = "parsed";
  activated = false;
  embedderControllee: ServiceWorkerEmbedderControllee | null = null;
  // clients that have been claimed or navigated since activation
  controlled = new Set<string>();

  private worker: SharedWorker | Worker | null = null;
  private channel: RealmChannel<HostBound, RealmBound> | null = null;
  private booting: Promise<unknown> | null = null;
  private stopped = false;
  private readonly stoppedListeners = new Set<(reason: string) => unknown>();

  constructor(
    private registry: ServiceWorkerRegistry,
    record: PersistedRegistration,
    private readonly realmScriptURL = record.scriptURL,
    private readonly realmType: "classic" | "module" = record.type,
    private readonly persistent = true,
    private embedderConnection: {
      data: unknown;
      port: MessagePort;
    } | null = null,
    private readonly realmWorkerKind: "shared" | "dedicated" = "shared",
  ) {
    this.id = record.id;
    this.scope = record.scope;
    this.scriptURL = record.scriptURL;
    this.type = record.type;
    this.updateViaCache = record.updateViaCache;
    this.origin = record.origin;
    this.activated = record.activated;
    if (record.activated) this.state = "activated";
  }

  persist(): PersistedRegistration {
    return {
      id: this.id,
      origin: this.origin,
      scope: this.scope,
      scriptURL: this.scriptURL,
      storagePartitionKey: this.registry.storagePartitionKey,
      type: this.type,
      updateViaCache: this.updateViaCache,
      activated: this.activated,
    };
  }

  snapshot(clientUrl?: string): ServiceWorkerRegistrationSnapshot {
    const worker = {
      id: this.workerId,
      scriptURL: this.scriptURL,
      state: this.state,
    };

    return {
      id: this.id,
      scope: this.scope,
      updateViaCache: this.updateViaCache,
      installing:
        this.state === "installing" || this.state === "parsed" ? worker : null,
      waiting: this.state === "installed" ? worker : null,
      active:
        this.state === "activating" || this.state === "activated"
          ? worker
          : null,
      controlling: clientUrl ? this.controls(clientUrl) : false,
    };
  }

  controls(clientUrl: string): boolean {
    return this.activated && clientUrl.startsWith(this.scope);
  }

  // an embedder registration can only control a client of its scope origin;
  // whether that client is controlled is the embedder's decision
  embedderControls(clientUrl: string | undefined): boolean {
    if (clientUrl === undefined) return false;
    const client = URL.canParse(clientUrl) ? new URL(clientUrl) : null;
    return (
      client !== null &&
      client.origin === new URL(this.scope).origin &&
      clientUrl.startsWith(this.scope)
    );
  }

  private realmUrl(): string {
    return rewriteUrl(
      this.realmScriptURL,
      this.registry.frame.context,
      {
        //@ts-expect-error
        origin: new URL(this.scriptURL),
        //@ts-expect-error
        base: new URL(this.scriptURL),
      },
      {
        destination: "serviceworker",
        isModule: this.realmType === "module",
        swScope: this.scope,
      },
    );
  }

  // spawn the realm and take it through install/activate. safe to call more
  // than once; only the first does the work
  boot(): Promise<unknown> {
    if (this.booting) return this.booting;

    this.booting = (async () => {
      const url = this.realmUrl();
      let port: MessagePort | Worker;

      let readyResolve!: (value: undefined) => unknown;
      let readyReject!: (reason: unknown) => unknown;
      const ready = new Promise<undefined>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });

      const onLoadError = () => {
        readyReject(
          new Error(`failed to load service worker realm from ${url}`),
        );
      };

      if (
        this.realmWorkerKind !== "dedicated" &&
        typeof SharedWorker !== "undefined"
      ) {
        // a SharedWorker gives every tab a handle on the same realm, which
        // is what a real registration behaves like
        const shared = new SharedWorker(url, {
          name: `sj-sw-${this.id}`,
          type: this.realmType,
        });
        this.worker = shared;
        shared.onerror = onLoadError;
        port = shared.port;
      } else {
        const dedicated = new Worker(url, {
          name: `sj-sw-${this.id}`,
          type: this.realmType,
        });
        this.worker = dedicated;
        dedicated.onerror = onLoadError;
        port = dedicated;
      }

      this.channel = new RealmChannel<HostBound, RealmBound>(
        port as MessagePort,
        {
          ready: async () => {
            readyResolve(undefined);
          },
          skipWaiting: async () => {
            if (this.state === "installed") await this.activate();
          },
          claim: async () => {
            for (const client of this.registry.knownClients(this.scope)) {
              this.controlled.add(client);
            }
            this.activated = true;
            this.registry.announceController(this);
          },
          matchAll: async ({ includeUncontrolled }) => {
            return this.registry.clientSnapshots(
              this.scope,
              includeUncontrolled ? null : this.controlled,
            );
          },
          getClient: async ({ id }) => {
            return (
              this.registry
                .clientSnapshots(this.scope, null)
                .find((c) => c.id === id) ?? null
            );
          },
          openWindow: async ({ url }) => {
            return await this.registry.openWindow(this, url);
          },
          focusClient: async ({ id }) => {
            return await this.registry.focusClient(this, id);
          },
          navigateClient: async ({ id, url }) => {
            return await this.registry.navigateClient(this, id, url);
          },
          postMessageToClient: async ({ id, data, ports }) => {
            this.registry.deliverToClient(this, id, data, ports);
          },
          unregister: async () => {
            return await this.registry.unregister(this.id);
          },
          update: async () => {
            await this.registry.update(this.id);
          },
          showNotification: async ({ title, options }) => {
            await this.registry.showNotification(this, title, options);
          },
          getNotifications: async ({ tag }) => {
            return await this.registry.getNotifications(this, tag);
          },
        },
        `host-${this.id}`,
      );

      await ready;
      const embedderConnection = this.embedderConnection;
      if (embedderConnection !== null) {
        this.embedderConnection = null;
        await this.channel.call(
          "connectEmbedder",
          { data: embedderConnection.data },
          [embedderConnection.port],
        );
        // the embedder owns this registration's lifecycle: the realm only
        // executes the install/activate/terminate commands it receives, and
        // the registry never asserts a state the embedder has not reached
        this.registry.announce(this);
        return;
      }

      if (this.activated) {
        // revived from a previous session, so the script is already past its
        // lifecycle and only needs to be running
        this.state = "activated";
        this.registry.announce(this);

        return;
      }

      this.state = "installing";
      this.registry.announce(this);

      const installed = await this.channel.call("install", {});
      if (!installed.ok) {
        this.state = "redundant";
        this.registry.announce(this);
        throw new Error(`service worker install failed: ${installed.error}`);
      }

      this.state = "installed";
      this.registry.announce(this);

      await this.activate();
    })();

    return this.booting;
  }

  private async activate() {
    if (!this.channel) {
      throw new Error("service worker activation has no realm channel");
    }

    this.state = "activating";
    this.registry.announce(this);

    const activated = await this.channel.call("activate", {});
    if (!activated.ok) {
      this.state = "redundant";
      this.registry.announce(this);
      throw new Error(`service worker activation failed: ${activated.error}`);
    }

    this.state = "activated";
    this.activated = true;
    if (this.persistent) {
      await writePersisted(this.persist());
    }
    this.registry.announce(this);
  }

  onStopped(listener: (reason: string) => unknown): () => boolean {
    if (this.stopped) {
      listener("service worker realm already stopped");
      return () => false;
    }
    this.stoppedListeners.add(listener);
    return () => this.stoppedListeners.delete(listener);
  }

  async dispatchFetch(
    init: ServiceWorkerFetchRequestInit,
  ): Promise<ServiceWorkerFetchResult> {
    await this.boot();
    if (!this.channel) return { handled: false };

    return await this.channel.call("fetch", init);
  }

  async deliverMessage(
    data: unknown,
    ports: MessagePort[],
    source: ServiceWorkerClientSnapshot | null,
    origin: string,
  ) {
    await this.boot();
    await this.channel?.call("message", { data, ports, source, origin }, ports);
  }

  // the realm has to be running to hear any of these, and a registration that
  // was revived from storage hasn't spawned until something needs it
  private async live(): Promise<RealmChannel<HostBound, RealmBound> | null> {
    await this.boot();

    return this.channel;
  }

  async dispatchPush(data: string | null) {
    await (await this.live())?.call("push", { data });
  }

  async dispatchPushSubscriptionChange() {
    await (await this.live())?.call("pushsubscriptionchange", {});
  }

  async dispatchSync(tag: string, lastChance: boolean) {
    await (await this.live())?.call("sync", { tag, lastChance });
  }

  async dispatchPeriodicSync(tag: string) {
    await (await this.live())?.call("periodicsync", { tag });
  }

  async dispatchNotificationClick(
    notification: SerializedNotification,
    action: string,
  ) {
    await (
      await this.live()
    )?.call("notificationclick", {
      notification,
      action,
    });
  }

  async dispatchNotificationClose(notification: SerializedNotification) {
    await (await this.live())?.call("notificationclose", { notification });
  }

  async dispatchCanMakePayment(): Promise<boolean> {
    return (await (await this.live())?.call("canmakepayment", {})) ?? false;
  }

  async dispatchPaymentRequest(request: ServiceWorkerPaymentRequest) {
    return (
      (await (await this.live())?.call("paymentrequest", request)) ?? {
        handled: false,
      }
    );
  }

  async terminate(reason = "service worker realm terminated") {
    if (this.stopped) return;
    this.stopped = true;
    this.embedderConnection?.port.close();
    this.embedderConnection = null;
    try {
      await this.channel?.call("terminate", {});
    } catch {
      // the realm may already be gone
    }
    this.channel?.close("registration torn down");
    this.channel = null;
    if (this.worker && "terminate" in this.worker) this.worker.terminate();
    this.worker = null;
    this.booting = null;
    for (const listener of [...this.stoppedListeners]) {
      listener(reason);
    }
    this.stoppedListeners.clear();
  }
}

export class ServiceWorkerRegistry {
  private registrations = new Map<string, EmulatedRegistration>();
  private listeners = new Set<(event: ServiceWorkerHostEvent) => unknown>();
  // clientId -> logical url, built up from the requests we route
  private clients = new Map<string, string>();
  // browsing contexts that can act on a realm's behalf, newest last
  private pages = new Set<PageChannel>();
  // there is no notification service behind this, so the registry is the store
  private notifications: SerializedNotification[] = [];
  private loaded: Promise<unknown>;
  private closed = false;
  private closing: Promise<undefined> | null = null;

  constructor(public frame: Frame) {
    this.loaded = this.load();
  }

  get storagePartitionKey(): string {
    return this.frame.controller.init.storagePartitionKey;
  }

  close(): Promise<undefined> {
    if (this.closed) return Promise.resolve(undefined);
    if (this.closing) return this.closing;

    this.closing = this.closeRegistrations();
    return this.closing;
  }

  private async closeRegistrations(): Promise<undefined> {
    const failures: unknown[] = [];
    try {
      await this.loaded;
      for (const [id, registration] of this.registrations) {
        try {
          await registration.terminate();
          this.registrations.delete(id);
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      this.listeners.clear();
      this.clients.clear();
      this.pages.clear();
      this.notifications = [];
      this.closing = null;
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Scramjet service worker registry teardown failed",
      );
    }
    this.closed = true;
    return undefined;
  }

  private async load() {
    const persisted = await readPersisted(this.storagePartitionKey);
    for (const record of persisted) {
      if (this.registrations.has(record.id)) continue;
      this.registrations.set(record.id, new EmulatedRegistration(this, record));
    }
  }

  async launchEmbedder(
    options: ServiceWorkerEmbedderLaunchOptions,
  ): Promise<ServiceWorkerEmbedderLaunchHandle> {
    await this.loaded;
    if (this.closed || this.closing) {
      throw new Error("service worker registry is closed");
    }
    if (options.id.length === 0 || this.registrations.has(options.id)) {
      throw new Error(
        "service worker embedder registration identity is unavailable",
      );
    }
    const scriptURL = new URL(options.scriptURL);
    const scope = new URL(options.scope);
    const realmScriptURL = new URL(options.realmScriptURL, location.href);
    if (
      scriptURL.origin !== scope.origin ||
      !scriptURL.href.startsWith(scope.href)
    ) {
      throw new Error(
        "service worker embedder script is outside its scope origin",
      );
    }
    const registration = new EmulatedRegistration(
      this,
      {
        activated: false,
        id: options.id,
        origin: scriptURL.origin,
        scope: scope.href,
        scriptURL: scriptURL.href,
        storagePartitionKey: this.storagePartitionKey,
        type: options.type,
        updateViaCache: "none",
      },
      realmScriptURL.href,
      options.realmType ?? options.type,
      false,
      { data: options.data, port: options.port },
      options.realmWorkerKind ?? "shared",
    );
    registration.embedderControllee = options.controllee;
    this.registrations.set(options.id, registration);
    const boot = registration.boot();
    const ready = boot.then(
      () => undefined,
      async (cause) => {
        this.registrations.delete(options.id);
        await registration.terminate(
          cause instanceof Error ? cause.message : String(cause),
        );
        throw cause;
      },
    );
    return {
      ready,
      terminate: async () => {
        if (this.registrations.get(options.id) !== registration) return false;
        this.registrations.delete(options.id);
        await registration.terminate();
        return true;
      },
      onStopped: (listener) => registration.onStopped(listener),
    };
  }

  subscribe(
    listener: (event: ServiceWorkerHostEvent) => unknown,
  ): () => undefined {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
      return undefined;
    };
  }

  private emit(event: ServiceWorkerHostEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("service worker host listener threw:", error);
      }
    }
  }

  announce(registration: EmulatedRegistration) {
    this.emit({
      type: "registrationchange",
      registration: registration.snapshot(),
    });
  }

  announceController(registration: EmulatedRegistration) {
    this.emit({
      type: "controllerchange",
      registration: registration.snapshot(),
    });
  }

  noteClient(clientId: string, url: string) {
    if (clientId) this.clients.set(clientId, url);
  }

  attachPage(page: PageChannel): () => undefined {
    this.pages.add(page);

    return () => {
      this.pages.delete(page);
      return undefined;
    };
  }

  // a realm names a client by the id it saw on a FetchEvent, but a page has no
  // way to learn that id about itself, so url is the only join available
  private pageFor(clientId: string): PageChannel | null {
    const url = this.clients.get(clientId);
    if (!url) return null;

    for (const page of this.pages) {
      if (page.clientUrl === url) return page;
    }

    return null;
  }

  private anyPage(scope: string): PageChannel | null {
    let fallback: PageChannel | null = null;
    for (const page of this.pages) {
      if (page.clientUrl.startsWith(scope)) return page;
      fallback = page;
    }

    return fallback;
  }

  private snapshotFor(
    clientId: string,
    url: string,
    overrides: Partial<ServiceWorkerClientSnapshot> = {},
  ): ServiceWorkerClientSnapshot {
    return {
      id: clientId,
      url,
      type: "window",
      frameType: "nested",
      visibilityState: "visible",
      focused: false,
      ...overrides,
    };
  }

  async openWindow(
    registration: EmulatedRegistration,
    url: string,
  ): Promise<ServiceWorkerClientSnapshot | null> {
    const page = this.anyPage(registration.scope);
    if (!page) return null;

    const opened = await page.openWindow(url);
    if (!opened) return null;

    // the new context hasn't asked for anything yet, so it has no id we could
    // report. everything else about it is known
    return this.snapshotFor("", opened, { frameType: "auxiliary" });
  }

  async focusClient(
    registration: EmulatedRegistration,
    clientId: string,
  ): Promise<ServiceWorkerClientSnapshot | null> {
    const page = this.pageFor(clientId);
    if (!page) return null;

    await page.focus();

    return this.snapshotFor(clientId, page.clientUrl, { focused: true });
  }

  async navigateClient(
    registration: EmulatedRegistration,
    clientId: string,
    url: string,
  ): Promise<ServiceWorkerClientSnapshot | null> {
    // a worker may only navigate clients it controls, and only within scope
    if (!registration.controlled.has(clientId)) return null;
    if (!url.startsWith(registration.scope)) {
      throw new Error(
        "Failed to navigate a client: the url is not within the registration's scope",
      );
    }

    const page = this.pageFor(clientId);
    if (!page) return null;

    const landed = await page.navigate(url);
    if (!landed) return null;

    this.clients.set(clientId, landed);

    return this.snapshotFor(clientId, landed);
  }

  async showNotification(
    registration: EmulatedRegistration,
    title: string,
    options: unknown,
  ): Promise<undefined> {
    const opts = (options ?? {}) as Record<string, unknown>;
    const record: SerializedNotification = {
      title,
      body: String(opts.body ?? ""),
      tag: String(opts.tag ?? ""),
      data: opts.data ?? null,
      icon: String(opts.icon ?? ""),
      badge: String(opts.badge ?? ""),
      image: String(opts.image ?? ""),
      lang: String(opts.lang ?? ""),
      dir: (opts.dir as NotificationDirection) ?? "auto",
      silent: opts.silent === undefined ? null : !!opts.silent,
      requireInteraction: !!opts.requireInteraction,
      timestamp: Number(opts.timestamp ?? Date.now()),
    };

    // a tag replaces the notification already showing under it
    if (record.tag) {
      this.notifications = this.notifications.filter(
        (existing) => existing.tag !== record.tag,
      );
    }
    this.notifications.push(record);

    const page = this.anyPage(registration.scope);
    if (!page) return undefined;

    await page.showNotification(title, options);
    return undefined;
  }

  async getNotifications(
    registration: EmulatedRegistration,
    tag?: string,
  ): Promise<SerializedNotification[]> {
    return tag
      ? this.notifications.filter((n) => n.tag === tag)
      : [...this.notifications];
  }

  // host-driven events. nothing in the browser produces these for an emulated
  // worker, so an embedder injects them
  async dispatchPush(scope: string, data: string | null): Promise<boolean> {
    return this.forScope(scope, (r) => r.dispatchPush(data));
  }

  async dispatchPushSubscriptionChange(scope: string): Promise<boolean> {
    return this.forScope(scope, (r) => r.dispatchPushSubscriptionChange());
  }

  async dispatchSync(
    scope: string,
    tag: string,
    lastChance = false,
  ): Promise<boolean> {
    return this.forScope(scope, (r) => r.dispatchSync(tag, lastChance));
  }

  async dispatchPeriodicSync(scope: string, tag: string): Promise<boolean> {
    return this.forScope(scope, (r) => r.dispatchPeriodicSync(tag));
  }

  async dispatchNotificationClick(
    scope: string,
    tag: string,
    action = "",
  ): Promise<boolean> {
    const notification = this.notifications.find((n) => n.tag === tag);
    if (!notification) return false;

    return this.forScope(scope, (r) =>
      r.dispatchNotificationClick(notification, action),
    );
  }

  async dispatchNotificationClose(
    scope: string,
    tag: string,
  ): Promise<boolean> {
    const index = this.notifications.findIndex((n) => n.tag === tag);
    if (index === -1) return false;

    const [notification] = this.notifications.splice(index, 1);

    return this.forScope(scope, (r) =>
      r.dispatchNotificationClose(notification),
    );
  }

  async dispatchPaymentRequest(
    scope: string,
    request: ServiceWorkerPaymentRequest,
  ) {
    const registration = await this.matchScope(scope);
    if (!registration) return { handled: false };

    return await registration.dispatchPaymentRequest(request);
  }

  async dispatchCanMakePayment(scope: string): Promise<boolean> {
    const registration = await this.matchScope(scope);
    if (!registration) return false;

    return await registration.dispatchCanMakePayment();
  }

  private async forScope(
    scope: string,
    run: (registration: EmulatedRegistration) => Promise<unknown>,
  ): Promise<boolean> {
    const registration = await this.matchScope(scope);
    if (!registration) return false;

    await run(registration);

    return true;
  }

  knownClients(scope: string): string[] {
    const ids: string[] = [];
    for (const [id, url] of this.clients) {
      if (url.startsWith(scope)) ids.push(id);
    }

    return ids;
  }

  clientSnapshots(
    scope: string,
    only: Set<string> | null,
  ): ServiceWorkerClientSnapshot[] {
    const snapshots: ServiceWorkerClientSnapshot[] = [];
    for (const [id, url] of this.clients) {
      if (!url.startsWith(scope)) continue;
      if (only && !only.has(id)) continue;
      snapshots.push(this.snapshotFor(id, url));
    }

    return snapshots;
  }

  // the reverse of pageFor: a page knows its url, and the registry knows which
  // ids it has seen that url under
  private clientIdFor(clientUrl: string): string {
    for (const [id, url] of this.clients) {
      if (url === clientUrl) return id;
    }

    return "";
  }

  deliverToClient(
    registration: EmulatedRegistration,
    clientId: string,
    data: unknown,
    ports: MessagePort[],
  ) {
    this.emit({
      type: "message",
      id: registration.id,
      clientId,
      data,
      ports,
      origin: new URL(registration.scope).origin,
    });
  }

  async register(
    options: ServiceWorkerRegisterOptions,
  ): Promise<ServiceWorkerRegistrationSnapshot> {
    await this.loaded;

    const scope = options.scope ?? new URL("./", options.scriptURL).href;
    const origin = new URL(options.scriptURL).origin;

    let registration: EmulatedRegistration | undefined;
    for (const existing of this.registrations.values()) {
      if (existing.scope === scope && existing.origin === origin) {
        registration = existing;
        break;
      }
    }

    if (registration && registration.scriptURL !== options.scriptURL) {
      // a different script for the same scope replaces the old one
      await registration.terminate();
      this.registrations.delete(registration.id);
      await deletePersisted(this.storagePartitionKey, registration.id);
      registration = undefined;
    }

    if (!registration) {
      registration = new EmulatedRegistration(this, {
        id: makeId(),
        origin,
        scope,
        scriptURL: options.scriptURL,
        storagePartitionKey: this.storagePartitionKey,
        type: options.type ?? "classic",
        updateViaCache: options.updateViaCache ?? "imports",
        activated: false,
      });
      this.registrations.set(registration.id, registration);
      await writePersisted(registration.persist());
    }

    // registration resolves as soon as the job is queued, so booting the realm
    // deliberately isn't awaited here
    registration.boot().catch((error) => {
      console.error("service worker failed to boot:", error);
    });

    return registration.snapshot(options.clientUrl);
  }

  async getRegistrations(
    clientUrl: string,
  ): Promise<ServiceWorkerRegistrationSnapshot[]> {
    await this.loaded;

    return [...this.registrations.values()]
      .filter((r) => r.origin === new URL(clientUrl).origin)
      .sort((a, b) => b.scope.length - a.scope.length)
      .map((r) => r.snapshot(clientUrl));
  }

  async getController(
    clientUrl: string,
  ): Promise<ServiceWorkerRegistrationSnapshot | null> {
    const match = await this.matchScope(clientUrl);

    return match ? match.snapshot(clientUrl) : null;
  }

  // longest matching scope wins, same as the spec
  async matchScope(url: string): Promise<EmulatedRegistration | null> {
    await this.loaded;

    let best: EmulatedRegistration | null = null;
    for (const registration of this.registrations.values()) {
      if (!url.startsWith(registration.scope)) continue;
      if (!best || registration.scope.length > best.scope.length) {
        best = registration;
      }
    }

    return best;
  }

  async unregister(id: string): Promise<boolean> {
    const registration = this.registrations.get(id);
    if (!registration) return false;

    await registration.terminate();
    this.registrations.delete(id);
    await deletePersisted(this.storagePartitionKey, id);
    this.emit({ type: "registrationgone", id });

    return true;
  }

  async update(id: string): Promise<ServiceWorkerRegistrationSnapshot> {
    await this.loaded;
    const registration = this.registrations.get(id);
    if (!registration) throw new Error("no such registration");

    // the script is fetched through the normal pipeline, so re-spawning the
    // realm is what picks up a new copy
    await registration.terminate();
    registration.activated = false;
    this.emit({ type: "updatefound", id });
    await registration.boot();

    return registration.snapshot();
  }

  async postMessage(
    id: string,
    data: unknown,
    ports: MessagePort[],
    clientUrl: string,
  ): Promise<undefined> {
    await this.loaded;
    const registration = this.registrations.get(id);
    if (!registration) return undefined;

    // event.source has to be the page that sent this, and event.origin its
    // origin - both unrewritten, which is what the registry stores
    const source = clientUrl
      ? this.snapshotFor(this.clientIdFor(clientUrl), clientUrl)
      : null;

    await registration.deliverMessage(
      data,
      ports,
      source,
      source ? new URL(source.url).origin : new URL(registration.scope).origin,
    );
    return undefined;
  }

  // cheap "is there anything that could intercept this" check, so the caller can
  // skip the work of preparing a request nothing is going to look at
  async wouldRoute(
    url: string,
    clientUrl: string | undefined,
  ): Promise<boolean> {
    await this.loaded;
    if (this.registrations.size === 0) return false;

    const registration = await this.matchScope(clientUrl ?? url);

    if (!registration) return false;
    if (registration.embedderControllee !== null) {
      return registration.embedderControls(clientUrl);
    }
    return registration.activated;
  }

  async routeFetch(
    init: ServiceWorkerFetchRequestInit,
    clientUrl: string | undefined,
  ): Promise<ServiceWorkerFetchResult> {
    await this.loaded;
    if (this.registrations.size === 0) return { handled: false };

    // a service worker sees requests from the clients it controls, and
    // navigations into its scope, but never its own
    const target = clientUrl ?? init.url;
    const registration = await this.matchScope(target);
    if (!registration) return { handled: false };

    // an embedder registration's controllee owner decides; a rejected request
    // is a network error, a fallback runs the normal pipeline
    const controllee = registration.embedderControllee;
    if (controllee !== null) {
      // only a controlled client dispatches; an uncontrolled request never
      // enters the handler and runs the normal pipeline
      if (!clientUrl || !registration.embedderControls(clientUrl)) {
        return { handled: false };
      }
      const decision = await controllee.match({
        url: init.url,
        clientUrl,
        clientOrigin: new URL(clientUrl).origin,
        clientId: init.clientId,
        resultingClientId: init.resultingClientId,
        destination: init.destination,
      });
      if (decision.dispatch === "fallback") return { handled: false };
      if (decision.dispatch === "reject") {
        return { handled: true, error: decision.reason };
      }
      return await registration.dispatchFetch(init);
    }
    if (!registration.activated) return { handled: false };

    const clientId = init.clientId || init.resultingClientId;
    if (!registration.controlled.has(clientId)) {
      if (clientUrl) return { handled: false };
      // a navigation into scope, which a worker controls from the moment it
      // lands rather than having to claim
      registration.controlled.add(clientId);
    }

    return await registration.dispatchFetch(init);
  }
}
