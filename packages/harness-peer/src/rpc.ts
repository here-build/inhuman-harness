/**
 * JSON-RPC over a {@link RoomConnection}. No `node:`, no `ws`.
 * Unix dial stays in `unix.ts`.
 *
 * Unsent calls wait for the next open. A call already on the wire dies with
 * that socket; the peer will not answer that id. `closed` / `rejectAll` are
 * terminal; `disconnected` is not.
 */
import { encodeJsonRpcRequest, jsonRpcResponse, RpcClientError } from "@inhuman.tools/harness-contract";

import { RoomConnection } from "./provider.js";

export function detachLocalPresence(connection: RoomConnection): void {
  connection.awareness.setLocalState(null);
}

export function destroyRoomConnection(connection: RoomConnection): void {
  connection.destroy();
}

export function waitForSync(connection: RoomConnection, room: string, timeoutMs?: number): Promise<void> {
  if (connection.synced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (timer !== undefined) clearTimeout(timer);
      connection.off("sync", onSync);
      connection.off("closed", onClosed);
      connection.off("connection-error", onError);
      if (error === undefined) resolve();
      else reject(error);
    };
    if (timeoutMs != null && timeoutMs > 0) {
      timer = setTimeout(() => {
        const ws = connection.ws;
        finish(
          new Error(
            `${room}: sync timeout connected=${String(connection.wsconnected)} state=${String(ws?.readyState ?? "none")}`,
          ),
        );
      }, timeoutMs);
    }
    const onSync = (state: boolean): void => {
      if (state) finish();
    };
    const onClosed = (): void => finish(new Error(`${room}: closed before sync`));
    const onError = (): void => finish(new Error(`${room}: websocket error`));
    connection.on("sync", onSync);
    connection.on("closed", onClosed);
    connection.on("connection-error", onError);
  });
}

export type TextFrameSource = {
  ws: {
    readonly readyState: number;
    send(text: string): void;
    addEventListener(type: "message", fn: (event: { data: unknown }) => void): void;
  } | null;
  wsLastMessageReceived: number;
  on(event: string, fn: (...args: any[]) => void): void;
  off?(event: string, fn: (...args: any[]) => void): void;
};

export function bindTextFrames(
  connection: RoomConnection | TextFrameSource,
  onText: (text: string) => void,
): () => void {
  if (connection instanceof RoomConnection) {
    const handler = (text: string): void => {
      onText(text);
    };
    connection.on("text", handler);
    return () => connection.off("text", handler);
  }

  let bound: unknown = null;
  const listen = (): void => {
    const ws = connection.ws;
    if (ws == null || ws === bound) return;
    bound = ws;
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      connection.wsLastMessageReceived = Date.now();
      if (event.data === " pong") return;
      onText(event.data);
    });
  };
  listen();
  const onStatus = (event: { status: string }): void => {
    if (event.status === "connected") listen();
  };
  connection.on("status", onStatus);
  return () => {
    connection.off?.("status", onStatus);
  };
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

export function bindJsonRpc(connection: RoomConnection | TextFrameSource): JsonRpcPort {
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
    const ws = connection.ws;
    if (ws?.readyState !== 1) return;
    for (const call of outbound.splice(0)) {
      const id = (rpcId += 1);
      inbound.set(id, call);
      ws.send(encodeJsonRpcRequest(id, call.method, call.params));
    }
  };

  connection.on("closed", () => rejectAll(new Error("rpc: socket closed")));
  bindTextFrames(connection, (text) => {
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
  connection.on("status", (event: { status: string }) => {
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

export { type RoomConnectionOptions, RoomConnection } from "./provider.js";
