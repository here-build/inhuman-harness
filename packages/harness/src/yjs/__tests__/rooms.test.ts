import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as encoding from "lib0/encoding";
import { afterEach, describe, expect, it } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

import { applyPeerSyncFrame, documentKey, encodeDocUpdate, MESSAGE_SYNC } from "@/protocol/document";
import { encodeJsonRpcRequest, JSON_RPC_VERSION } from "@/protocol/rpc";

import { documentImagePath, SESSION_ROOT_TYPE } from "../registry/identity.js";
import type { PlaneSocket } from "../relay.js";
import { EXECUTION_UNAVAILABLE_CODE, EXECUTION_UNAVAILABLE_MESSAGE, YjsServer } from "../rooms.js";
import { encodeLogEntry } from "../update-log.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "yjs-rooms-"));
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

function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

function fakeSocket(): {
  socket: PlaneSocket;
  sent: Uint8Array[];
  texts: string[];
  closed: boolean;
  deliver: (frame: Uint8Array) => void;
  deliverText: (text: string) => void;
  disconnect: () => void;
} {
  const sent: Uint8Array[] = [];
  const texts: string[] = [];
  const binaries: Array<(frame: Uint8Array) => void> = [];
  const textHandlers: Array<(text: string) => void> = [];
  const closes: Array<() => void> = [];
  const state = { closed: false };
  const socket: PlaneSocket = {
    send: (frame) => {
      sent.push(frame);
    },
    sendText: (text) => {
      texts.push(text);
    },
    close: () => {
      state.closed = true;
      for (const handler of closes) handler();
    },
    onBinary: (handler) => {
      binaries.push(handler);
    },
    onText: (handler) => {
      textHandlers.push(handler);
    },
    onClose: (handler) => {
      closes.push(handler);
    },
  };
  return {
    socket,
    sent,
    texts,
    get closed() {
      return state.closed;
    },
    deliver: (frame) => {
      for (const handler of binaries) handler(frame);
    },
    deliverText: (text) => {
      for (const handler of textHandlers) handler(text);
    },
    disconnect: () => {
      for (const handler of closes) handler();
    },
  };
}

