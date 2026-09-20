// Native nested service workers use a URL beside the encoded site scope to send
// network fallbacks and constructed responses through Scramjet's controller.
// Because encoded site scopes begin with the encoded virtual origin, this path is
// controlled by Scramjet's root worker rather than by the nested site worker.
export const SERVICE_WORKER_GATEWAY = "__scramjet_serviceworker_gateway__";

export type NativeServiceWorkerRequest = {
  rawUrl: string;
  rawReferrer: string | null;
  destination: RequestDestination | "serviceworker";
  mode: RequestMode;
  credentials?: RequestCredentials;
  referrer: string;
  method: string;
  cache: RequestCache;
  initialHeaders: [string, string][];
  body: ArrayBuffer | null;
  rawClientUrl?: string;
  clientId?: string;
  sourceClientId?: string;
  resultingClientId?: string;
};

export type NativeServiceWorkerResponse = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
};

export type NativeServiceWorkerGatewayMetadata =
  | {
      kind: "request";
      request: NativeServiceWorkerRequest;
    }
  | {
      kind: "response";
      request: NativeServiceWorkerRequest;
      response: NativeServiceWorkerResponse;
    };

// Legacy synthetic-worker contracts remain exported temporarily so downstream
// consumers compiled against the alpha API do not break during the migration.

export type ServiceWorkerState =
  | "parsed"
  | "installing"
  | "installed"
  | "activating"
  | "activated"
  | "redundant";

export type ServiceWorkerUpdateViaCache = "imports" | "all" | "none";

export type ServiceWorkerWorkerSnapshot = {
  id: string;
  scriptURL: string;
  state: ServiceWorkerState;
};

export type ServiceWorkerRegistrationSnapshot = {
  id: string;
  scope: string;
  updateViaCache: ServiceWorkerUpdateViaCache;
  installing: ServiceWorkerWorkerSnapshot | null;
  waiting: ServiceWorkerWorkerSnapshot | null;
  active: ServiceWorkerWorkerSnapshot | null;
  // whether this registration controls the client that asked
  controlling: boolean;
};

export type ServiceWorkerRegisterOptions = {
  scriptURL: string;
  scope?: string;
  type?: "classic" | "module";
  updateViaCache?: ServiceWorkerUpdateViaCache;
  clientUrl: string;
};

export type ServiceWorkerHostEvent =
  | {
      type: "registrationchange";
      registration: ServiceWorkerRegistrationSnapshot;
    }
  | {
      type: "registrationgone";
      id: string;
    }
  | {
      type: "updatefound";
      id: string;
    }
  | {
      type: "controllerchange";
      registration: ServiceWorkerRegistrationSnapshot | null;
    }
  | {
      type: "message";
      id: string;
      // the client the realm addressed, which pages can't yet match against
      // themselves, so this is delivered to every client in the frame
      clientId: string;
      data: unknown;
      ports: MessagePort[];
      origin: string;
    };

// implemented by the host and handed to the page's client, so core never has to
// know how a realm is spawned or addressed
export type ServiceWorkerHost = {
  register(
    options: ServiceWorkerRegisterOptions,
  ): Promise<ServiceWorkerRegistrationSnapshot>;
  // registrations visible to clientUrl, longest scope first
  getRegistrations(
    clientUrl: string,
  ): Promise<ServiceWorkerRegistrationSnapshot[]>;
  getController(
    clientUrl: string,
  ): Promise<ServiceWorkerRegistrationSnapshot | null>;
  unregister(id: string): Promise<boolean>;
  update(id: string): Promise<ServiceWorkerRegistrationSnapshot>;
  postMessage(
    id: string,
    workerId: string,
    data: unknown,
    transfer: Transferable[],
    // lets the host build the `source` Client the realm sees, since a page
    // has no way to learn its own service worker client id
    clientUrl: string,
  ): Promise<undefined>;
  subscribe(
    listener: (event: ServiceWorkerHostEvent) => unknown,
  ): () => unknown;
  // a realm can ask the platform to act on a client (Clients.openWindow,
  // WindowClient.focus/navigate, registration.showNotification). only a real
  // browsing context can do any of that, so the page hands the host the
  // implementations and the host picks which page to run them in
  serve(ops: ServiceWorkerPageOps): () => unknown;
};

