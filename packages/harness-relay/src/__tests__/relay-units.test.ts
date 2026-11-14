import { describe, expect, it } from "vitest";

import { encodePresenceRemoval, readPresenceEntries, routeBrowserPlane, routeDaemonPlane } from "../plane.js";
import { parseRoom, roomKey, tagKey } from "../room.js";
import { restoreResponse, rewriteRequest } from "../rpc.js";

describe("room keys", () => {
  it("sorts the query and keeps the original", () => {
    expect(roomKey("/session?sessionId=s1&path=%2Fp")).toBe(roomKey("/session?path=%2Fp&sessionId=s1"));
    expect(parseRoom("/kernel")).toEqual({ original: "/kernel", key: "/kernel" });
    expect(parseRoom("/project?path=%2Fa")?.original).toBe("/project?path=%2Fa");
  });
  it("only admits the daemon's upgrade paths and sane lengths", () => {
    expect(parseRoom("/other")).toBeNull();
    expect(parseRoom("/kernel/extra")).toBeNull();
    expect(parseRoom(`/project?path=${"a".repeat(1000)}`)).toBeNull();
  });
  it("keeps tags within 256 characters", () => {
    expect(tagKey("/kernel")).toBe("/kernel");
    const long = `/project?path=${"x".repeat(800)}`;
    expect(`browser:${tagKey(long)}`.length).toBeLessThan(256);
    expect(tagKey(long)).not.toBe(tagKey(`${long}y`));
  });
});

describe("rpc id rewriting", () => {
  const tag = "0123456789ab";
  const through = (id: unknown) => {
    const out = rewriteRequest(JSON.stringify({ jsonrpc: "2.0", id, method: "m", params: { a: 1 } }), tag);
    if (out.kind !== "forward") throw new Error("expected forward");
    const sent = JSON.parse(out.text) as { id: string };
    expect(sent.id.startsWith(`${tag}:`)).toBe(true);
    const back = restoreResponse(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: 5 }));
    if (back.kind !== "to") throw new Error("expected to");
    expect(back.clientTag).toBe(tag);
    return JSON.parse(back.text) as { id: unknown; result: number };
  };
  it("round-trips numeric, string, colon-bearing and null ids", () => {
    expect(through(7)).toEqual({ jsonrpc: "2.0", id: 7, result: 5 });
    expect(through("a:b")).toMatchObject({ id: "a:b" });
    expect(through("7")).toMatchObject({ id: "7" });
    expect(through(null)).toMatchObject({ id: null });
  });
  it("leaves notifications untouched and broadcasts daemon notifications", () => {
    const note = JSON.stringify({ jsonrpc: "2.0", method: "n" });
    expect(rewriteRequest(note, tag)).toEqual({ kind: "forward", text: note });
    expect(restoreResponse(note)).toEqual({ kind: "broadcast", text: note });
  });
  it("answers malformed requests locally, drops what it cannot route", () => {
    expect(rewriteRequest("{", tag)).toMatchObject({ kind: "reply" });
    expect(rewriteRequest("[1]", tag)).toMatchObject({ kind: "reply" });
    const bad = rewriteRequest(JSON.stringify({ id: 3 }), tag);
    expect(bad.kind === "reply" && JSON.parse(bad.text)).toMatchObject({ id: 3, error: { code: -32_600 } });
    expect(rewriteRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }), tag)).toEqual({ kind: "drop" });
    expect(restoreResponse(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }))).toEqual({ kind: "drop" });
    expect(restoreResponse("nope")).toEqual({ kind: "drop" });
  });
});

describe("plane routing and presence codec", () => {
  const tag = "abcdef012345";

  it("rewrites shape/subscribe and restores shape/delta subscriptionId per clientTag", () => {
    const sub = routeBrowserPlane(
      JSON.stringify({
        kind: "shape/subscribe",
        subscriptionId: "sub:colon",
        lane: "session_nodes",
        params: { sessionId: "s1" },
        offset: 4,
      }),
      tag,
    );
    expect(sub.kind).toBe("subscribe");
    if (sub.kind !== "subscribe") throw new Error("expected subscribe");
    expect(JSON.parse(sub.daemonText)).toEqual({
      kind: "shape/subscribe",
      subscriptionId: `${tag}:sub:colon`,
      lane: "session_nodes",
      params: { sessionId: "s1" },
      offset: 4,
    });

    const delta = routeDaemonPlane(
      JSON.stringify({
        kind: "shape/delta",
        subscriptionId: `${tag}:sub:colon`,
        lane: "session_nodes",
        offset: 5,
        reset: false,
        upserts: [{ id: "1" }],
        deletes: [],
        upToDate: true,
      }),
    );
    expect(delta.kind).toBe("to");
    if (delta.kind !== "to") throw new Error("expected targeted delta");
    expect(delta.clientTag).toBe(tag);
    expect(JSON.parse(delta.text)).toMatchObject({
      kind: "shape/delta",
      subscriptionId: "sub:colon",
      offset: 5,
    });
  });

  it("drops browser-forged shape/delta and presence/state while answering ping", () => {
    expect(routeBrowserPlane('{"kind":"shape/delta","subscriptionId":"s1"}', tag)).toEqual({ kind: "drop" });
    expect(routeBrowserPlane('{"kind":"presence/state","entries":[]}', tag)).toEqual({ kind: "drop" });
    expect(routeBrowserPlane('{"kind":"ping","ts":99}', tag)).toEqual({
      kind: "reply",
      text: '{"kind":"pong","ts":99}',
    });
  });

  it("reads announced presence entries and builds a removal one clock ahead", () => {
    expect(readPresenceEntries([[42, { a: 1 }, 3]])).toEqual([{ id: 42, clock: 3, removed: false }]);
    expect(readPresenceEntries([[42, null, 4]])).toEqual([{ id: 42, clock: 4, removed: true }]);
    const removal = JSON.parse(
      encodePresenceRemoval([
        [1, 5],
        [2, 9],
      ]),
    ) as { kind: string; entries: unknown };
    expect(removal.kind).toBe("presence/update");
    expect(readPresenceEntries(removal.entries)).toEqual([
      { id: 1, clock: 6, removed: true },
      { id: 2, clock: 10, removed: true },
    ]);
  });
});
