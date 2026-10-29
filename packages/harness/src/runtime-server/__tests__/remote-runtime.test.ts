/**
 * Runtime + YjsServer via PrivatePeerHub. Distinct replicas, covering
 * flush, recover-before-activate, reconnect coverage none, failed flush.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- temp dirs */
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { BotCallJob, SessionSystemPrompt, SessionTurn, SystemToolJob } from "@inhuman.tools/harness-model";
import { joinReleased } from "@inhuman.tools/turn/agent-calls";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { openDriverRegistry } from "@/connections";
import { documentKey, KERNEL_DOCUMENT_KEY, receiptCoversCheckpoint } from "@/protocol/document";
import type { SupervisionIdentity } from "@/protocol/schemas";
import { KernelToolCatalog, type CatalogEntry } from "@/tool-catalog";
import { connectRemoteDocument, PrivatePeerHub, type PlaneSocket, YjsServer } from "@/yjs";
import { documentImagePath } from "@/yjs/storage";

import { RuntimeServer } from "../compose.js";

const temps: string[] = [];
const modes: Array<{ path: string; mode: number }> = [];

afterEach(() => {
  for (const entry of modes.splice(0)) {
    try {
      chmodSync(entry.path, entry.mode);
    } catch {}
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => resetLocalIDs());

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "runtime-server-"));
  temps.push(root);
  return root;
}

function yjsIdentity(serverEpoch = 1): SupervisionIdentity {
  return {
    hypervisor: { kind: "hypervisor", id: "hv-1" },
    process: { kind: "yjs", id: "yjs-1" },
    serverEpoch,
    runtimeGeneration: 4,
    connectionEpoch: 0,
  };
}

function runtimeIdentity(serverEpoch = 1): SupervisionIdentity {
  return {
    hypervisor: { kind: "hypervisor", id: "hv-1" },
    process: { kind: "runtime", id: "rt-1" },
    serverEpoch,
    runtimeGeneration: 4,
    connectionEpoch: 0,
  };
}

function pairSockets(): { server: PlaneSocket; client: PlaneSocket } {
  const aBins: Array<(frame: Uint8Array) => void> = [];
  const bBins: Array<(frame: Uint8Array) => void> = [];
  const aClose: Array<() => void> = [];
  const bClose: Array<() => void> = [];
  const state = { a: false, b: false };

  function shutdown(side: "a" | "b"): void {
    if (state.a && state.b) return;
    const first = !state.a && !state.b;
    state.a = true;
    state.b = true;
    if (first || side === "a") for (const handler of aClose) handler();
    if (first || side === "b") for (const handler of bClose) handler();
  }

  return {
    server: {
      send: (frame) => {
        if (state.a || state.b) return;
        for (const handler of bBins) handler(frame);
      },
      sendText: () => undefined,
      close: () => shutdown("a"),
      onBinary: (handler) => {
        aBins.push(handler);
      },
      onText: () => undefined,
      onClose: (handler) => {
        aClose.push(handler);
      },
    },
    client: {
      send: (frame) => {
        if (state.a || state.b) return;
        for (const handler of aBins) handler(frame);
      },
      sendText: () => undefined,
      close: () => shutdown("b"),
      onBinary: (handler) => {
        bBins.push(handler);
      },
      onText: () => undefined,
      onClose: (handler) => {
        bClose.push(handler);
      },
    },
  };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function botCall(wireName: string): CatalogEntry {
  return {
    wireName,
    description: wireName,
    parameters: { type: "object", properties: {} },
    class: "effect",
    source: { kind: "pack", pluginName: "pack" },
    packMeta: {
      kind: "bot-call",
      pluginName: "pack",
      target: "worker",
      background: true,
      lifetime: "call",
      show: "result",
      supportsNotify: false,
    },
  };
}

function closedTurn(child: BotCallJob | SystemToolJob): SessionTurn {
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    queue: [],
    reducerExited: true,
  });
  turn.pushChild(child);
  return turn;
}

function emptyTables() {
  return { connections: {}, drivers: {} };
}

