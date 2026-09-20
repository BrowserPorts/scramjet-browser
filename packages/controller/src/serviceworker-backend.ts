import type { ServiceWorkerRegistry } from "./serviceworker";

export type ServiceWorkerBackend = Pick<
  ServiceWorkerRegistry,
  | "register"
  | "getRegistrations"
  | "getController"
  | "unregister"
  | "update"
  | "attachPage"
  | "subscribe"
  | "noteClient"
  | "wouldRoute"
  | "routeFetch"
  | "close"
> & {
  // The optional version identity preserves compatibility with legacy embedders.
  postMessage(
    ...args: [
      ...Parameters<ServiceWorkerRegistry["postMessage"]>,
      workerId?: string,
    ]
  ): ReturnType<ServiceWorkerRegistry["postMessage"]>;
};
