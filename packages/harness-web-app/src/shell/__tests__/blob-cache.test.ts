import { autorun } from "mobx";
import { afterEach, describe, expect, it } from "vitest";

import { bindBlobCache, blobs } from "../blob-cache.js";

const sha = (n: number): string => n.toString(16).padStart(64, "0");

/** A session port that answers only when the test says so. */
function fakePort() {
  const calls: Array<{ method: string; params: unknown }> = [];
  const waiting = new Map<string, (value: unknown) => void>();
  return {
    calls,
    request: (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      return new Promise((resolve) => {
        waiting.set((params as { sha256: string }).sha256, resolve);
      });
    },
    answer(hash: string, text: string) {
      waiting.get(hash)?.({ sha256: hash, bytes: text.length, mime: "text/plain", text, bytesBase64: null });
      waiting.delete(hash);
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let release: (() => void) | null = null;
afterEach(() => {
  release?.();
  release = null;
});

describe("the web blob cache seat", () => {
  it("peeks null and asks for nothing until a dial seats a cache", () => {
    expect(blobs().peek(sha(1))).toBeNull();
    expect(() => blobs().want(sha(1))).not.toThrow();
  });

  it("asks blob/get on the bound port and serves the text after it lands", async () => {
    const port = fakePort();
    release = bindBlobCache(port.request);
    blobs().want(sha(1));
    blobs().want(sha(1));
    expect(port.calls).toEqual([{ method: "blob/get", params: { sha256: sha(1) } }]);
    expect(blobs().peek(sha(1))).toBeNull();
    port.answer(sha(1), "const a = 1;\n");
    await settle();
    expect(blobs().peek(sha(1))).toBe("const a = 1;\n");
  });

  it("runs only what peeked a blob again when that blob lands, and again when a cache is seated", async () => {
    const port = fakePort();
    const seen: Array<string | null> = [];
    const other: Array<string | null> = [];
    const stop = [
      autorun(() => {
        seen.push(blobs().peek(sha(1)));
      }),
      autorun(() => {
        other.push(blobs().peek(sha(2)));
      }),
    ];
    try {
      expect({ seen, other }).toEqual({ seen: [null], other: [null] });

      release = bindBlobCache(port.request);
      expect({ seen, other }).toEqual({ seen: [null, null], other: [null, null] });

      blobs().want(sha(1));
      blobs().want(sha(2));
      port.answer(sha(1), "one");
      await settle();
      expect({ seen, other }).toEqual({ seen: [null, null, "one"], other: [null, null] });

      port.answer(sha(2), "two");
      await settle();
      expect({ seen, other }).toEqual({ seen: [null, null, "one"], other: [null, null, "two"] });
    } finally {
      for (const dispose of stop) dispose();
    }
  });

  it("a release clears the seat it made, and only that one", async () => {
    const first = fakePort();
    const second = fakePort();
    const releaseFirst = bindBlobCache(first.request);
    release = bindBlobCache(second.request);
    releaseFirst();
    blobs().want(sha(1));
    expect({ first: first.calls.length, second: second.calls.length }).toEqual({ first: 0, second: 1 });

    release();
    release = null;
    blobs().want(sha(2));
    expect(second.calls).toHaveLength(1);
    expect(blobs().peek(sha(1))).toBeNull();
  });

  it("null clears the seat", () => {
    const port = fakePort();
    bindBlobCache(port.request);
    bindBlobCache(null);
    blobs().want(sha(1));
    expect(port.calls).toEqual([]);
  });
});
