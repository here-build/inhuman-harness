/**
 * §9.7 batch ≈ assemble(stream) for tools + finish_reason.
 *
 * Under repair/strict + forced dialect: assembleEvents(collectStreamSync(singleChunk))
 * must match normalizeMessage on name+args multiset and finish_reason.
 * Content byte-equality is NOT required (live seams).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, beforeEach } from "vitest";

import {
  ensureBuiltins,
  normalizeMessage,
  collectStreamSync,
  assembleEvents,
  type MessageInput,
  type NormalizeOptions,
  type OpenAiChatChunk,
  type ToolCall,
} from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";

const here = dirname(fileURLToPath(import.meta.url));

function messageToChunks(input: MessageInput, opts: NormalizeOptions): Array<string | OpenAiChatChunk> {
  if (typeof input === "string") {
    const chunks: Array<string | OpenAiChatChunk> = [input];
    if (opts.finishReasonIn) {
      chunks.push({
        choices: [{ delta: {}, finish_reason: opts.finishReasonIn }],
      });
    }
    return chunks;
  }
  const content = input.content ?? "";
  const natives = input.tool_calls ?? [];
  const reasoning = input.reasoning_content ?? null;
  const chunks: Array<string | OpenAiChatChunk> = [];
  if (natives.length > 0 || reasoning) {
    chunks.push({
      choices: [
        {
          delta: {
            content: content || undefined,
            reasoning_content: reasoning || undefined,
            tool_calls:
              natives.length > 0
                ? natives.map((t, i) => ({
                    index: i,
                    id: t.id,
                    function: {
                      name: t.function.name,
                      arguments: t.function.arguments ?? "{}",
                    },
                  }))
                : undefined,
          },
        },
      ],
    });
  } else {
    chunks.push(content);
  }
  chunks.push({
    choices: [
      {
        delta: {},
        finish_reason: opts.finishReasonIn ?? "stop",
      },
    ],
  });
  return chunks;
}

function assembleSingle(input: MessageInput, opts: NormalizeOptions) {
  const events = collectStreamSync(messageToChunks(input, opts), opts);
  const assembled = assembleEvents(events, { dropPartials: false });
  for (const pi of assembled.meta.partial) {
    const t = assembled.tool_calls[pi];
    if (!t) continue;
    assembled.tool_calls[pi] = {
      ...t,
      function: { ...t.function, arguments: "{}" },
    };
  }
  return assembled;
}

function toolKeys(tools: ToolCall[]): string[] {
  return tools
    .map((t) => {
      let args = t.function.arguments || "{}";
      try {
        args = JSON.stringify(JSON.parse(args));
      } catch {
        /* raw */
      }
      return `${t.function.name}\0${args}`;
    })
    .sort();
}

function assertToolsFinishParity(
  batch: ReturnType<typeof normalizeMessage>,
  assembled: ReturnType<typeof assembleSingle>,
  label: string,
) {
  expect(toolKeys(batch.tool_calls), `${label} tools`).toEqual(toolKeys(assembled.tool_calls));
  expect(batch.finish_reason, `${label} finish`).toBe(assembled.finish_reason);
}

describe("batch ≈ assemble(stream) parity", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  const cases: Array<{
    name: string;
    input: MessageInput;
    opts: NormalizeOptions;
  }> = [
    {
      name: "hermes partial truncated",
      input: `Look:\n<tool_call>\n{"name":"get_weather","arguments":{"city":"SF"}}`,
      opts: { dialect: "hermes" },
    },
    {
      name: "hermes finish length",
      input: `ok <tool_call>{"name":"x","arguments":{}}</tool_call>`,
      opts: { dialect: "hermes", finishReasonIn: "length" },
    },
    {
      name: "hermes content_filter no tools",
      input: `hello`,
      opts: { dialect: "hermes", finishReasonIn: "content_filter" },
    },
    {
      name: "hermes strict known",
      input: `<tool_call>\n{"name":"get_weather","arguments":{"city":"SF"}}\n</tool_call>`,
      opts: {
        dialect: "hermes",
        mode: "strict",
        tools: [
          {
            name: "get_weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        ],
      },
    },
    {
      name: "openai dialect prose only",
      input: `hello world`,
      opts: { dialect: "openai" },
    },
    {
      name: "native+recovered merge hermes",
      input: {
        content: `<tool_call>\n{"name":"other","arguments":{}}\n</tool_call>`,
        tool_calls: [
          {
            id: "native_1",
            type: "function",
            function: { name: "first", arguments: "{}" },
          },
        ],
      },
      opts: { dialect: "hermes", nativePolicy: "merge" },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const batch = normalizeMessage(c.input, c.opts);
      const assembled = assembleSingle(c.input, c.opts);
      assertToolsFinishParity(batch, assembled, c.name);
    });
  }

  it("fixtures the chunk-split property does not load", () => {
    const fixDir = join(here, "fixtures");
    const chunklessText = new Set<string>();
    const pending: Array<{ id: string; input: MessageInput; opts: NormalizeOptions }> = [];
    function walk(d: string, prefix = "") {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        if (ent.isDirectory()) walk(join(d, ent.name), `${prefix}${ent.name}/`);
        else if (ent.name.endsWith(".json") && ent.name !== "categories.json") {
          const fx = JSON.parse(readFileSync(join(d, ent.name), "utf8")) as {
            input?: MessageInput;
            chunks?: string[];
            opts?: NormalizeOptions;
          };
          if (fx.input === undefined) continue;
          const opts: NormalizeOptions = {
            dialect: "hermes",
            ...fx.opts,
          };
          const mode = opts.mode ?? "repair";
          if (mode === "pass" || mode === "detect") continue;
          if (!opts.dialect || opts.dialect === "auto") opts.dialect = "hermes";
          if ((opts.nativePolicy ?? "merge") === "rescan") continue;
          // maxBufferChars is a streaming-only buffer-overflow valve (audit-repros
          // speculative-paint fixtures probe it deliberately); normalizeMessage
          // has no buffering concept and reads the whole input at once, so batch
          // vs assemble(stream) parity is inherently inapplicable here, not a defect.
          if (opts.maxBufferChars !== undefined) continue;
          // String inputs with no pre-baked chunks are the split-invariance corpus.
          if (typeof fx.input === "string" && !fx.chunks) {
            chunklessText.add(fx.input);
            continue;
          }
          pending.push({
            id: prefix + ent.name,
            input: fx.input,
            opts,
          });
        }
      }
    }
    walk(fixDir);

    const loaded = pending.filter((fx) => typeof fx.input !== "string" || !chunklessText.has(fx.input));
    expect(loaded.length).toBeGreaterThan(0);
    for (const fx of loaded) {
      const batch = normalizeMessage(fx.input, fx.opts);
      const assembled = assembleSingle(fx.input, fx.opts);
      assertToolsFinishParity(batch, assembled, fx.id);
    }
  });
});
