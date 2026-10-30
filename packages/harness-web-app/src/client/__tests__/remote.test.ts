import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebsocketProvider } from "y-websocket";

import { isRefusal, linkForClose, PING, PING_MS, startPing } from "../remote.js";

vi.mock("@inhuman.tools/harness-peer", () => ({ bindTextFrames: vi.fn() }));

afterEach(() => vi.useRealTimers());

describe("linkForClose", () => {
  it("4503 is offline, redialing or not", () => {
    expect(linkForClose(4503, "offline", true)).toEqual({ kind: "offline", redialing: true });
    expect(linkForClose(4503, "offline", false)).toEqual({ kind: "offline", redialing: false });
  });
  it("4504 redials, or reads as no answer before the first sync", () => {
    expect(linkForClose(4504, "", true)).toEqual({ kind: "reconnecting" });
    expect(linkForClose(4504, "", false)).toEqual({ kind: "unanswered" });
  });
  it("4400, 4404 and 4500 stop with the reason", () => {
    for (const code of [4400, 4404, 4500]) {
      expect(isRefusal(code)).toBe(true);
      expect(linkForClose(code, "no such room", true)).toEqual({ kind: "unavailable", reason: "no such room" });
    }
  });
  it("other closes mean nothing special", () => {
    for (const code of [1000, 1006, 1012, 4401]) expect(linkForClose(code, "", true)).toBeNull();
    expect(isRefusal(4503)).toBe(false);
  });
});

describe("startPing", () => {
  it("pings the current socket every 10 s while open, until stopped", () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const provider = { ws: { readyState: 1, send: (text: string) => sent.push(text) } } as unknown as WebsocketProvider;
    const stop = startPing(provider);
    vi.advanceTimersByTime(PING_MS * 2);
    expect(sent).toEqual([PING, PING]);
    (provider.ws as unknown as { readyState: number }).readyState = 0;
    vi.advanceTimersByTime(PING_MS);
    expect(sent).toHaveLength(2);
    stop();
    (provider.ws as unknown as { readyState: number }).readyState = 1;
    vi.advanceTimersByTime(PING_MS * 3);
    expect(sent).toHaveLength(2);
  });
  it("skips while there is no socket", () => {
    vi.useFakeTimers();
    const stop = startPing({ ws: null } as unknown as WebsocketProvider);
    expect(() => vi.advanceTimersByTime(PING_MS)).not.toThrow();
    stop();
  });
});
