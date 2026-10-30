import { describe, expect, it } from "vitest";

import { parseRoom, roomKey, tagKey } from "../room.js";
import { restoreResponse, rewriteRequest } from "../rpc.js";
import { awarenessFrame } from "./peers.js";
import { encodeAwarenessRemoval, readAwarenessFrame } from "../sync/awareness.js";

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

describe("awareness codec", () => {
  it("reads announced clients and builds a removal one clock ahead", () => {
    expect(readAwarenessFrame(awarenessFrame(42, 3, { a: 1 }))).toEqual([{ id: 42, clock: 3, removed: false }]);
    expect(readAwarenessFrame(awarenessFrame(42, 4, null))).toEqual([{ id: 42, clock: 4, removed: true }]);
    expect(
      readAwarenessFrame(
        encodeAwarenessRemoval([
          [1, 5],
          [2, 9],
        ]),
      ),
    ).toEqual([
      { id: 1, clock: 6, removed: true },
      { id: 2, clock: 10, removed: true },
    ]);
  });
});