export type ServiceWorkerPageOps = {
  // the page's current unrewritten url, which is how the host matches a client
  // id it learned from a FetchEvent to a channel it can talk to
  clientUrl(): string;
  // returns the url actually opened, or null if the browser refused
  openWindow(url: string): Promise<string | null>;
  focus(): Promise<undefined>;
  navigate(url: string): Promise<string | null>;
  showNotification(title: string, options: unknown): Promise<undefined>;
};

// id is the proxy service worker's FetchEvent client id, which is what lets the
// host route a realm-issued postMessage back to a real browsing context
export type ServiceWorkerClientSnapshot = {
  id: string;
  url: string;
  type: "window" | "worker" | "sharedworker" | "all";
  frameType: "auxiliary" | "top-level" | "nested" | "none";
  visibilityState: "hidden" | "visible";
  focused: boolean;
};

export type ServiceWorkerFetchRequestInit = {
  url: string;
  method: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
  destination: RequestDestination;
  mode: RequestMode;
  credentials: RequestCredentials;
  cache: RequestCache;
  redirect: RequestRedirect;
  referrer: string;
  referrerPolicy: string;
  integrity: string;
  keepalive: boolean;
  isReloadNavigation: boolean;
  isHistoryNavigation: boolean;
  clientId: string;
  resultingClientId: string;
};

export type ServiceWorkerFetchResult = {
  // false when the site's worker never called respondWith
  handled: boolean;
  response?: {
    body: ArrayBuffer | ReadableStream<Uint8Array> | string | null;
    status: number;
    statusText: string;
    headers: [string, string][];
    // whether the body already went through the rewriter
    rewritten: boolean;
    redirected: boolean;
    type: ResponseType;
    url: string;
  };
  error?: string;
};

export type SerializedNotification = {
  title: string;
  body: string;
  tag: string;
  data: unknown;
  icon: string;
  badge: string;
  image: string;
  lang: string;
  dir: NotificationDirection;
  silent: boolean | null;
  requireInteraction: boolean;
  timestamp: number;
};

// there is no payment handler behind this, so everything here is whatever the
// host was told to deliver
export type ServiceWorkerPaymentRequest = {
  topOrigin: string;
  paymentRequestOrigin: string;
  paymentRequestId: string;
  methodData: unknown[];
  total: unknown;
  modifiers: unknown[];
  instrumentKey: string;
};

type NoArgs = Record<string, never>;

// there's one channel per realm and the host knows which registration it opened
// it for, so nothing here needs to identify the realm to the host
export type RealmBound = {
  connectEmbedder: [{ data: unknown }];
  install: [NoArgs, { ok: boolean; error?: string }];
  activate: [NoArgs, { ok: boolean; error?: string }];
  fetch: [ServiceWorkerFetchRequestInit, ServiceWorkerFetchResult];
  message: [
    {
      data: unknown;
      ports: MessagePort[];
      source: ServiceWorkerClientSnapshot | null;
      origin: string;
    },
  ];
  push: [{ data: string | null }];
  pushsubscriptionchange: [NoArgs];
  sync: [{ tag: string; lastChance: boolean }];
  periodicsync: [{ tag: string }];
  notificationclick: [{ notification: SerializedNotification; action: string }];
  notificationclose: [{ notification: SerializedNotification }];
  canmakepayment: [NoArgs, boolean];
  paymentrequest: [
    ServiceWorkerPaymentRequest,
    { handled: boolean; response?: unknown; error?: string },
  ];
  terminate: [NoArgs];
};

export type HostBound = {
  ready: [NoArgs];
  skipWaiting: [NoArgs];
  claim: [NoArgs];
  matchAll: [
    { type: string; includeUncontrolled: boolean },
    ServiceWorkerClientSnapshot[],
  ];
  getClient: [{ id: string }, ServiceWorkerClientSnapshot | null];
  openWindow: [{ url: string }, ServiceWorkerClientSnapshot | null];
  focusClient: [{ id: string }, ServiceWorkerClientSnapshot | null];
  navigateClient: [
    { id: string; url: string },
    ServiceWorkerClientSnapshot | null,
  ];
  postMessageToClient: [{ id: string; data: unknown; ports: MessagePort[] }];
  unregister: [NoArgs, boolean];
  update: [NoArgs];
  showNotification: [{ title: string; options: unknown }];
  getNotifications: [{ tag?: string }, SerializedNotification[]];
};
