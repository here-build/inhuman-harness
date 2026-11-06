import {
  applyUpdate,
  createDoc,
  encodeStateAsUpdate,
  encodeStateVector,
  type Doc,
} from "@inhuman.tools/harness-peer";
import { describe, expect, it, vi } from "vitest";

import {
  cacheKey,
  CACHE_ORIGIN,
  guardProvider,
  holdsBeyond,
  readVarUint,
  writeBehind,
  type DocCache,
} from "../doc-cache.js";

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
function client(cached: Doc | null) {
  const doc = createDoc();
  if (cached != null) applyUpdate(doc, encodeStateAsUpdate(cached), CACHE_ORIGIN);
  const applied: Uint8Array[] = [];
  const replies: unknown[] = [];
  const provider = {
    messageHandlers: [
      (_encoder: unknown, decoder: { arr: Uint8Array; pos: number }) => {
        // The stock handler would reply to a STEP1 with the doc's diff; recording that is the point.
        if (decoder.arr[1] === 0) replies.push("step2-to-server");
        else {
          const [length, start] = readVarUint(decoder.arr, 2);
          const update = decoder.arr.subarray(start, start + length);
          applied.push(update);
          applyUpdate(doc, update);
        }
      },
    ] as Array<(...args: [unknown, { arr: Uint8Array; pos: number }]) => void>,
  };
  const stale = vi.fn();
  guardProvider(provider, doc, cached != null, () => false, stale);
  const receive = (message: { arr: Uint8Array; pos: number }): void => provider.messageHandlers[0]?.({}, message);
  return { doc, stale, receive, applied, replies };
}

function server(): Doc {
  const doc = createDoc();
  doc.getMap("root").set("a", "1");
  return doc;
}

describe("holdsBeyond", () => {
  it("is false for an equal doc and for a subset, true for a superset", () => {
    const daemon = server();
    const equal = createDoc();
    applyUpdate(equal, encodeStateAsUpdate(daemon));
    expect(holdsBeyond(equal, encodeStateVector(daemon))).toBe(false);
    expect(holdsBeyond(createDoc(), encodeStateVector(daemon))).toBe(false);
    const ahead = createDoc();
    applyUpdate(ahead, encodeStateAsUpdate(daemon));
    ahead.getMap("root").set("b", "2");
    expect(holdsBeyond(ahead, encodeStateVector(daemon))).toBe(true);
  });

  it("is true for a doc from another incarnation of the daemon", () => {
    expect(holdsBeyond(server(), encodeStateVector(server()))).toBe(true);
  });
});

describe("guardProvider", () => {
  it("cache superset of the server: stale, nothing applied, nothing pushed", () => {
    const daemon = server();
    const cached = createDoc();
    applyUpdate(cached, encodeStateAsUpdate(daemon));
    cached.getMap("root").set("ghost", "gone from the daemon");
    const c = client(cached);
    c.receive(frame(0, encodeStateVector(daemon)));
    c.receive(frame(1, encodeStateAsUpdate(daemon, encodeStateVector(cached))));
    expect(c.stale).toHaveBeenCalledOnce();
    expect(c.stale).toHaveBeenCalledWith(false);
    expect(c.replies).toEqual([]);
    expect(c.applied).toEqual([]);
  });

  it("cache subset: takes only the delta and never answers the daemon's STEP1", () => {
    const daemon = server();
    const cached = createDoc();
    applyUpdate(cached, encodeStateAsUpdate(daemon));
    daemon.getMap("root").set("later", "2");
    const delta = encodeStateAsUpdate(daemon, encodeStateVector(cached));
    const c = client(cached);
    c.receive(frame(0, encodeStateVector(daemon)));
    c.receive(frame(1, delta));
    expect(c.stale).not.toHaveBeenCalled();
    expect(c.replies).toEqual([]);
    expect(c.applied).toHaveLength(1);
    expect(c.applied[0]?.length).toBe(delta.length);
    expect(Object.fromEntries(c.doc.getMap("root"))).toEqual({ a: "1", later: "2" });
  });

  it("equal: nothing to fetch, not stale", () => {
    const daemon = server();
    const c = client(daemon);
    c.receive(frame(0, encodeStateVector(daemon)));
    c.receive(frame(1, encodeStateAsUpdate(daemon, encodeStateVector(c.doc))));
    expect(c.stale).not.toHaveBeenCalled();
    expect(c.replies).toEqual([]);
  });

  it("a cached doc cannot be checked against a daemon that sends data before its vector", () => {
    const c = client(server());
    c.receive(frame(1, encodeStateAsUpdate(server())));
    expect(c.stale).toHaveBeenCalledWith(false);
    expect(c.applied).toEqual([]);
  });

  it("a cold doc needs no vector", () => {
    const daemon = server();
    const c = client(null);
    c.receive(frame(1, encodeStateAsUpdate(daemon)));
    expect(c.stale).not.toHaveBeenCalled();
    expect(Object.fromEntries(c.doc.getMap("root"))).toEqual({ a: "1" });
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
    const doc = createDoc();
    const w = writeBehind(cache, "k", doc, [], SOURCE);
    applyUpdate(doc, encodeStateAsUpdate(server()), CACHE_ORIGIN);
    expect(calls).toEqual([]);
    applyUpdate(doc, encodeStateAsUpdate(server()), SOURCE);
    expect(calls).toEqual(["append"]);
    doc.getMap("root").set("local", 1); // a write of this doc's own is not the daemon's to hold
    expect(calls).toEqual(["append"]);
    w.release(false);
    doc.getMap("root").set("x", 1);
    expect(calls).toEqual(["append"]);
  });

  it("compacts a long log once, and the first full sync does not count as a tail", () => {
    const { cache, calls } = memory();
    const doc = createDoc();
    const w = writeBehind(cache, "k", doc, [], SOURCE);
    applyUpdate(doc, encodeStateAsUpdate(server()), SOURCE);
    w.synced();
    expect(calls).toEqual(["append"]);
    for (let i = 0; i < 205; i++) {
      const peer = createDoc();
      peer.getMap("root").set(`k${i}`, i);
      applyUpdate(doc, encodeStateAsUpdate(peer), SOURCE);
    }
    expect(calls.filter((c) => c === "replace")).toHaveLength(1);
  });

  it("a compacted state leaves out the doc's own writes", () => {
    const { cache, calls } = memory();
    const replaced: Uint8Array[] = [];
    cache.replace = (_key, state) => replaced.push(state);
    const doc = createDoc();
    const loaded = Array.from({ length: 40 }, () => new Uint8Array(4));
    const writer = writeBehind(cache, "k", doc, loaded, SOURCE);
    doc.getMap("root").set("local", 1);
    writer.synced();
    expect(replaced).toHaveLength(1);
    expect(calls).toEqual([]);
    const fresh = createDoc();
    applyUpdate(fresh, replaced[0] ?? new Uint8Array());
    expect(Object.fromEntries(fresh.getMap("root"))).toEqual({});
  });

  it("rewrites a long loaded log after sync", () => {
    const { cache, calls } = memory();
    const doc = createDoc();
    const loaded = Array.from({ length: 40 }, () => new Uint8Array(4));
    writeBehind(cache, "k", doc, loaded, SOURCE).synced();
    expect(calls).toEqual(["replace"]);
  });
});
