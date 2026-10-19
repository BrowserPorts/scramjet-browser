import { RemoteTransport } from "@mercuryworkshop/rpc";
import { messageFields } from "@/runtime-identity";
import type { ScramjetClient } from "./client";

const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
const stopEvent = Event.prototype.stopImmediatePropagation;
const startPort = MessagePort.prototype.start;
const postPort = MessagePort.prototype.postMessage;

/** The creator forwards this private channel straight to the owning controller */
export function createWorkerTransport(): RemoteTransport {
  const channel = new MessageChannel();
  const transport = new RemoteTransport(channel.port1);
  const message = { [messageFields.workerTransport]: true };
  if ("SharedWorkerGlobalScope" in globalThis) {
    const connect = (event: MessageEvent) => {
      const port = event.ports[0];
      if (!port) return;
      removeListener.call(globalThis, "connect", connect, true);
      postPort.call(port, message, [channel.port2]);
    };
    addListener.call(globalThis, "connect", connect, true);
  } else {
    const scope = globalThis as unknown as {
      postMessage(message: unknown, transfer: Transferable[]): unknown;
    };
    scope.postMessage(message, [channel.port2]);
  }
  return transport;
}

/** Consumes the handshake before guest listeners can observe its transferred port */
export function linkWorkerTransport(
  client: ScramjetClient,
  target: Worker | MessagePort,
): undefined {
  const receive = (event: MessageEvent) => {
    if (event.data?.[messageFields.workerTransport] !== true || !event.ports[0])
      return;
    stopEvent.call(event);
    removeListener.call(target, "message", receive, true);
    const port = event.ports[0];
    client.init.linkWorkerTransport(port).catch((error) => {
      port.close();
      console.error("The worker transport could not connect", error);
    });
  };
  addListener.call(target, "message", receive, true);
  if (target instanceof MessagePort) startPort.call(target);
  return undefined;
}
