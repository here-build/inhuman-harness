import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { cacheKey, CACHE_ORIGIN, guardProvider, holdsBeyond, writeBehind, type DocCache } from "../doc-cache.js";

function varUint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

/** `[messageSync, kind, varUint8Array(payload)]`: STEP1 is kind 0, STEP2 kind 1, update kind 2. */
function frame(kind: 0 | 1 | 2, payload: Uint8Array): { arr: Uint8Array; pos: number } {
  return { arr: Uint8Array.from([0, kind, ...varUint(payload.length), ...payload]), pos: 1 };
}

/** A client doc started from `cached`, a fake provider whose default handler applies STEP2 like y-websocket. */
function client(cached: Y.Doc | null) {
  const doc = new Y.Doc();
  if (cached != null) Y.applyUpdate(doc, Y.encodeStateAsUpdate(cached), CACHE_ORIGIN);
  const applied: Uint8Array[] = [];
  const replies: unknown[] = [];
  const provider = {
    messageHandlers: [
      (_encoder: unknown, decoder: { arr: Uint8Array; pos: number }) => {
        // The stock handler would reply to a STEP1 with the doc's diff; recording that is the point.
        if (decoder.arr[1] === 0) replies.push("step2-to-server");
        else {
          const length = decoder.arr[2] ?? 0;
          const update = decoder.arr.subarray(3, 3 + length);
          applied.push(update);
          Y.applyUpdate(doc, update);
        }
      },
    ] as Array<(...args: [unknown, { arr: Uint8Array; pos: number }]) => void>,
  };
  const stale = vi.fn();
  guardProvider(provider, doc, cached != null, () => false, stale);
  const receive = (message: { arr: Uint8Array; pos: number }): void => provider.messageHandlers[0]?.({}, message);
  return { doc, stale, receive, applied, replies };
}

function server(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap("root").set("a", "1");
  return doc;
}

describe("holdsBeyond", () => {
  it("is false for an equal doc and for a subset, true for a superset", () => {
    const daemon = server();
    const equal = new Y.Doc();
    Y.applyUpdate(equal, Y.encodeStateAsUpdate(daemon));
    expect(holdsBeyond(equal, Y.encodeStateVector(daemon))).toBe(false);
    expect(holdsBeyond(new Y.Doc(), Y.encodeStateVector(daemon))).toBe(false);
    const ahead = new Y.Doc();
    Y.applyUpdate(ahead, Y.encodeStateAsUpdate(daemon));
    ahead.getMap("root").set("b", "2");
    expect(holdsBeyond(ahead, Y.encodeStateVector(daemon))).toBe(true);
  });

  it("is true for a doc from another incarnation of the daemon", () => {
    expect(holdsBeyond(server(), Y.encodeStateVector(server()))).toBe(true);
  });
});

describe("guardProvider", () => {
  it("cache superset of the server: stale, nothing applied, nothing pushed", () => {
    const daemon = server();
    const cached = new Y.Doc();
    Y.applyUpdate(cached, Y.encodeStateAsUpdate(daemon));
    cached.getMap("root").set("ghost", "gone from the daemon");
    const c = client(cached);
    c.receive(frame(0, Y.encodeStateVector(daemon)));
    c.receive(frame(1, Y.encodeStateAsUpdate(daemon, Y.encodeStateVector(cached))));
    expect(c.stale).toHaveBeenCalledOnce();
    expect(c.stale).toHaveBeenCalledWith(false);
    expect(c.replies).toEqual([]);
    expect(c.applied).toEqual([]);
  });

  it("cache subset: takes only the delta and never answers the daemon's STEP1", () => {
    const daemon = server();
    const cached = new Y.Doc();
    Y.applyUpdate(cached, Y.encodeStateAsUpdate(daemon));
    daemon.getMap("root").set("later", "2");
    const delta = Y.encodeStateAsUpdate(daemon, Y.encodeStateVector(cached));
    const c = client(cached);
    c.receive(frame(0, Y.encodeStateVector(daemon)));
    c.receive(frame(1, delta));
    expect(c.stale).not.toHaveBeenCalled();
    expect(c.replies).toEqual([]);
    expect(c.applied).toHaveLength(1);
    expect(c.applied[0]?.length).toBe(delta.length);
    expect(c.doc.getMap("root").toJSON()).toEqual({ a: "1", later: "2" });
  });

  it("equal: nothing to fetch, not stale", () => {
    const daemon = server();
    const c = client(daemon);
    c.receive(frame(0, Y.encodeStateVector(daemon)));
    c.receive(frame(1, Y.encodeStateAsUpdate(daemon, Y.encodeStateVector(c.doc))));
    expect(c.stale).not.toHaveBeenCalled();
    expect(c.replies).toEqual([]);
  });

  it("a cached doc cannot be checked against a daemon that sends data before its vector", () => {
    const c = client(server());
    c.receive(frame(1, Y.encodeStateAsUpdate(server())));
    expect(c.stale).toHaveBeenCalledWith(false);
    expect(c.applied).toEqual([]);
  });

  it("a cold doc needs no vector", () => {
    const daemon = server();
    const c = client(null);
    c.receive(frame(1, Y.encodeStateAsUpdate(daemon)));
    expect(c.stale).not.toHaveBeenCalled();
    expect(c.doc.getMap("root").toJSON()).toEqual({ a: "1" });
  });
});