async function connectRuntime(root: string, catalog?: KernelToolCatalog) {
  const yjs = new YjsServer({ root, serverEpoch: 1 });
  const hub = new PrivatePeerHub(yjs, {
    capability: "secret",
    identity: yjsIdentity(),
  });
  const sockets = pairSockets();
  hub.accept(sockets.server);
  const connected = await connectRemoteDocument(sockets.client, {
    capability: "secret",
    identity: runtimeIdentity(),
  });
  expect(connected.ok).toBe(true);
  if (!connected.ok) throw new Error("connect failed");
  const server = new RuntimeServer({
    adapter: connected.adapter,
    registry: openDriverRegistry([]),
    catalog,
  });
  onTestFinished(() => {
    server[Symbol.dispose]();
    hub[Symbol.dispose]();
    yjs[Symbol.dispose]();
  });
  return { yjs, hub, server, adapter: connected.adapter };
}

describe("runtime-server over the private remote adapter", () => {
  it("round-trips kernel and session docs through distinct replicas with a covering flush", async () => {
    const { yjs, server, adapter } = await connectRuntime(tempRoot());
    server.bind(emptyTables());
    const kernel = await server.acquireKernel();
    const session = await server.acquireSession("s1");
    session.root.applyKvs([{ form: "kv-set", key: "mark", value: "hello" }]);
    await drain();
    const sessionKey = documentKey("sessions", "s1");
    const checkpoint = adapter.checkpoint(sessionKey)!;
    const flushed = await adapter.flush(sessionKey, checkpoint);
    const kernelRef = adapter.getLoaded(KERNEL_DOCUMENT_KEY);
    const sessionRef = adapter.getLoaded(sessionKey);
    expect({
      documents: server.runtime.documents === adapter,
      kernelDistinct: kernelRef?.doc !== yjs.getLoaded(KERNEL_DOCUMENT_KEY)?.doc,
      sessionDistinct: sessionRef?.doc !== yjs.getLoaded(sessionKey)?.doc,
      kernelLive: kernelRef?.doc === kernel.doc,
      sessionLive: sessionRef?.doc === session.doc,
      mark: session.root.kvs.mark,
      ok: flushed.ok,
      covers: flushed.ok && receiptCoversCheckpoint(flushed.receipt, checkpoint),
    }).toEqual({
      documents: true,
      kernelDistinct: true,
      sessionDistinct: true,
      kernelLive: true,
      sessionLive: true,
      mark: "hello",
      ok: true,
      covers: true,
    });
  });

  it("completes hydration and recover before activate starts catalog observers", async () => {
    const catalog = new KernelToolCatalog();
    onTestFinished(() => catalog[Symbol.dispose]());
    const { server } = await connectRuntime(tempRoot(), catalog);
    server.bind(emptyTables());
    expect({
      activated: server.runtime.activated,
      host: catalog.connectionHost,
    }).toEqual({ activated: false, host: undefined });
    await server.acquireKernel();
    await server.acquireSession("s1");
    expect(() => server.activate()).toThrow(/recover before activate/);
    expect({
      activated: server.runtime.activated,
      recovered: server.recovered,
      host: catalog.connectionHost,
    }).toEqual({ activated: false, recovered: false, host: undefined });
    server.recover();
    expect({
      activated: server.runtime.activated,
      recovered: server.recovered,
      host: catalog.connectionHost,
    }).toEqual({ activated: false, recovered: true, host: undefined });
    server.activate();
    expect({
      activated: server.runtime.activated,
      host: catalog.connectionHost === undefined ? "missing" : "bound",
    }).toEqual({ activated: true, host: "bound" });
  });

  it("a reconnect resumes a bot call; its join waits on the re-run delivery", async () => {
    const catalog = new KernelToolCatalog();
    catalog.replacePack([botCall("offload")]);
    onTestFinished(() => catalog[Symbol.dispose]());
    const root = tempRoot();
    const yjs = new YjsServer({ root, serverEpoch: 1 });
    const hub = new PrivatePeerHub(yjs, {
      capability: "secret",
      identity: yjsIdentity(),
    });
    const firstPair = pairSockets();
    hub.accept(firstPair.server);
    const first = await connectRemoteDocument(firstPair.client, {
      capability: "secret",
      identity: runtimeIdentity(),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const server = new RuntimeServer({
      adapter: first.adapter,
      registry: openDriverRegistry([]),
      catalog,
    });
    onTestFinished(() => {
      server[Symbol.dispose]();
      hub[Symbol.dispose]();
      yjs[Symbol.dispose]();
    });
    server.bind(emptyTables());
    const session = await server.acquireSession("s1");
    const call = new BotCallJob({
      name: "offload",
      background: true,
      orchestrationResult: true,
      acceptedAt: 1,
      preparedInputJson: JSON.stringify({ prepared: true }),
      workerSessionId: "worker",
    });
    session.root.head = closedTurn(call);
    await drain();
    const key = documentKey("sessions", "s1");
    const checkpoint = server.documents.checkpoint(key);
    expect(checkpoint).not.toBeUndefined();
    const gated = await server.documents.flush(key, checkpoint!);
    expect(gated.ok).toBe(true);
    server.recover();

    const secondPair = pairSockets();
    hub.accept(secondPair.server);
    const second = await connectRemoteDocument(secondPair.client, {
      capability: "secret",
      identity: runtimeIdentity(),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.adapter.connectionEpoch).not.toBe(first.adapter.connectionEpoch);
    await drain();
    const recovered = await server.reconnect(second.adapter);
    const row = recovered.find((item) => item.kind === "harness:job:bot-call");
    const resumed = row?.job instanceof BotCallJob ? row.job : undefined;
    expect({
      epoch: second.adapter.connectionEpoch,
      action: row?.action,
      join: resumed != null && joinReleased(resumed, catalog),
      activated: server.runtime.activated,
    }).toEqual({
      epoch: 2,
      action: "resume-inner",
      join: false,
      activated: false,
    });
  });

  it("an acquire in flight across reconnect lands on the new adapter", async () => {
    const root = tempRoot();
    const yjs = new YjsServer({ root, serverEpoch: 1 });
    const hub = new PrivatePeerHub(yjs, { capability: "secret", identity: yjsIdentity() });
    const firstPair = pairSockets();
    hub.accept(firstPair.server);
    const first = await connectRemoteDocument(firstPair.client, { capability: "secret", identity: runtimeIdentity() });
    if (!first.ok) throw new Error("connect failed");
    const server = new RuntimeServer({ adapter: first.adapter, registry: openDriverRegistry([]) });
    onTestFinished(() => {
      server[Symbol.dispose]();
      hub[Symbol.dispose]();
      yjs[Symbol.dispose]();
    });
    server.bind(emptyTables());
    const secondPair = pairSockets();
    hub.accept(secondPair.server);
    const second = await connectRemoteDocument(secondPair.client, {
      capability: "secret",
      identity: runtimeIdentity(),
    });
    if (!second.ok) throw new Error("connect failed");
    const staleKernel = server.acquireKernel();
    const staleSession = server.acquireSession("s2");
    const reconnected = server.reconnect(second.adapter);
    const [kernel, session] = await Promise.all([staleKernel, staleSession]);
    await reconnected;
    expect({
      kernel: kernel.doc === second.adapter.getLoaded(KERNEL_DOCUMENT_KEY)?.doc,
      liveKernel: server.kernel === kernel,
      session: session.doc === second.adapter.getLoaded(documentKey("sessions", "s2"))?.doc,
      interned: server.runtime.replica("s2") === session,
    }).toEqual({ kernel: true, liveKernel: true, session: true, interned: true });
  });

  it("failed remote flush is not dispatch", async () => {
    const root = tempRoot();
    const { server } = await connectRuntime(root);
    server.bind(emptyTables());
    const session = await server.acquireSession("s1");
    const job = new SystemToolJob({
      toolCallId: "c1",
      name: "read_file",
      argsJson: "{}",
      orchestrationResult: true,
    });
    session.root.head = closedTurn(job);
    await drain();
    const key = documentKey("sessions", "s1");
    const image = documentImagePath(root, key);
    modes.push({ path: image, mode: 0o600 });
    chmodSync(image, 0o400);
    const checkpoint = server.documents.checkpoint(key);
    expect(checkpoint).not.toBeUndefined();
    const flushed = await server.documents.flush(key, checkpoint!);
    chmodSync(image, 0o600);
    expect({
      flushed,
      dispatch: flushed.ok,
      outcome: job.receiptJson,
      completed: job.completed,
    }).toEqual({
      flushed: { ok: false, reason: "storage-failed" },
      dispatch: false,
      outcome: null,
      completed: false,
    });
  });
});
