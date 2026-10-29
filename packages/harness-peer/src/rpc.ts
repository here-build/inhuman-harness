/**
 * JSON-RPC over a y-websocket provider. No `node:`, no `ws`.
 * Unix dial stays in `unix.ts`.
 *
 * Unsent calls wait for the next open. A call already on the wire dies with
 * that socket; the peer will not answer that id. `closed` / `rejectAll` are
 * terminal; `disconnected` is not.
 */
import { encodeJsonRpcRequest, jsonRpcResponse, RpcClientError } from "@inhuman.tools/harness-contract";
import { WebsocketProvider } from "y-websocket";

import { MESSAGE_AWARENESS, MESSAGE_QUERY_AWARENESS } from "./frames.js";

type AwarenessSpeaker = WebsocketProvider & {
  readonly _awarenessUpdateHandler?: (update: unknown, origin: unknown) => void;
};

/**
 * Mute y-websocket's stock Awareness. A live `{}` on `doc.clientID` is
 * plexus-applied as channel 0 and drops the kernel seat.
 */
export function detachProtocolAwareness(provider: WebsocketProvider): void {
  const speaker = provider as AwarenessSpeaker;
  if (speaker._awarenessUpdateHandler != null) {
    provider.awareness.off("update", speaker._awarenessUpdateHandler);
  }
  provider.messageHandlers[MESSAGE_AWARENESS] = () => undefined;
  provider.messageHandlers[MESSAGE_QUERY_AWARENESS] = () => undefined;
  provider.awareness.setLocalState(null);
}

export function destroyProvider(provider: WebsocketProvider): void {
  provider.disconnectBc = () => undefined;
  provider.destroy();
}

export function waitForSync(provider: WebsocketProvider, room: string, timeoutMs?: number): Promise<void> {
  if (provider.synced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (timer !== undefined) clearTimeout(timer);
      provider.off("sync", onSync);
      provider.off("closed", onClosed);
      provider.off("connection-error", onError);
      if (error === undefined) resolve();
      else reject(error);
    };
    if (timeoutMs != null && timeoutMs > 0) {
      timer = setTimeout(() => {
        const ws = provider.ws;
        finish(
          new Error(
            `${room}: sync timeout connected=${String(provider.wsconnected)} state=${String(ws?.readyState ?? "none")}`,
          ),
        );
      }, timeoutMs);
    }
    const onSync = (state: boolean): void => {
      if (state) finish();
    };
    const onClosed = (): void => finish(new Error(`${room}: closed before sync`));
    const onError = (): void => finish(new Error(`${room}: websocket error`));
    provider.on("sync", onSync);
    provider.on("closed", onClosed);
    provider.on("connection-error", onError);
  });
}

export function bindTextFrames(provider: WebsocketProvider, onText: (text: string) => void): void {
  let bound: unknown = null;
  const listen = (): void => {
    const ws = provider.ws;
    if (ws == null || ws === bound) return;
    bound = ws;
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      provider.wsLastMessageReceived = Date.now();
      onText(event.data);
    });
    // y-websocket still owns onmessage; a string payload is `new Uint8Array(string)` → empty buffer.
    const yjs = ws.onmessage;
    if (yjs != null) {
      // eslint-disable-next-line unicorn/prefer-add-event-listener -- must wrap y-websocket's onmessage, not add a second listener
      ws.onmessage = (event) => {
        if (typeof event.data === "string") return;
        yjs.call(ws, event);
      };
    }
  };
  listen();
  provider.on("status", (event: { status: string }) => {
    if (event.status === "connected") listen();
  });
}

export type JsonRpcPort = {
  request(method: string, params?: unknown): Promise<unknown>;
  rejectAll(reason: Error): void;
  whenLost(): Promise<void>;
  readonly lost: boolean;
};

type RpcCall = {
  method: string;
  params: unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export function bindJsonRpc(provider: WebsocketProvider): JsonRpcPort {
  let rpcId = 0;
  const inbound = new Map<number, RpcCall>();
  const outbound: RpcCall[] = [];
  const lostWaiters: Array<() => void> = [];
  let lost: Error | null = null;

  const rejectCalls = (calls: Iterable<RpcCall>, reason: Error): void => {
    for (const call of calls) call.reject(reason);
  };

  const rejectAll = (reason: Error): void => {
    if (lost == null) {
      lost = reason;
      for (const waiter of lostWaiters.splice(0)) waiter();
    }
    rejectCalls(inbound.values(), reason);
    inbound.clear();
    rejectCalls(outbound.splice(0), reason);
  };

  const flush = (): void => {
    if (lost != null) return;
    const ws = provider.ws;
    if (ws?.readyState !== 1) return;
    for (const call of outbound.splice(0)) {
      const id = (rpcId += 1);
      inbound.set(id, call);
      ws.send(encodeJsonRpcRequest(id, call.method, call.params));
    }
  };

  provider.on("closed", () => rejectAll(new Error("rpc: socket closed")));
  bindTextFrames(provider, (text) => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = jsonRpcResponse.safeParse(raw);
    if (!parsed.success || typeof parsed.data.id !== "number") return;
    const call = inbound.get(parsed.data.id);
    if (call === undefined) return;
    inbound.delete(parsed.data.id);
    if ("error" in parsed.data) {
      call.reject(new RpcClientError(parsed.data.error.code, parsed.data.error.message));
      return;
    }
    call.resolve(parsed.data.result);
  });
  // After bindTextFrames so a new socket is wrapped before we write.
  provider.on("status", (event: { status: string }) => {
    if (event.status === "disconnected") {
      rejectCalls(inbound.values(), new Error("rpc: socket closed"));
      inbound.clear();
    }
    if (event.status === "connected") flush();
  });

  return {
    request(method: string, params: unknown = {}): Promise<unknown> {
      if (lost != null) return Promise.reject(lost);
      return new Promise((resolve, reject) => {
        outbound.push({ method, params, resolve, reject });
        flush();
      });
    },
    rejectAll,
    get lost(): boolean {
      return lost != null;
    },
    whenLost(): Promise<void> {
      if (lost != null) return Promise.resolve();
      return new Promise((resolve) => {
        lostWaiters.push(resolve);
      });
    },
  };
}