describe("cacheKey", () => {
  it("names the daemon, the room and its identity, not a minting path", () => {
    expect(cacheKey("ws://a", "kernel", {})).toBe("ws://a|kernel");
    expect(cacheKey("ws://a", "project", { path: "/p" })).toBe("ws://a|project:/p");
    expect(cacheKey("ws://a", "session", { sessionId: "s", path: "/p" })).toBe("ws://a|session:s");
  });
});

describe("writeBehind", () => {
  const SOURCE = Symbol("provider");
  function memory() {
    const calls: string[] = [];
    const cache: DocCache = {
      load: async () => null,
      append: () => calls.push("append"),
      replace: () => calls.push("replace"),
      drop: () => calls.push("drop"),
    };
    return { cache, calls };
  }

  it("appends what the daemon sent, not what the cache supplied", () => {
    const { cache, calls } = memory();
    const doc = new Y.Doc();
    const w = writeBehind(cache, "k", doc, [], SOURCE);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server()), CACHE_ORIGIN);
    expect(calls).toEqual([]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server()), SOURCE);
    expect(calls).toEqual(["append"]);
    doc.getMap("root").set("local", 1); // a write of this doc's own is not the daemon's to hold
    expect(calls).toEqual(["append"]);
    w.release(false);
    doc.getMap("root").set("x", 1);
    expect(calls).toEqual(["append"]);
  });

  it("compacts a long log once, and the first full sync does not count as a tail", () => {
    const { cache, calls } = memory();
    const doc = new Y.Doc();
    const w = writeBehind(cache, "k", doc, [], SOURCE);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server()), SOURCE);
    w.synced();
    expect(calls).toEqual(["append"]);
    for (let i = 0; i < 205; i++) {
      const peer = new Y.Doc();
      peer.getMap("root").set(`k${i}`, i);
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), SOURCE);
    }
    expect(calls.filter((c) => c === "replace")).toHaveLength(1);
  });

  it("a compacted state leaves out the doc's own writes", () => {
    const { cache, calls } = memory();
    const replaced: Uint8Array[] = [];
    cache.replace = (_key, state) => replaced.push(state);
    const doc = new Y.Doc();
    const loaded = Array.from({ length: 40 }, () => new Uint8Array(4));
    const writer = writeBehind(cache, "k", doc, loaded, SOURCE);
    doc.getMap("root").set("local", 1);
    writer.synced();
    expect(replaced).toHaveLength(1);
    expect(calls).toEqual([]);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, replaced[0] ?? new Uint8Array());
    expect(fresh.getMap("root").toJSON()).toEqual({});
  });

  it("rewrites a long loaded log after sync", () => {
    const { cache, calls } = memory();
    const doc = new Y.Doc();
    const loaded = Array.from({ length: 40 }, () => new Uint8Array(4));
    writeBehind(cache, "k", doc, loaded, SOURCE).synced();
    expect(calls).toEqual(["replace"]);
  });
});
