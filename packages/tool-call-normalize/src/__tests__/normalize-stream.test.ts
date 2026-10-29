import { describe, expect, it, beforeEach } from "vitest";

import { normalizeMessage, ensureBuiltins } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";
import { collectEvents } from "./stream-harness.js";

describe("createStreamSession", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  it("recovers hermes tools at end of text stream", () => {
    const events = collectEvents(
      [
        "I'll check.\n",
        `<tool_call>
{"name": "get_weather", "arguments": {"city": "NYC"}}
</tool_call>`,
      ],
      { dialect: "hermes" },
    );
    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(ends.length).toBeGreaterThanOrEqual(1);
    expect((ends[0] as { name: string }).name).toBe("get_weather");
    const finish = events.find((e) => e.type === "finish");
    expect((finish as { finish_reason: string }).finish_reason).toBe("tool_calls");
  });

  it("does not paint raw tool open tags as text_delta (prefix-safe hold)", () => {
    const events = collectEvents(
      ["Sure.\n", "<tool_", 'call>\n{"name": "read_file", "arguments": {"path": "a"}}\n</tool_call>'],
      { dialect: "hermes" },
    );
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    expect(text).not.toContain("<tool_call");
    expect(text).not.toContain("</tool_call");
    expect(text).toContain("Sure");
    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(ends).toHaveLength(1);
  });

  it("stream≈batch for forced hermes dialect", () => {
    const full = `I'll check.
<tool_call>
{"name": "get_weather", "arguments": {"city": "NYC"}}
</tool_call>`;
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += 7) {
      chunks.push(full.slice(i, i + 7));
    }
    const batch = normalizeMessage(full, { dialect: "hermes" });
    const events = collectEvents(chunks, { dialect: "hermes" });
    const ends = events.filter((e) => e.type === "tool_call_end") as Array<{
      name: string;
      arguments: string;
    }>;
    expect(ends).toHaveLength(batch.tool_calls.length);
    expect(ends[0]!.name).toBe(batch.tool_calls[0]!.function.name);
    expect(JSON.parse(ends[0]!.arguments)).toEqual(JSON.parse(batch.tool_calls[0]!.function.arguments));
    const finish = events.find((e) => e.type === "finish") as {
      finish_reason: string;
    };
    expect(finish.finish_reason).toBe(batch.finish_reason);
  });

  it("prose after a closed tool in the same chunk is emitted", () => {
    const events = collectEvents(
      [
        `a <tool_call>{"name":"x","arguments":{}}</tool_call> mid <tool_call>{"name":"y","arguments":{}}</tool_call> end`,
      ],
      { dialect: "hermes" },
    );
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    expect(text).toContain("a");
    expect(text).toContain("mid");
    expect(text).toContain("end");
    expect(text).not.toContain("<tool_call");
    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(ends).toHaveLength(2);
  });

  it("native SSE tool_calls pass through with deltas", () => {
    const events = collectEvents(
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_n1",
                    function: { name: "read_file", arguments: "" },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '{"path":"x"}' },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ],
      { dialect: "openai" },
    );
    const start = events.find((e) => e.type === "tool_call_start") as {
      id: string;
      name: string;
    };
    expect(start.id).toBe("call_n1");
    expect(start.name).toBe("read_file");
    const end = events.find((e) => e.type === "tool_call_end") as {
      arguments: string;
    };
    expect(JSON.parse(end.arguments)).toEqual({ path: "x" });
  });
});
