import { describe, expect, it } from "vitest";

import { readSseJson } from "../actor.js";

describe("sse stall", () => {
  it("stalls a stream that only pings, before any data event", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(": ping\n\n"));
      },
    });
    const read = readSseJson(body, new AbortController().signal, 50);
    await expect(read.next()).rejects.toThrow("stream stalled after 50ms");
  });
});
