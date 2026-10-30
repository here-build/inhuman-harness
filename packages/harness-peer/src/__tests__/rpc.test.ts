import { isRpcContractError, RpcClientError } from "@inhuman.tools/harness-contract";
import { describe, expect, it } from "vitest";
import type { WebsocketProvider } from "y-websocket";

import { bindJsonRpc, bindTextFrames } from "../rpc.js";

type FakeWs = {
  readyState: number;
  OPEN: number;
  send: (text: string) => void;
  addEventListener: (type: string, fn: (event: { data: unknown }) => void) => void;
  onmessage: ((event: { data: unknown }) => void) | null;
  listeners: Array<(event: { data: unknown }) => void>;
};

function fakeProvider(): {
  readonly provider: WebsocketProvider;
  emit(event: string, payload?: unknown): void;
  deliver(text: string): void;
  drop(): void;
  reconnect(): void;
} {
  const handlers = new Map<string, Set<(payload?: unknown) => void>>();
  const makeWs = (): FakeWs => {
    const listeners: Array<(event: { data: unknown }) => void> = [];
    return {
      readyState: 1,
      OPEN: 1,
      send: () => undefined,
      listeners,
      addEventListener: (_type: string, fn: (event: { data: unknown }) => void) => {
        listeners.push(fn);
      },
      onmessage: null,
    };
  };
  const provider = {
    ws: makeWs() as unknown as WebsocketProvider["ws"],
    wsLastMessageReceived: 0,
    on(event: string, fn: (payload?: unknown) => void) {
      let set = handlers.get(event);
      if (set == null) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(fn);
    },
    off(event: string, fn: (payload?: unknown) => void) {
      handlers.get(event)?.delete(fn);
    },
    emit(event: string, payload?: unknown) {
      for (const fn of handlers.get(event) ?? []) fn(payload);
    },
  };
  const current = (): FakeWs => provider.ws as unknown as FakeWs;
  return {
    provider: provider as unknown as WebsocketProvider,
    emit: provider.emit,
    deliver(text: string) {
      for (const fn of current().listeners) fn({ data: text });
    },
    drop() {
      current().readyState = 3;
      provider.emit("status", { status: "disconnected" });
    },
    reconnect() {
      provider.ws = makeWs() as unknown as WebsocketProvider["ws"];
      provider.emit("status", { status: "connected" });
    },
  };
}

describe("bindJsonRpc", () => {
  it("rejects in-flight on drop; queued call sends after reconnect; whenLost waits for close", async () => {
    const fake = fakeProvider();
    const rpc = bindJsonRpc(fake.provider);
    const pending = rpc.request("eval", { requestId: "r1" });
    const lost = rpc.whenLost();
    fake.drop();
    await expect(pending).rejects.toThrow(/socket closed/);
    let settled = false;
    void lost.then(() => {
      settled = true;
      return undefined;
    });
    await Promise.resolve();
    const queued = rpc.request("eval", { requestId: "r2" });
    fake.reconnect();
    fake.deliver(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true, turnId: "t", programId: "p" } }));
    expect({ lost: rpc.lost, settled, queued: await queued }).toEqual({
      lost: false,
      settled: false,
      queued: { ok: true, turnId: "t", programId: "p" },
    });
    fake.emit("closed");
    await lost;
    await expect(rpc.request("eval", { requestId: "r3" })).rejects.toThrow(/socket closed/);
    expect(rpc.lost).toBe(true);
  });

  it("surfaces JSON-RPC invalid-params as a contract error", async () => {
    const { provider, deliver } = fakeProvider();
    const rpc = bindJsonRpc(provider);
    const pending = rpc.request("eval", { requestId: "r1" });
    deliver(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32_602, message: "eval requestId already admitted with different input" },
      }),
    );
    const error = await pending.then(
      () => null,
      (error_: unknown) => error_,
    );
    expect({
      kind: error instanceof RpcClientError,
      code: error instanceof RpcClientError ? error.code : null,
      contract: isRpcContractError(new RpcClientError(-32_602, "x")),
      transport: isRpcContractError(new Error("rpc: socket closed")),
    }).toEqual({ kind: true, code: -32_602, contract: true, transport: false });
  });
});

describe("bindTextFrames", () => {
  it("counts a pong as traffic but never hands it on", () => {
    const { provider, deliver } = fakeProvider();
    const seen: string[] = [];
    bindTextFrames(provider, (text) => seen.push(text));
    deliver(" pong");
    expect(provider.wsLastMessageReceived).toBeGreaterThan(0);
    expect(seen).toEqual([]);
    deliver('{"id":1}');
    expect(seen).toEqual(['{"id":1}']);
  });
});
