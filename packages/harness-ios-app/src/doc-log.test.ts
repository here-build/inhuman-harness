import { describe, expect, it } from "vitest";

import { fromBase64, parseLog, toBase64 } from "./doc-log.js";

function record(bytes: number[]): number[] {
  return [0, 0, 0, bytes.length, ...bytes];
}

describe("parseLog", () => {
  it("reads length-prefixed records in order", () => {
    const log = Uint8Array.from([...record([1, 2, 3]), ...record([]), ...record([9])]);
    expect(parseLog(log).map((entry) => [...entry])).toEqual([[1, 2, 3], [], [9]]);
  });

  it("ignores a torn tail from a write that was cut off", () => {
    const whole = record([1, 2, 3]);
    expect(parseLog(Uint8Array.from([...whole, 0, 0, 0, 5, 1, 2])).map((entry) => [...entry])).toEqual([[1, 2, 3]]);
    expect(parseLog(Uint8Array.from([...whole, 0, 0])).length).toBe(1);
  });
});

describe("toBase64", () => {
  it("matches Buffer across chunk boundaries", () => {
    const bytes = new Uint8Array(3 * 8192 * 2 + 7).map((_, at) => (at * 31) % 256);
    expect(toBase64(bytes)).toBe(btoa(Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("")));
  });
});

describe("fromBase64", () => {
  it("round-trips across slice boundaries and padding", () => {
    for (const extra of [0, 1, 2, 7]) {
      const bytes = new Uint8Array(3 * 24576 + extra).map((_, at) => (at * 37) % 256);
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
  });
});