describe("rooms", () => {
  it("cold-opens an on-disk image without creating a missing identity", async () => {
    const root = tempRoot();
    writeSession(root, "s1", "from-disk");
    const yjs = new YjsServer({ root });
    const key = documentKey("sessions", "s1");
    const missing = documentKey("sessions", "missing");
    expect(yjs.getLoaded(key)).toBeUndefined();
    const opened = await yjs.openExisting(key);
    const absent = await yjs.openExisting(missing);
    expect({
      opened: opened.ok,
      extra: opened.ok ? opened.room.doc.getMap("root").get("extra") : undefined,
      loaded: opened.ok && yjs.getLoaded(key)?.doc === opened.room.doc,
      absent,
      stillMissing: yjs.getLoaded(missing),
    }).toEqual({
      opened: true,
      extra: "from-disk",
      loaded: true,
      absent: { ok: false, reason: "not-found" },
      stillMissing: undefined,
    });
    yjs[Symbol.dispose]();
  });

  it("create is a separate API from open-existing", async () => {
    const yjs = new YjsServer({ root: tempRoot() });
    const key = documentKey("sessions", "s1");
    const before = await yjs.openExisting(key);
    const created = await yjs.create(key, encodeSession("s1", "minted"));
    const again = await yjs.openExisting(key);
    expect({
      before,
      created: created.ok,
      extra: created.ok ? created.ref.doc.getMap("root").get("extra") : undefined,
      same: again.ok && created.ok && again.room.doc === created.ref.doc,
    }).toEqual({
      before: { ok: false, reason: "not-found" },
      created: true,
      extra: "minted",
      same: true,
    });
    yjs[Symbol.dispose]();
  });

  it("occupancy seats join and leave atomically with a monotonic sequence", async () => {
    const root = tempRoot();
    writeSession(root, "s1");
    const yjs = new YjsServer({ root });
    const key = documentKey("sessions", "s1");
    const snapshots: number[] = [];
    const stop = yjs.watchOccupancy((snapshot) => {
      snapshots.push(snapshot.sequence);
    });
    const a = fakeSocket();
    const b = fakeSocket();
    const opened = await yjs.openExisting(key);
    const joinedA = opened.ok && yjs.attach(key, a.socket);
    const joinedB = opened.ok && yjs.attach(key, b.socket);
    const two = yjs.occupancy();
    a.disconnect();
    const one = yjs.occupancy();
    expect({
      joinedA,
      joinedB,
      two: {
        sequence: two.sequence,
        seats: two.seats.map((seat) => seat.sessionId),
      },
      one: {
        sequence: one.sequence,
        seats: one.seats.map((seat) => seat.sessionId),
      },
      watched: snapshots,
    }).toEqual({
      joinedA: true,
      joinedB: true,
      two: { sequence: 2, seats: ["s1", "s1"] },
      one: { sequence: 3, seats: ["s1"] },
      watched: [1, 2, 3],
    });
    stop();
    yjs[Symbol.dispose]();
  });

  it("park releases execution and keeps the room and another consumer's replica", async () => {
    const root = tempRoot();
    writeSession(root, "s1");
    const yjs = new YjsServer({ root });
    const key = documentKey("sessions", "s1");
    const opened = await yjs.openExisting(key);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    opened.room.acquire();
    opened.room.acquire();
    const socket = fakeSocket();
    expect(yjs.attach(key, socket.socket)).toBe(true);
    const doc = opened.room.doc;
    yjs.park(key);
    expect({
      holds: opened.room.executionHolds,
      sockets: opened.room.socketCount,
      closed: opened.room.closed,
      loaded: yjs.getLoaded(key)?.doc === doc,
    }).toEqual({
      holds: 1,
      sockets: 1,
      closed: false,
      loaded: true,
    });
    yjs.park(key);
    expect({
      holds: opened.room.executionHolds,
      sockets: opened.room.socketCount,
      loaded: yjs.getLoaded(key)?.doc === doc,
    }).toEqual({
      holds: 0,
      sockets: 1,
      loaded: true,
    });
    yjs[Symbol.dispose]();
  });

  it("acquire and hold refuse a closed room", async () => {
    const root = tempRoot();
    writeSession(root, "s1");
    const yjs = new YjsServer({ root });
    const opened = await yjs.openExisting(documentKey("sessions", "s1"));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    opened.room.close();
    const socket = fakeSocket();
    expect(() => opened.room.acquire()).toThrow("acquire: disposed");
    expect(() => opened.room.hold(socket.socket)).toThrow("hold: disposed");
    expect({
      closed: opened.room.closed,
      sockets: opened.room.socketCount,
      holds: opened.room.executionHolds,
    }).toEqual({
      closed: true,
      sockets: 0,
      holds: 0,
    });
    yjs[Symbol.dispose]();
  });

  it("two clients cold-open an existing replica; a client update is not taken", async () => {
    const root = tempRoot();
    writeSession(root, "s1", "disk");
    const yjs = new YjsServer({ root });
    const key = documentKey("sessions", "s1");
    const a = fakeSocket();
    const b = fakeSocket();
    await yjs.openExisting(key);
    yjs.attach(key, a.socket);
    yjs.attach(key, b.socket);
    const replicaA = new Y.Doc();
    const replicaB = new Y.Doc();
    // Each seat opens with the replica's own STEP1, so a client can validate a cache.
    a.sent.length = 0;
    b.sent.length = 0;
    a.deliver(encodeSyncStep1(replicaA));
    b.deliver(encodeSyncStep1(replicaB));
    const step2A = a.sent.find((frame) => frame[0] === MESSAGE_SYNC);
    const step2B = b.sent.find((frame) => frame[0] === MESSAGE_SYNC);
    expect(step2A != null && step2B != null).toBe(true);
    if (step2A != null) applyPeerSyncFrame(step2A, replicaA, "test");
    if (step2B != null) applyPeerSyncFrame(step2B, replicaB, "test");
    replicaA.getMap("root").set("live", "yes");
    const update = encodeDocUpdate(Y.encodeStateAsUpdate(replicaA, Y.encodeStateVector(replicaB)));
    a.sent.length = 0;
    b.sent.length = 0;
    a.deliver(update);
    const forwarded = b.sent.find((frame) => frame[0] === MESSAGE_SYNC);
    if (forwarded != null) applyPeerSyncFrame(forwarded, replicaB, "test");
    expect({
      a: replicaA.getMap("root").get("extra"),
      b: replicaB.getMap("root").get("extra"),
      live: replicaB.getMap("root").get("live"),
      echo: a.sent.some((frame) => frame[0] === MESSAGE_SYNC),
    }).toEqual({
      a: "disk",
      b: "disk",
      live: undefined,
      echo: false,
    });
    replicaA.destroy();
    replicaB.destroy();
    yjs[Symbol.dispose]();
  });

  it("drops inbound peer updates that fail applyUpdate", async () => {
    const root = tempRoot();
    const yjs = new YjsServer({
      root,
      budgets: { perDocumentDirty: 800, aggregateDirty: 50_000 },
    });
    const key = documentKey("sessions", "s1");
    const created = await yjs.create(key, encodeSession("s1"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const socket = fakeSocket();
    expect(yjs.attach(key, socket.socket)).toBe(true);
    const overflow = new Y.Doc();
    overflow.getMap("root").set("overflow", "x".repeat(4000));
    socket.deliver(encodeDocUpdate(Y.encodeStateAsUpdate(overflow)));
    overflow.destroy();
    expect({
      overflow: created.ref.doc.getMap("root").has("overflow"),
      dirty: yjs.documents.memory().dirtyBytes,
    }).toEqual({
      overflow: false,
      dirty: 0,
    });
    yjs[Symbol.dispose]();
  });

  it("closes a socket that cannot attach and relays RPC on a live room", async () => {
    const root = tempRoot();
    writeSession(root, "s1");
    const yjs = new YjsServer({ root });
    const key = documentKey("sessions", "s1");
    const missing = fakeSocket();
    expect({
      attached: yjs.attach(key, missing.socket),
      closed: missing.closed,
    }).toEqual({ attached: false, closed: true });
    const opened = await yjs.openExisting(key);
    expect(opened.ok).toBe(true);
    const withHandler = fakeSocket();
    const without = fakeSocket();
    const relayed: string[] = [];
    expect(
      yjs.attach(key, withHandler.socket, async (method) => {
        relayed.push(method);
        return { ok: true, method };
      }),
    ).toBe(true);
    expect(yjs.attach(key, without.socket)).toBe(true);
    withHandler.deliverText(encodeJsonRpcRequest(1, "kv/set", { key: "a", value: "1" }));
    without.deliverText(encodeJsonRpcRequest(2, "kv/set", { key: "a", value: "1" }));
    await Promise.resolve();
    await Promise.resolve();
    expect({
      handled: JSON.parse(withHandler.texts[0]!) as unknown,
      unavailable: JSON.parse(without.texts[0]!) as unknown,
      relayed,
    }).toEqual({
      handled: {
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        result: { ok: true, method: "kv/set" },
      },
      unavailable: {
        jsonrpc: JSON_RPC_VERSION,
        id: 2,
        error: {
          code: EXECUTION_UNAVAILABLE_CODE,
          message: EXECUTION_UNAVAILABLE_MESSAGE,
        },
      },
      relayed: ["kv/set"],
    });
    yjs[Symbol.dispose]();
  });
});
