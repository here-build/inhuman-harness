import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  checkpointOf,
  documentKey,
  encodeBarrierRequest,
  encodeDocUpdate,
  encodePrivateEnvelope,
  receiptCoversCheckpoint,
} from "@/protocol/document";
import type { SupervisionIdentity } from "@/protocol/schemas";

import { PrivatePeerHub } from "../private-peer.js";
import { documentImagePath, SESSION_ROOT_TYPE } from "../registry/identity.js";
import type { PlaneSocket } from "../relay.js";
import { connectRemoteDocument } from "../remote-document.js";
import { EXECUTION_UNAVAILABLE_CODE, EXECUTION_UNAVAILABLE_MESSAGE, YjsServer } from "../rooms.js";
import { DocumentImageStore } from "../storage.js";
import { encodeLogEntry } from "../update-log.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "yjs-private-"));
  temps.push(root);
  return root;
}

function encodeSession(sessionId: string, extra?: string): Uint8Array {
  const doc = new Y.Doc();
  const typeMap = new Y.Map();
  doc.getMap("types").set(SESSION_ROOT_TYPE, typeMap);
  const node = new Y.XmlElement(SESSION_ROOT_TYPE);
  typeMap.set("extract-root", node);
  node.setAttribute("sessionId", sessionId);
  doc.getMap("meta").set("root", "extract-root");
  if (extra != null) doc.getMap("root").set("extra", extra);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

function writeSession(root: string, sessionId: string, extra?: string): void {
  const path = documentImagePath(root, "sessions", sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodeLogEntry(encodeSession(sessionId, extra)));
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

function pairSockets(options?: { deferClose?: boolean }): {
  server: PlaneSocket;
  client: PlaneSocket;
  flushClose: () => void;
} {
  const aBins: Array<(frame: Uint8Array) => void> = [];
  const bBins: Array<(frame: Uint8Array) => void> = [];
  const aText: Array<(text: string) => void> = [];
  const bText: Array<(text: string) => void> = [];
  const aClose: Array<() => void> = [];
  const bClose: Array<() => void> = [];
  const state = { a: false, b: false };
  const delayed: Array<() => void> = [];

  function shutdown(side: "a" | "b"): void {
    const fire = (): void => {
      if (state.a && state.b) return;
      const first = !state.a && !state.b;
      state.a = true;
      state.b = true;
      if (first || side === "a") for (const handler of aClose) handler();
      if (first || side === "b") for (const handler of bClose) handler();
    };
    if (options?.deferClose) {
      delayed.push(fire);
      return;
    }
    fire();
  }

  const server: PlaneSocket = {
    send: (frame) => {
      if (state.a || state.b) return;
      for (const handler of bBins) handler(frame);
    },
    sendText: (text) => {
      if (state.a || state.b) return;
      for (const handler of bText) handler(text);
    },
    close: () => shutdown("a"),
    onBinary: (handler) => {
      aBins.push(handler);
    },
    onText: (handler) => {
      aText.push(handler);
    },
    onClose: (handler) => {
      aClose.push(handler);
    },
  };
  const client: PlaneSocket = {
    send: (frame) => {
      if (state.a || state.b) return;
      for (const handler of aBins) handler(frame);
    },
    sendText: (text) => {
      if (state.a || state.b) return;
      for (const handler of aText) handler(text);
    },
    close: () => shutdown("b"),
    onBinary: (handler) => {
      bBins.push(handler);
    },
    onText: (handler) => {
      bText.push(handler);
    },
    onClose: (handler) => {
      bClose.push(handler);
    },
  };
  return {
    server,
    client,
    flushClose: () => {
      for (const fire of delayed.splice(0)) fire();
    },
  };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("private peer and remote document adapter", () => {
  it("rejects a bad capability and accepts an authenticated runtime", async () => {
    const root = tempRoot();
    writeSession(root, "s1", "disk");
    const yjs = new YjsServer({ root, serverEpoch: 1 });
    const hub = new PrivatePeerHub(yjs, {
      capability: "secret",
      identity: yjsIdentity(),
    });
    const denied = pairSockets();
    hub.accept(denied.server);
    const refused = await connectRemoteDocument(denied.client, {
      capability: "wrong",
      identity: runtimeIdentity(),
    });
    const allowed = pairSockets();
    hub.accept(allowed.server);
    const connected = await connectRemoteDocument(allowed.client, {
      capability: "secret",
      identity: runtimeIdentity(),
    });
    await drain();
    expect({
      refused,
      ok: connected.ok,
      epoch: connected.ok ? connected.adapter.connectionEpoch : 0,
      occupancy: connected.ok ? connected.adapter.occupancy()?.serverEpoch : undefined,
    }).toEqual({
      refused: { ok: false, reason: "unauthorized" },
      ok: true,
      epoch: 1,
      occupancy: 1,
    });
    hub[Symbol.dispose]();
    yjs[Symbol.dispose]();
  });

  it("admits a newer runtime generation after the previous peer detaches", async () => {
    const root = tempRoot();
    const yjs = new YjsServer({ root, serverEpoch: 1 });
    const hub = new PrivatePeerHub(yjs, {
      capability: "secret",
      identity: yjsIdentity(),
    });
    const first = pairSockets();
    hub.accept(first.server);
    const connected = await connectRemoteDocument(first.client, {
      capability: "secret",
      identity: runtimeIdentity(),
    });
    expect(connected.ok).toBe(true);
    const live = pairSockets();
    hub.accept(live.server);
    const busy = await connectRemoteDocument(live.client, {
      capability: "secret",
      identity: {
        ...runtimeIdentity(),
        runtimeGeneration: 5,
        process: { kind: "runtime", id: "rt-2" },
      },
    });
    first.client.close(1000, "test");
    await drain();
    const next = pairSockets();
    hub.accept(next.server);
    const newer = await connectRemoteDocument(next.client, {
      capability: "secret",
      identity: {
        ...runtimeIdentity(),
        runtimeGeneration: 5,
        process: { kind: "runtime", id: "rt-2" },
      },
    });
    const stale = pairSockets();
    hub.accept(stale.server);
    const behind = await connectRemoteDocument(stale.client, {
      capability: "secret",
      identity: {
        ...runtimeIdentity(),
        runtimeGeneration: 3,
        process: { kind: "runtime", id: "rt-3" },
      },
    });
    expect({ busy, newer: newer.ok, behind }).toEqual({
      busy: { ok: false, reason: "busy" },
      newer: true,
      behind: { ok: false, reason: "stale" },
    });
    hub[Symbol.dispose]();
    yjs[Symbol.dispose]();
  });

  it("keeps two real Y.Doc replicas consistent from a durable image", async () => {
    const root = tempRoot();
    writeSession(root, "s1", "disk");
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
    if (!connected.ok) return;
    const key = documentKey("sessions", "s1");
    const opened = await connected.adapter.openExisting(key);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const serverRef = yjs.getLoaded(key);
    opened.ref.doc.getMap("root").set("live", "from-remote");
    await drain();
    serverRef?.doc.getMap("root").set("server", "from-server");
    await drain();
    expect({
      distinct: opened.ref.doc !== serverRef?.doc,
      extra: opened.ref.doc.getMap("root").get("extra"),
      live: serverRef?.doc.getMap("root").get("live"),
      server: opened.ref.doc.getMap("root").get("server"),
      loaded: connected.adapter.getLoaded(key)?.doc === opened.ref.doc,
    }).toEqual({
      distinct: true,
      extra: "disk",
      live: "from-remote",
      server: "from-server",
      loaded: true,
    });
    hub[Symbol.dispose]();
    yjs[Symbol.dispose]();
  });

  it("flush barrier covers the captured prefix and stamps the connection epoch", async () => {
    const root = tempRoot();
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
    if (!connected.ok) return;
    const key = documentKey("sessions", "s1");
    const created = await connected.adapter.create(key, encodeSession("s1"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    created.ref.doc.getMap("root").set("saved", true);
    const checkpoint = connected.adapter.checkpoint(key)!;
    const flushP = connected.adapter.flush(key, checkpoint);
    created.ref.doc.getMap("root").set("later", true);
    const result = await flushP;
    const store = new DocumentImageStore(root);
    const disk = result.ok ? await store.read(key) : undefined;
    const captured = new Y.Doc();
    if (disk != null) Y.applyUpdate(captured, disk);
    expect({
      ok: result.ok,
      covers: result.ok && receiptCoversCheckpoint(result.receipt, checkpoint),
      epoch: result.ok ? result.receipt.connectionEpoch : 0,
      generation: result.ok ? result.receipt.runtimeGeneration : 0,
      saved: captured.getMap("root").get("saved"),
      later: captured.getMap("root").get("later"),
    }).toEqual({
      ok: true,
      covers: true,
      epoch: 1,
      generation: 4,
      saved: true,
      later: undefined,
    });
    captured.destroy();
    hub[Symbol.dispose]();
    yjs[Symbol.dispose]();
  });

  it("applies updates before a later command and does not run a domain interpreter", async () => {
    const root = tempRoot();
    writeSession(root, "s1", "disk");
    const yjs = new YjsServer({ root, serverEpoch: 1 });
    const hub = new PrivatePeerHub(yjs, {
      capability: "secret",
      identity: yjsIdentity(),
      rpc: async (_method, params, key) => {
        const field = (params as { field: string }).field;
        return yjs.getLoaded(key)?.doc.getMap("root").get(field);
      },
    });
    const sockets = pairSockets();
    hub.accept(sockets.server);
    const connected = await connectRemoteDocument(sockets.client, {
      capability: "secret",
      identity: runtimeIdentity(),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    const key = documentKey("sessions", "s1");
    const opened = await connected.adapter.openExisting(key);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    opened.ref.doc.getMap("root").set("seen", "yes");
    const inspected = await connected.adapter.call(key, "inspect", {
      field: "seen",
    });
    const same = pairSockets();
    const noRpc = new YjsServer({ root: tempRoot(), serverEpoch: 1 });
    const noRpcHub = new PrivatePeerHub(noRpc, {
      capability: "secret",
      identity: yjsIdentity(),
    });
    noRpcHub.accept(same.server);
    const authed = await connectRemoteDocument(same.client, {
      capability: "secret",
      identity: runtimeIdentity(),
    });
    expect(authed.ok).toBe(true);
    if (!authed.ok) return;
    const minted = await authed.adapter.create(documentKey("sessions", "s2"), encodeSession("s2"));
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    let unavailable: unknown;
    try {
      await authed.adapter.call(minted.ref.key, "inspect", { field: "extra" });
    } catch (error) {
      unavailable = error;
    }
    expect({
      inspected,
      unavailable:
        unavailable instanceof Error
          ? {
              name: unavailable.name,
              message: unavailable.message,
              code: (unavailable as { code?: number }).code,
            }
          : unavailable,
    }).toEqual({
      inspected: "yes",
      unavailable: {
        name: "RpcClientError",
        message: EXECUTION_UNAVAILABLE_MESSAGE,
        code: EXECUTION_UNAVAILABLE_CODE,
      },
    });
    hub[Symbol.dispose]();
    noRpcHub[Symbol.dispose]();
    yjs[Symbol.dispose]();
    noRpc[Symbol.dispose]();
  });

  it("reconnects the same owner with a new epoch and rejects stale frames", async () => {
    const root = tempRoot();
    writeSession(root, "s1", "disk");
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
    const key = documentKey("sessions", "s1");
    await first.adapter.openExisting(key);
    const secondPair = pairSockets();
    hub.accept(secondPair.server);
    const second = await connectRemoteDocument(secondPair.client, {
      capability: "secret",
      identity: runtimeIdentity(),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const staleFlush = await first.adapter.flush(key);
    const staleOpen = await first.adapter.openExisting(key);
    const staleCreate = await first.adapter.create(documentKey("sessions", "s-closed"));
    await first.adapter.release(key);
    let staleCall: unknown;
    try {
      await first.adapter.call(key, "inspect", { field: "extra" });
    } catch (error) {
      staleCall = error instanceof Error ? error.message : error;
    }
    const closedDoc = new Y.Doc();
    const explicit = checkpointOf(closedDoc, key, 1, 1);
    const staleExplicit = await first.adapter.flush(key, explicit);
    closedDoc.destroy();
    const reopened = await second.adapter.openExisting(key);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    reopened.ref.doc.getMap("root").set("after", "reconnect");
    await drain();
    secondPair.client.send(
      encodePrivateEnvelope({
        connectionEpoch: 1,
        sequence: 1,
        class: "sync",
        document: key,
        payload: encodeDocUpdate(encodeSession("s1", "stale")),
      }),
    );
    await drain();
    expect({
      firstEpoch: first.adapter.connectionEpoch,
      secondEpoch: second.adapter.connectionEpoch,
      hubEpoch: hub.connectionEpoch,
      staleFlush,
      staleOpen,
      staleCreate,
      staleCall,
      staleExplicit,
      extra: yjs.getLoaded(key)?.doc.getMap("root").get("extra"),
      after: yjs.getLoaded(key)?.doc.getMap("root").get("after"),
      stale: yjs.getLoaded(key)?.doc.getMap("root").get("extra") === "stale",
    }).toEqual({
      firstEpoch: 1,
      secondEpoch: 2,
      hubEpoch: 2,
      staleFlush: { ok: false, reason: "disconnected" },
      staleOpen: { ok: false, reason: "not-found" },
      staleCreate: { ok: false, reason: "storage-failed" },
      staleCall: "disconnected",
      staleExplicit: { ok: false, reason: "disconnected" },
      extra: "disk",
      after: "reconnect",
      stale: false,
    });
    hub[Symbol.dispose]();
    yjs[Symbol.dispose]();
  });

  it("drops overload updates and refuses a barrier for another document key", async () => {
    const root = tempRoot();
    const yjs = new YjsServer({
      root,
      serverEpoch: 1,
      budgets: { perDocumentDirty: 800, aggregateDirty: 50_000 },
    });
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
    if (!connected.ok) return;
    const key = documentKey("sessions", "s1");
    const other = documentKey("sessions", "s2");
    const created = await connected.adapter.create(key, encodeSession("s1"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const otherDoc = await connected.adapter.create(other, encodeSession("s2"));
    expect(otherDoc.ok).toBe(true);
    if (!otherDoc.ok) return;
    otherDoc.ref.doc.getMap("root").set("keep", "s2");
    await connected.adapter.flush(other);
    const mismatch = pairSockets();
    hub.accept(mismatch.server);
    const second = await connectRemoteDocument(mismatch.client, {
      capability: "secret",
      identity: runtimeIdentity(),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const opened = await second.adapter.openExisting(other);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const foreign = checkpointOf(opened.ref.doc, other, 1, 2);
    mismatch.client.send(
      encodePrivateEnvelope({
        connectionEpoch: second.adapter.connectionEpoch,
        sequence: 2,
        class: "barrier",
        document: key,
        payload: encodeBarrierRequest({ requestId: 99, checkpoint: foreign }),
      }),
    );
    await drain();
    const store = new DocumentImageStore(root);
    const otherDisk = await store.read(other);
    const otherLive = new Y.Doc();
    if (otherDisk != null) Y.applyUpdate(otherLive, otherDisk);
    expect({
      overflow: yjs.getLoaded(key)?.doc.getMap("root").has("overflow"),
      other: otherLive.getMap("root").get("keep"),
      otherHasForeign: otherLive.getMap("root").has("overflow"),
    }).toEqual({
      overflow: false,
      other: "s2",
      otherHasForeign: false,
    });
    otherLive.destroy();
    hub[Symbol.dispose]();
    yjs[Symbol.dispose]();
  });

  it("does not ack a barrier after an overload update when close is delayed", async () => {
    const root = tempRoot();
    const yjs = new YjsServer({
      root,
      serverEpoch: 1,
      budgets: { perDocumentDirty: 800, aggregateDirty: 50_000 },
    });
    const hub = new PrivatePeerHub(yjs, {
      capability: "secret",
      identity: yjsIdentity(),
    });
    const sockets = pairSockets({ deferClose: true });
    hub.accept(sockets.server);
    const connected = await connectRemoteDocument(sockets.client, {
      capability: "secret",
      identity: runtimeIdentity(),
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    const key = documentKey("sessions", "s1");
    const created = await connected.adapter.create(key, encodeSession("s1"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    created.ref.doc.getMap("root").set("overflow", "x".repeat(4000));
    const flushP = connected.adapter.flush(key);
    let settled: unknown;
    void flushP.then((result) => {
      settled = result;
      return undefined;
    });
    await drain();
    const beforeClose = settled;
    sockets.flushClose();
    expect({
      overflow: yjs.getLoaded(key)?.doc.getMap("root").has("overflow"),
      beforeClose,
      afterClose: await flushP,
    }).toEqual({
      overflow: false,
      beforeClose: undefined,
      afterClose: { ok: false, reason: "disconnected" },
    });
    hub[Symbol.dispose]();
    yjs[Symbol.dispose]();
  });
});
