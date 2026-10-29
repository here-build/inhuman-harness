/**
 * 2b-4: tools emit when closed span is known, not only at EOS.
 */
import dedent from "dedent";
import { describe, expect, it, beforeEach } from "vitest";

import { createStreamSession, ensureBuiltins, type OpenAiChatChunk } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";
import { runStream, expectSequence, text, start, end, finish } from "./stream-harness.js";

describe("live tool emission", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  it("emits tool IR before stream ends (mid-chunk close)", async () => {
    const events = await runStream(
      ["Look:\n", "<tool_call>\n", '{"name":"get_weather","arguments":{"city":"SF"}}\n', "</tool_call>\n", "Done."],
      { dialect: "hermes" },
    );
    const types = events.map((e) => e.type);
    const endIdx = types.indexOf("tool_call_end");
    const lastText = types.lastIndexOf("text_delta");
    expect(endIdx).toBeGreaterThanOrEqual(0);
    // "Done." text after tool close should follow tool_call_end
    expect(lastText).toBeGreaterThan(endIdx);
    expectSequence(events, [
      text({ includes: "Look" }),
      start("get_weather"),
      end("get_weather", { city: "SF" }),
      text({ includes: "Done" }),
      finish("tool_calls"),
    ]);
  });

  it("MB-1 live: content tool first, native duplicate not second end", async () => {
    const markup = dedent`
      Writing.
      <tool_call>
      {"name":"write_file","arguments":{"path":"a","content":"x"}}
      </tool_call>
    `;
    const events = await runStream(
      [
        markup,
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_abc",
                    function: {
                      name: "write_file",
                      arguments: '{"path":"a","content":"x"}',
                    },
                  },
                ],
              },
            },
          ],
        } satisfies OpenAiChatChunk,
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ],
      {
        dialect: "hermes",
        nativePolicy: "merge",
        tools: [{ name: "write_file" }],
      },
    );
    expect(events.filter((e) => e.type === "tool_call_end")).toHaveLength(1);
  });

  it("strict gates live probe — unknown name not executed", async () => {
    const raw = dedent`
      <tool_call>
      {"name":"ghost","arguments":{}}
      </tool_call>
    `;
    const events = await runStream([raw], {
      dialect: "hermes",
      mode: "strict",
      tools: [{ name: "known" }],
    });
    expect(events.filter((e) => e.type === "tool_call_end")).toHaveLength(0);
    // Gated, not executed — and gated machinery is dropped, never repainted
    // as prose. The name reaches the caller on the drop channel.
    const drops = events.filter((e) => e.type === "tool_call_drop");
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ name: "ghost" });
    const texts = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    expect(texts).not.toContain("ghost");
  });

  it("two identical recovered tools both emit (multiset)", async () => {
    const raw = dedent`
      A
      <tool_call>
      {"name":"ls","arguments":{"p":"/"}}
      </tool_call>
      B
      <tool_call>
      {"name":"ls","arguments":{"p":"/"}}
      </tool_call>
      C
    `;
    const events = await runStream([raw], {
      dialect: "hermes",
      tools: [{ name: "ls" }],
    });
    expect(events.filter((e) => e.type === "tool_call_end")).toHaveLength(2);
  });

  it("liveness with controlled source: tool ends after close chunk, before close()", () => {
    const session = createStreamSession({ dialect: "hermes" });
    const seen: string[] = [];

    for (const ev of session.ingest("Hi\n")) seen.push(ev.type);
    expect(seen).toContain("text_delta");
    expect(seen).not.toContain("tool_call_end");

    for (const ev of session.ingest('<tool_call>\n{"name":"x","arguments":{}}\n</tool_call>\n')) {
      seen.push(ev.type);
    }
    expect(seen).toContain("tool_call_end");

    for (const ev of session.close()) seen.push(ev.type);
    expect(seen).toContain("finish");
  });
});
