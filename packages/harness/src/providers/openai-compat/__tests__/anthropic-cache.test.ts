import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { bindSessionCatalog, KernelToolCatalog } from "@/tool-catalog";

import type { ChatMessage } from "../actor.js";
import { breakpointIndices, emitsCacheControl, withCacheBreakpoints } from "../anthropic-cache.js";
import { OpenAiCompatDriverConnection } from "../index.js";
import { listenCompat } from "./compat-server.js";

const sys = (content: string): ChatMessage => ({ role: "system", content });
const user = (content: string): ChatMessage => ({ role: "user", content });
const asst = (content: string | null): ChatMessage => ({ role: "assistant", content });
const tool = (content: string): ChatMessage => ({ role: "tool", content, tool_call_id: "t" });

function marked(messages: readonly ChatMessage[]): number[] {
  return messages.flatMap((message, i) =>
    Array.isArray(message.content) && message.content.some((part) => "cache_control" in part) ? [i] : [],
  );
}

describe("which routes get cache_control", () => {
  it("auto: Anthropic models on OpenRouter only", () => {
    expect(emitsCacheControl({}, "openrouter", "anthropic/claude-sonnet-4.5")).toBe(true);
    expect(emitsCacheControl({}, "openrouter", "openai/gpt-5")).toBe(false);
    expect(emitsCacheControl({}, "none", "claude-sonnet")).toBe(false);
    expect(emitsCacheControl({}, "openai", "gpt-5.6")).toBe(false);
    expect(emitsCacheControl({}, "grok", "grok-4")).toBe(false);
  });
  it("on forces it, off suppresses it", () => {
    expect(emitsCacheControl({ cacheControl: "on" }, "none", "claude-x")).toBe(true);
    expect(emitsCacheControl({ cacheControl: "off" }, "openrouter", "anthropic/claude-x")).toBe(false);
  });
});

describe("breakpoint placement", () => {
  const round2: ChatMessage[] = [
    sys("constitution"),
    sys("Workspace: /w"),
    user("CARD"),
    user("task"),
    asst(null),
    tool("result one"),
    asst("thinking"),
    tool("result two"),
    user("steer"),
  ];

  it("system end, card, previous request end, current end", () => {
    // previous request ended before the last assistant message (index 6): index 5.
    expect(breakpointIndices(round2, "CARD")).toEqual([1, 2, 5, 8]);
    const out = withCacheBreakpoints(round2, "CARD");
    expect(marked(out)).toEqual([1, 2, 5, 8]);
    expect(out[1]!.content).toEqual([{ type: "text", text: "Workspace: /w", cache_control: { type: "ephemeral" } }]);
    // input is not mutated and output is deterministic
    expect(round2[1]!.content).toBe("Workspace: /w");
    expect(withCacheBreakpoints(round2, "CARD")).toEqual(out);
  });

  it("no card, no prior assistant: system end and current end; never more than 4", () => {
    expect(breakpointIndices([sys("s"), user("hi")], "")).toEqual([0, 1]);
    expect(breakpointIndices([sys("s"), sys("s2"), user("a"), asst("b"), user("c")], "")).toEqual([1, 2, 4]);
    expect(breakpointIndices(round2, "CARD").length).toBeLessThanOrEqual(4);
  });

  it("a null-content assistant cannot carry a marker; the nearest earlier message does", () => {
    expect(breakpointIndices([sys("s"), user("q"), asst(null)], "")).toEqual([0, 1]);
  });

  it("1h ttl rides the stable head only", () => {
    const out = withCacheBreakpoints(round2, "CARD", "1h");
    const ttls = marked(out).map(
      (i) => (out[i]!.content as unknown as Array<{ cache_control: { ttl?: string } }>).at(-1)!.cache_control.ttl,
    );
    expect(ttls).toEqual(["1h", "1h", undefined, undefined]);
  });
});

describe("request body", () => {
  async function post(settings: Record<string, unknown>): Promise<Array<{ role: string; content: unknown }>> {
    const compat = await listenCompat({ reply: () => "ok" });
    const connection = new OpenAiCompatDriverConnection("row-ac", {
      baseUrl: compat.baseUrl,
      model: "m1",
      ...settings,
    });
    const plexus = SessionPlexus.create("ac-session", "/ws");
    bindSessionCatalog(plexus.root, new KernelToolCatalog());
    try {
      await connection.ensureBootstrapStarted();
      const round = new CompletionExpectation({ promptText: prompt.user`hello`, connectionId: "row-ac", model: "m1" });
      plexus.root.head = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: round.promptText,
        doneWork: [new CompletionJob({ expectation: round })],
        queue: [],
      });
      await connection.complete({ model: "m1", promptText: "hello", round });
      return (compat.posts[0] as { messages: Array<{ role: string; content: unknown }> }).messages;
    } finally {
      plexus.destroy();
      await connection[Symbol.asyncDispose]();
      await compat.close();
    }
  }

  it("cacheControl on: marker on the last system message (closes tools + system) and the final message", async () => {
    const messages = await post({ cacheControl: "on" });
    const withMarker = messages.flatMap((m, i) =>
      Array.isArray(m.content) && JSON.stringify(m.content).includes("cache_control") ? [i] : [],
    );
    expect(messages.slice(0, 2).map((m) => m.role)).toEqual(["system", "system"]);
    expect(withMarker).toEqual([1, messages.length - 1]);
    expect(messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
    });
  });

  it("default (auto) on a non-OpenRouter host and off: no cache_control anywhere", async () => {
    for (const settings of [{}, { cacheControl: "off" }]) {
      expect(JSON.stringify(await post(settings))).not.toContain("cache_control");
    }
  });
});
