import { contract, methodOf } from "@inhuman.tools/harness-contract";
import { describe, expect, it } from "vitest";

import { createBlobCache } from "../blobs.js";

const sha = (n: number): string => n.toString(16).padStart(64, "0");

type Call = { readonly method: string; readonly params: unknown };

/** A session port that answers only when the test says so. */
function fakePort() {
  const calls: Call[] = [];
  const waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const request = (method: string, params: unknown): Promise<unknown> => {
    calls.push({ method, params });
    const key = (params as { sha256: string }).sha256;
    return new Promise((resolve, reject) => {
      waiting.set(key, { resolve, reject });
    });
  };
  return {
    calls,
    request,
    answer(hash: string, text: string | null, extra: Record<string, unknown> = {}) {
      waiting.get(hash)?.resolve({
        sha256: hash,
        bytes: text?.length ?? 4,
        mime: text === null ? "image/png" : "text/plain",
        text,
        bytesBase64: text === null ? "AAAA" : null,
        ...extra,
      });
      waiting.delete(hash);
    },
    refuse(hash: string) {
      waiting.get(hash)?.reject(new Error("unknown blob"));
      waiting.delete(hash);
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("createBlobCache", () => {
  it("asks blob/get by the contract's wire name", () => {
    expect(methodOf(contract.session.blob.get)).toBe("blob/get");
  });

  it("serves text after it lands, asks once for concurrent wants, and calls onArrive once", async () => {
    const port = fakePort();
    const arrived: string[] = [];
    const cache = createBlobCache(port.request, (hash) => arrived.push(hash));
    expect(cache.peek(sha(1))).toBeNull();
    cache.want(sha(1));
    cache.want(sha(1));
    cache.want(sha(1));
    expect(port.calls).toEqual([{ method: "blob/get", params: { sha256: sha(1) } }]);
    expect(cache.has(sha(1))).toBe(false);

    port.answer(sha(1), "export const a = 1;\n");
    await settle();
    expect({ text: cache.peek(sha(1)), has: cache.has(sha(1)), size: cache.size, arrived }).toEqual({
      text: "export const a = 1;\n",
      has: true,
      size: 1,
      arrived: [sha(1)],
    });
    cache.want(sha(1));
    expect(port.calls).toHaveLength(1);
  });

  it("holds a blob that is not text as a marker: peek stays null and it is not asked for again", async () => {
    const port = fakePort();
    const arrived: string[] = [];
    const cache = createBlobCache(port.request, (hash) => arrived.push(hash));
    cache.want(sha(2));
    port.answer(sha(2), null);
    await settle();
    expect({ peek: cache.peek(sha(2)), has: cache.has(sha(2)), arrived }).toEqual({
      peek: null,
      has: true,
      arrived: [sha(2)],
    });
    cache.want(sha(2));
    expect(port.calls).toHaveLength(1);
  });

  it("remembers a failure for the window, then asks again", async () => {
    const port = fakePort();
    const arrived: string[] = [];
    let clock = 1_000;
    const cache = createBlobCache(port.request, (hash) => arrived.push(hash), { now: () => clock });
    cache.want(sha(3));
    port.refuse(sha(3));
    await settle();
    expect({ peek: cache.peek(sha(3)), has: cache.has(sha(3)), arrived }).toEqual({
      peek: null,
      has: false,
      arrived: [],
    });

    clock += 29_999;
    cache.want(sha(3));
    expect(port.calls).toHaveLength(1);

    clock += 1;
    cache.want(sha(3));
    expect(port.calls).toHaveLength(2);
    port.answer(sha(3), "second try");
    await settle();
    expect({ peek: cache.peek(sha(3)), arrived }).toEqual({ peek: "second try", arrived: [sha(3)] });
  });

  it("treats a request that throws, an answer for another hash, and a malformed answer as failures", async () => {
    const throwing = createBlobCache(
      () => {
        throw new Error("socket is not open");
      },
      () => {
        throw new Error("must not arrive");
      },
    );
    throwing.want(sha(4));
    await settle();
    expect({ has: throwing.has(sha(4)), size: throwing.size }).toEqual({ has: false, size: 0 });

    const port = fakePort();
    const arrived: string[] = [];
    const cache = createBlobCache(port.request, (hash) => arrived.push(hash));
    cache.want(sha(5));
    port.answer(sha(5), "wrong blob", { sha256: sha(6) });
    cache.want(sha(7));
    port.answer(sha(7), "malformed", { bytes: "many" });
    await settle();
    expect({ five: cache.has(sha(5)), seven: cache.has(sha(7)), arrived }).toEqual({
      five: false,
      seven: false,
      arrived: [],
    });
  });

  it("does not ask for a hash that is not 64 lowercase hex", () => {
    const port = fakePort();
    const cache = createBlobCache(port.request, () => undefined);
    cache.want("abc");
    cache.want(sha(0xabc).toUpperCase());
    cache.want("");
    expect(port.calls).toEqual([]);
  });

  it("drops the least recently used text past the budget", async () => {
    const port = fakePort();
    const cache = createBlobCache(port.request, () => undefined, { maxChars: 10 });
    for (const [n, text] of [
      [1, "aaaa"],
      [2, "bbbb"],
    ] as const) {
      cache.want(sha(n));
      port.answer(sha(n), text);
    }
    await settle();
    // Reading one makes it the newest.
    expect(cache.peek(sha(1))).toBe("aaaa");
    cache.want(sha(3));
    port.answer(sha(3), "cccc");
    await settle();
    expect({ one: cache.peek(sha(1)), two: cache.peek(sha(2)), three: cache.peek(sha(3)), size: cache.size }).toEqual({
      one: "aaaa",
      two: null,
      three: "cccc",
      size: 2,
    });
    // An evicted blob is asked for again.
    cache.want(sha(2));
    expect(port.calls.map((call) => (call.params as { sha256: string }).sha256)).toEqual([
      sha(1),
      sha(2),
      sha(3),
      sha(2),
    ]);
  });

  it("holds a text larger than the whole budget as a marker and keeps what it had", async () => {
    const port = fakePort();
    const arrived: string[] = [];
    const cache = createBlobCache(port.request, (hash) => arrived.push(hash), { maxChars: 10 });
    cache.want(sha(1));
    port.answer(sha(1), "small");
    cache.want(sha(2));
    port.answer(sha(2), "x".repeat(11));
    await settle();
    expect({ small: cache.peek(sha(1)), huge: cache.peek(sha(2)), hugeHeld: cache.has(sha(2)), arrived }).toEqual({
      small: "small",
      huge: null,
      hugeHeld: true,
      arrived: [sha(1), sha(2)],
    });
    cache.want(sha(2));
    expect(port.calls).toHaveLength(2);
  });

  it("clear drops what is held, forgets failures, and lets a fetch already on the wire land", async () => {
    const port = fakePort();
    const arrived: string[] = [];
    const cache = createBlobCache(port.request, (hash) => arrived.push(hash));
    cache.want(sha(1));
    port.answer(sha(1), "held");
    cache.want(sha(2));
    port.refuse(sha(2));
    cache.want(sha(3));
    await settle();
    expect(cache.size).toBe(1);

    cache.clear();
    expect({ size: cache.size, one: cache.peek(sha(1)) }).toEqual({ size: 0, one: null });
    // The failure is forgotten: asking again goes out at once.
    cache.want(sha(2));
    expect(port.calls.filter((call) => (call.params as { sha256: string }).sha256 === sha(2))).toHaveLength(2);
    // The fetch that was in flight across the clear is not asked twice, and lands.
    cache.want(sha(3));
    expect(port.calls.filter((call) => (call.params as { sha256: string }).sha256 === sha(3))).toHaveLength(1);
    port.answer(sha(3), "late");
    await settle();
    expect({ three: cache.peek(sha(3)), arrived }).toEqual({ three: "late", arrived: [sha(1), sha(3)] });
  });

  it("keeps the text when the arrival hook throws", async () => {
    const port = fakePort();
    const cache = createBlobCache(port.request, () => {
      throw new Error("repaint failed");
    });
    cache.want(sha(1));
    port.answer(sha(1), "kept");
    await settle();
    expect(cache.peek(sha(1))).toBe("kept");
  });
});
