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

describe("SSE progress and cancellation", () => {
  it.each([
    { name: "Responses lifecycle", frame: { type: "response.in_progress" } },
    { name: "empty JSON", frame: {} },
    { name: "empty chat delta", frame: { choices: [{ delta: {}, finish_reason: null }] } },
    { name: "chat role metadata", frame: { choices: [{ delta: { role: "assistant" }, finish_reason: null }] } },
    { name: "empty Responses delta", frame: { type: "response.output_text.delta", delta: "" } },
  ])("does not treat repeated $name as model progress", async ({ frame }) => {
    let timer: ReturnType<typeof setInterval>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(
          () => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`)),
          5,
        );
      },
      cancel() {
        clearInterval(timer);
      },
    });
    const read = readSseJson(body, new AbortController().signal, 35);
    await expect(
      (async () => {
        for await (const _ of read) {
          /* metadata */
        }
      })(),
    ).rejects.toThrow("stream stalled after 35ms");
  });

  it("keeps a stream alive while text, reasoning, tool arguments and terminal events progress", async () => {
    const frames = [
      { choices: [{ delta: { content: "hello" } }] },
      { choices: [{ delta: { reasoning_content: "consider" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] },
      { type: "response.reasoning_summary_text.delta", delta: "reason" },
      { type: "response.function_call_arguments.delta", delta: "{}" },
      { type: "response.completed" },
    ];
    let timer: ReturnType<typeof setInterval>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let index = 0;
        timer = setInterval(() => {
          if (index < frames.length)
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frames[index++])}\n\n`));
          else {
            clearInterval(timer);
            controller.close();
          }
        }, 20);
      },
      cancel() {
        clearInterval(timer);
      },
    });
    const seen: unknown[] = [];
    for await (const frame of readSseJson(body, new AbortController().signal, 70)) seen.push(frame);
    expect(seen).toEqual(frames);
  });

  it("accepts CRLF event boundaries split across network chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of ['data: {"ok":true}\r\n\r', "\ndata: [DONE]\r\n\r\n"])
          controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    });
    const read = readSseJson(body, new AbortController().signal, 50);
    expect(await read.next()).toEqual({ value: { ok: true }, done: false });
    expect((await read.next()).done).toBe(true);
  });

  it("cancels a pending synthetic body read when the caller aborts", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const next = readSseJson(body, controller.signal, 5000).next();
    const rejected = expect(next).rejects.toThrow("turn stopped");
    controller.abort(new Error("turn stopped"));
    await rejected;
    expect(cancelled).toBe(true);
  });
});
