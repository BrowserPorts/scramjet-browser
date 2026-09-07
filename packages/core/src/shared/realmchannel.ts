// minimal request/response channel over a MessagePort, used for the host <->
// emulated service worker realm protocol. every frame carries a version because
// a SharedWorker-hosted realm outlives the tabs talking to it

import { Array_isArray, Error, String, _Map, _Promise } from "./snapshot";

export const REALM_PROTOCOL_VERSION = 1;

type Frame =
  | {
      v: number;
      t: "call";
      id: string;
      method: string;
      args: unknown;
    }
  | {
      v: number;
      t: "return";
      id: string;
      value?: unknown;
      error?: string;
    };

type Pending = {
  resolve: (value: any) => unknown;
  reject: (reason: unknown) => unknown;
};

export type RealmMethods = Record<string, [unknown, unknown?] | []>;

export type RealmHandlers<Local extends RealmMethods> = {
  [M in keyof Local]: (
    args: Local[M] extends [infer A, ...any[]] ? A : undefined,
    transfer: MessagePort[],
  ) => Promise<
    Local[M] extends [any, infer R]
      ? R extends undefined
        ? undefined
        : [R, Transferable[]] | R
      : undefined
  >;
};

export type MessagePortLike = {
  postMessage(data: any, transfer?: Transferable[]): unknown;
  addEventListener(
    type: "message",
    listener: (ev: MessageEvent) => unknown,
  ): unknown;
  start?(): unknown;
};

export class RealmChannel<
  Local extends RealmMethods,
  Remote extends RealmMethods,
> {
  private pending = new _Map<string, Pending>();
  private counter = 0;

  constructor(
    private port: MessagePortLike,
    private handlers: RealmHandlers<Local>,
    private label: string,
  ) {
    this.port.addEventListener("message", (event: MessageEvent) => {
      this.receive(event).catch((error) => {
        this.close(
          error instanceof globalThis.Error ? error.message : String(error),
        );
      });
    });
    this.port.start?.();
  }

  private post(frame: Frame, transfer: Transferable[]) {
    this.port.postMessage(frame, transfer);
  }

  private async receive(event: MessageEvent) {
    const frame = event.data as Frame;
    if (!frame || typeof frame !== "object") return;
    if (frame.v !== REALM_PROTOCOL_VERSION) return;

    if (frame.t === "return") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      if (frame.error !== undefined) {
        pending.reject(new Error(frame.error));
      } else {
        pending.resolve(frame.value);
      }

      return;
    }

    if (frame.t !== "call") return;

    const handler = this.handlers[frame.method as keyof Local];
    if (!handler) {
      this.post(
        {
          v: REALM_PROTOCOL_VERSION,
          t: "return",
          id: frame.id,
          error: `${this.label}: no handler for ${frame.method}`,
        },
        [],
      );

      return;
    }

    try {
      const result = await handler(frame.args as any, event.ports as any);
      let value: unknown = result;
      let transfer: Transferable[] = [];
      // handlers return [value, transferables] when something has to move
      // instead of being cloned
      if (
        Array_isArray(result) &&
        result.length === 2 &&
        Array_isArray(result[1])
      ) {
        value = result[0];
        transfer = result[1] as Transferable[];
      }
      this.post(
        { v: REALM_PROTOCOL_VERSION, t: "return", id: frame.id, value },
        transfer,
      );
    } catch (err) {
      this.post(
        {
          v: REALM_PROTOCOL_VERSION,
          t: "return",
          id: frame.id,
          error: (err as globalThis.Error)?.message ?? String(err),
        },
        [],
      );
    }
  }

  call<M extends keyof Remote & string>(
    method: M,
    args: Remote[M] extends [infer A, ...any[]] ? A : undefined,
    transfer: Transferable[] = [],
  ): Promise<Remote[M] extends [any, infer R] ? R : undefined> {
    const entropy = new Uint32Array(2);
    globalThis.crypto.getRandomValues(entropy);
    const id = `${this.label}-${this.counter++}-${entropy[0]?.toString(36)}${entropy[1]?.toString(36)}`;

    return new _Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post(
        { v: REALM_PROTOCOL_VERSION, t: "call", id, method, args },
        transfer,
      );
    }) as any;
  }

  close(reason: string) {
    for (const [, pending] of this.pending) {
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
