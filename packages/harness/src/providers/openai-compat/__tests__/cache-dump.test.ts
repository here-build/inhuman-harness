import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cacheDumpKind,
  preferCacheResponse,
  reasoningSurvey,
  redactCacheHeaders,
  writeCacheDump,
} from "../cache-dump.js";

describe("preferCacheResponse", () => {
  it("does not let a usage-only completed event wipe output items", () => {
    const item = { type: "response.output_item.done", item: { type: "function_call", name: "scheme_repl" } };
    const completed = {
      type: "response.completed",
      response: { output: [], usage: { output_tokens: 133 } },
    };
    expect(preferCacheResponse(item, completed)).toEqual(item);
    expect(preferCacheResponse(completed, item)).toEqual(item);
    const full = { type: "response.completed", response: { output: [{ type: "message" }] } };
    expect(preferCacheResponse(item, full)).toEqual(full);
  });
});

describe("cache dump", () => {
  it("dump redacts authorization; kind names expected vs actual", () => {
    expect({
      alignedHit: cacheDumpKind(true, true),
      alignedMiss: cacheDumpKind(false, false),
      unexpectedHit: cacheDumpKind(false, true),
      unexpectedMiss: cacheDumpKind(true, false),
      unreported: cacheDumpKind(true, null),
    }).toEqual({
      alignedHit: "aligned-hit",
      alignedMiss: "aligned-miss",
      unexpectedHit: "unexpected-hit",
      unexpectedMiss: "unexpected-miss",
      unreported: "unreported",
    });

    const redacted = redactCacheHeaders({
      authorization: "Bearer x",
      "x-grok-conv-id": "s",
    });
    expect(redacted).toEqual({
      authorization: "[redacted]",
      "x-grok-conv-id": "s",
    });
    expect(redacted).not.toHaveProperty("authorization", "Bearer x");

    expect(
      reasoningSurvey({
        messages: [
          { role: "system", content: "c" },
          { role: "assistant", content: "hi", reasoning_content: "plan" },
          { role: "assistant", content: "next", tool_calls: [{}, {}] },
        ],
      }),
    ).toEqual({
      assistants: 2,
      missingReasoning: [{ index: 2, contentChars: 4, calls: 2 }],
    });

    const workspace = mkdtempSync(join(tmpdir(), "cache-dump-"));
    try {
      const dir = writeCacheDump({
        workspacePath: workspace,
        sessionId: "sess",
        startedAt: 10,
        kind: "aligned-hit",
        expectedCacheHit: true,
        cacheHit: true,
        cachedTokens: 128,
        totalTokens: 200,
        request: {
          headers: { authorization: "Bearer x" },
          body: { messages: [] },
        },
        response: { usage: { prompt_tokens_details: { cached_tokens: 128 } } },
        answer: { content: "ok", reasoning: "", calls: 0 },
      });
      expect({
        dir: dir?.includes("10-aligned-hit") === true,
        request: JSON.parse(readFileSync(join(dir!, "request.json"), "utf8")),
        meta: JSON.parse(readFileSync(join(dir!, "meta.json"), "utf8")),
        index: readFileSync(join(workspace, ".harness", "cache", "sess", "index.jsonl"), "utf8"),
      }).toMatchObject({
        dir: true,
        request: {
          headers: { authorization: "[redacted]" },
          body: { messages: [] },
        },
        meta: {
          kind: "aligned-hit",
          cachedTokens: 128,
          answer: { content: "ok", reasoning: "", calls: 0 },
          wire: { assistants: 0, missingReasoning: [] },
        },
        index: expect.stringContaining("aligned-hit"),
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
