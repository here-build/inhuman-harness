/**
 * MB-1 dual-channel / first-committer (audit-011 stress).
 * Tools emit once from EOS assemble — no native-then-recovered double-fire.
 */
import dedent from "dedent";
import { describe, expect, it, beforeEach } from "vitest";

import { ensureBuiltins, type OpenAiChatChunk } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";
import { runStream, expectSequence, text, start, end, finish } from "./stream-harness.js";

describe("dual-channel stream", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  it("MB-1: recovered then identical native → one end, not two", async () => {
    const markup = dedent`
      Writing it now.
      <tool_call>
      {"name":"write_file","arguments":{"path":"a","content":"x"}}
      </tool_call>
    `;
    const nativeChunk: OpenAiChatChunk = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_abc",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: '{"path":"a","content":"x"}',
                },
              },
            ],
          },
        },
      ],
    };
    const fin: OpenAiChatChunk = {
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    };

    const events = await runStream([markup, nativeChunk, fin], {
      dialect: "hermes",
      nativePolicy: "merge",
      tools: [{ name: "write_file" }],
    });

    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      type: "tool_call_end",
      name: "write_file",
    });
    if (ends[0]?.type === "tool_call_end") {
      expect(JSON.parse(ends[0].arguments)).toEqual({
        path: "a",
        content: "x",
      });
    }

    expectSequence(events, [
      text({ includes: "Writing" }),
      start("write_file"),
      end("write_file", { path: "a", content: "x" }),
      finish("tool_calls"),
    ]);
  });

  it("native only emits once", async () => {
    const events = await runStream(
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "n1",
                    function: {
                      name: "read_file",
                      arguments: '{"path":"z"}',
                    },
                  },
                ],
              },
            },
          ],
        } satisfies OpenAiChatChunk,
        {
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
        } satisfies OpenAiChatChunk,
      ],
      { mode: "repair", tools: [{ name: "read_file" }] },
    );
    expect(events.filter((e) => e.type === "tool_call_end")).toHaveLength(1);
  });

  it("index 0 twice with different names → two tools", async () => {
    const events = await runStream(
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "a",
                    function: { name: "read_file", arguments: '{"path":"a"}' },
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
                    id: "b",
                    function: { name: "write_file", arguments: '{"path":"b"}' },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ],
      {
        mode: "repair",
        tools: [{ name: "read_file" }, { name: "write_file" }],
      },
    );
    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(ends.map((e) => (e.type === "tool_call_end" ? e.name : ""))).toEqual(["read_file", "write_file"]);
  });

  it("skip latch: native first then content markup not recovered as second tool", async () => {
    const events = await runStream(
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "n1",
                    function: {
                      name: "read_file",
                      arguments: '{"path":"a"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        dedent`
          <tool_call>
          {"name":"write_file","arguments":{"path":"b","content":"z"}}
          </tool_call>
        `,
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ],
      {
        dialect: "hermes",
        nativePolicy: "skip",
        tools: [{ name: "read_file" }, { name: "write_file" }],
      },
    );
    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ name: "read_file" });
  });
});
