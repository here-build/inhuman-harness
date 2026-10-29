import dedent from "dedent";
import { describe, expect, it, beforeEach } from "vitest";

import {
  assembleEvents,
  streamFinishReason,
  normalizeMessage,
  ensureBuiltins,
  NormalizeError,
  createStreamSession,
  type NormalizeEvent,
} from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";
import { assertIrOrdering, collectEvents } from "./stream-harness.js";

describe("ir assemble + ordering", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  it("assembleEvents builds tool_calls from ends; ignores args_delta for execute shape", () => {
    const events: NormalizeEvent[] = [
      { type: "text_delta", text: "Hi " },
      {
        type: "tool_call_start",
        index: 0,
        id: "call_0",
        name: "read_file",
      },
      {
        type: "tool_call_args_delta",
        index: 0,
        id: "call_0",
        argumentsDelta: '{"path":"WRONG"}',
      },
      {
        type: "tool_call_end",
        index: 0,
        id: "call_0",
        name: "read_file",
        arguments: '{"path":"a.ts"}',
      },
      {
        type: "meta",
        meta: {
          dialect: "hermes",
          estimated: true,
          toolsInThinkingCount: 0,
          dropped: [],
          ambiguous: [],
          partial: [],
          untypedArgs: false,
          renamed: [],
        },
      },
      { type: "finish", finish_reason: "tool_calls" },
    ];
    assertIrOrdering(events);
    const r = assembleEvents(events);
    expect(r.content).toBe("Hi");
    expect(r.tool_calls).toHaveLength(1);
    expect(JSON.parse(r.tool_calls[0]!.function.arguments)).toEqual({
      path: "a.ts",
    });
    expect(r.finish_reason).toBe("tool_calls");
  });

  it("assembleEvents drops partial ends by default", () => {
    const events: NormalizeEvent[] = [
      {
        type: "tool_call_start",
        index: 0,
        id: "c0",
        name: "x",
      },
      {
        type: "tool_call_end",
        index: 0,
        id: "c0",
        name: "x",
        arguments: "{}",
        partial: true,
      },
      {
        type: "meta",
        meta: {
          dialect: "hermes",
          estimated: false,
          toolsInThinkingCount: 0,
          dropped: [],
          ambiguous: [],
          partial: [0],
          untypedArgs: false,
          renamed: [],
        },
      },
      { type: "finish", finish_reason: "length" },
    ];
    const r = assembleEvents(events);
    expect(r.tool_calls).toHaveLength(0);
    expect(r.meta.dropped.some((d) => d.reason === "truncated")).toBe(true);
  });

  it("streamFinishReason preserves content_filter", () => {
    expect(streamFinishReason("content_filter", false)).toBe("content_filter");
    expect(streamFinishReason("stop", true)).toBe("tool_calls");
  });

  it("createStreamSession throws on nativePolicy rescan", () => {
    expect(() => createStreamSession({ nativePolicy: "rescan" })).toThrow(NormalizeError);
  });

  it("createStreamSession finish preserves content_filter from batch assemble", () => {
    const events = collectEvents(
      [
        {
          choices: [
            {
              delta: { content: "hello" },
              finish_reason: "content_filter",
            },
          ],
        },
      ],
      { dialect: "openai", mode: "pass" },
    );
    const fin = events.find((e) => e.type === "finish");
    expect(fin).toMatchObject({
      type: "finish",
      finish_reason: "content_filter",
    });
  });

  it("stream hermes recovers tools; ordering ok", () => {
    const full = dedent`
      Look:
      <tool_call>
      {"name":"get_weather","arguments":{"city":"SF"}}
      </tool_call>
    `;
    const events = collectEvents(
      ["Look:\n", "<tool_call>\n", '{"name":"get_weather","arguments":{"city":"SF"}}\n', "</tool_call>"],
      { dialect: "hermes" },
    );
    assertIrOrdering(events);
    const assembled = assembleEvents(events);
    const batch = normalizeMessage(full, { dialect: "hermes" });
    expect(assembled.tool_calls.map((t) => t.function.name)).toEqual(batch.tool_calls.map((t) => t.function.name));
    expect(JSON.parse(assembled.tool_calls[0]!.function.arguments)).toEqual(
      JSON.parse(batch.tool_calls[0]!.function.arguments),
    );
  });
});
