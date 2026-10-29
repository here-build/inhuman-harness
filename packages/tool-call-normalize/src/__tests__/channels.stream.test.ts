/**
 * 2b-3: live think channel + fence tool-suppress + OD-1 conservation
 */
import dedent from "dedent";
import { describe, expect, it, beforeEach } from "vitest";

import { ensureBuiltins, normalizeMessage, type NormalizeEvent } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";
import { runStream, expectSequence, reasoning, start, end, finish } from "./stream-harness.js";

function joinChannel(events: NormalizeEvent[], type: "text_delta" | "reasoning_delta"): string {
  return events
    .filter((e) => e.type === type)
    .map((e) => (e.type === type ? e.text : ""))
    .join("");
}

function countSubstr(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) {
    n++;
    i += needle.length;
  }
  return n;
}

describe("stream channels: think + fence", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  it("MB-3: think interior is reasoning_delta, not text_delta", async () => {
    const events = await runStream(
      [
        dedent`
          Hello
          <think>
          secret plan
          </think>
          Done
        `,
      ],
      { dialect: "hermes" },
    );
    const texts = joinChannel(events, "text_delta");
    const reasons = joinChannel(events, "reasoning_delta");
    expect(texts).toContain("Hello");
    expect(texts).toContain("Done");
    expect(texts).not.toContain("secret plan");
    expect(reasons).toContain("secret plan");
  });

  it("fence suppresses tool extraction; example stays text", async () => {
    const raw = dedent`
      Example:
      \`\`\`
      <tool_call>
      {"name":"rm_rf","arguments":{}}
      </tool_call>
      \`\`\`
      done
    `;
    const events = await runStream([raw], {
      dialect: "hermes",
      tools: [{ name: "rm_rf" }],
    });
    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(ends).toHaveLength(0);
    const joined = joinChannel(events, "text_delta");
    // reject-replay / live fence: user still sees the example markup
    expect(joined).toContain("tool_call");
    expect(joined).toContain("rm_rf");
    // OD-1: no double paint of the fenced span
    expect(countSubstr(joined, "rm_rf")).toBe(1);
    const batch = normalizeMessage(raw, {
      dialect: "hermes",
      tools: [{ name: "rm_rf" }],
    });
    expect(batch.tool_calls).toHaveLength(0);
  });

  it("fenced hermes example: 0 tools + fenced content in text_delta", async () => {
    // Task-required: balanced fence hermes → 0 tools, content appears in text
    const raw = dedent`
      Here is how to call tools:
      \`\`\`xml
      <tool_call>
      {"name":"rm_rf","arguments":{"path":"/"}}
      </tool_call>
      \`\`\`
      Don't run that.
    `;
    const events = await runStream([raw], {
      dialect: "hermes",
      tools: [{ name: "rm_rf" }],
    });
    expect(events.filter((e) => e.type === "tool_call_end")).toHaveLength(0);
    const t = joinChannel(events, "text_delta");
    expect(t).toContain("<tool_call>");
    expect(t).toContain("rm_rf");
    expect(t).toContain("Don't run that");
    expect(countSubstr(t, "<tool_call>")).toBe(1);
    expect(countSubstr(t, "</tool_call>")).toBe(1);
  });

  it("tool after think still recovers", async () => {
    const raw = dedent`
      <think>planning</think>
      <tool_call>
      {"name":"read_file","arguments":{"path":"a.ts"}}
      </tool_call>
    `;
    const events = await runStream([raw], {
      dialect: "hermes",
      tools: [{ name: "read_file" }],
    });
    expectSequence(events, [
      reasoning(/planning/),
      start("read_file"),
      end("read_file", { path: "a.ts" }),
      finish("tool_calls"),
    ]);
  });

  it("unterminated think closes at tool marker; post-tool prose is text", async () => {
    // Task-required: unclosed <think> then hermes <tool_call>
    // → thinking before tool is reasoning; text after tool close is text_delta
    const raw = dedent`
      <think>hmm
      <tool_call>
      {"name":"x","arguments":{}}
      </tool_call>
      after
    `;
    const events = await runStream([raw], {
      dialect: "hermes",
      tools: [{ name: "x" }],
    });
    const reasons = joinChannel(events, "reasoning_delta");
    const texts = joinChannel(events, "text_delta");
    expect(reasons).toContain("hmm");
    expect(reasons).not.toContain("after");
    expect(reasons).not.toMatch(/tool_call/);
    expect(texts).toContain("after");
    // Successful tool: markup must not paint as text either
    expect(texts).not.toMatch(/tool_call/);
    expectSequence(events, [start("x"), end("x", {}), finish("tool_calls")]);
  });

  it("chunked unterminated think + split tool open still ends reasoning at tool", async () => {
    const events = await runStream(
      ["<think>plan ", "<tool", '_call>\n{"name":"x","arguments":{}}\n</tool_call>\n', "after"],
      { dialect: "hermes", tools: [{ name: "x" }] },
    );
    const reasons = joinChannel(events, "reasoning_delta");
    const texts = joinChannel(events, "text_delta");
    expect(reasons).toContain("plan");
    expect(reasons).not.toContain("after");
    expect(reasons).not.toMatch(/tool_call|<\/?tool/i);
    expect(texts).toContain("after");
    expect(texts).not.toMatch(/tool_call/);
    expectSequence(events, [start("x"), end("x", {}), finish("tool_calls")]);
  });

  it("unbalanced fence fail-open: tools match batch; markup live once (OD-1)", async () => {
    // Task-required: unbalanced fence — extract once, no double paint
    const raw = dedent`
      Intro
      \`\`\`
      <tool_call>
      {"name":"x","arguments":{}}
      </tool_call>
      more text
    `;
    const events = await runStream([raw], {
      dialect: "hermes",
      tools: [{ name: "x" }],
    });
    const batch = normalizeMessage(raw, {
      dialect: "hermes",
      tools: [{ name: "x" }],
    });
    // Fail-open: tools extracted (batch + stream)
    expect(batch.tool_calls.map((t) => t.function.name)).toEqual(["x"]);
    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.type === "tool_call_end" && ends[0]!.name).toBe("x");

    const t = joinChannel(events, "text_delta");
    // Markup already live while fence open (OD-1 emit-as-text)
    expect(t).toContain("<tool_call>");
    expect(t).toContain("more text");
    // No double paint of the same tool span
    expect(countSubstr(t, "<tool_call>")).toBe(1);
    expect(countSubstr(t, "</tool_call>")).toBe(1);
    expect(countSubstr(t, '"name":"x"')).toBe(1);
  });

  it("unbalanced fence chunked: still one paint + one tool", async () => {
    const events = await runStream(
      ["Intro\n```\n", '<tool_call>\n{"name":"x","arguments":{}}\n</tool_call>\n', "after"],
      { dialect: "hermes", tools: [{ name: "x" }] },
    );
    const t = joinChannel(events, "text_delta");
    expect(countSubstr(t, "<tool_call>")).toBe(1);
    expect(events.filter((e) => e.type === "tool_call_end")).toHaveLength(1);
    expect(t).toContain("after");
  });

  it("conservation: unknown tool span is dropped, not painted; prose survives", async () => {
    const raw = dedent`
      Before.
      <tool_call>
      {"name":"not_in_catalog","arguments":{}}
      </tool_call>
      After.
    `;
    const events = await runStream([raw], {
      dialect: "hermes",
      tools: [{ name: "read_file" }],
    });
    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(ends).toHaveLength(0);

    // The name parsed, so the span is machinery: its fate is dropped, never
    // text. It survives on the drop channel, not in what the user reads.
    const drops = events.filter((e) => e.type === "tool_call_drop");
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({
      name: "not_in_catalog",
      reason: "unknown_name",
    });

    const texts = joinChannel(events, "text_delta");
    expect(texts).toContain("Before");
    expect(texts).toContain("After");
    expect(texts).not.toContain("not_in_catalog");
    expect(texts).not.toContain("<tool_call>");
  });

  it("reject after unterminated think: reasoning ends; span conserved once", async () => {
    const events = await runStream(
      ["<think>plan", '<tool_call>\n{"name":"not_known","arguments":{}}\n</tool_call>\n', "ok"],
      { dialect: "hermes", tools: [{ name: "x" }] },
    );
    const r = joinChannel(events, "reasoning_delta");
    const t = joinChannel(events, "text_delta");
    expect(r).toContain("plan");
    expect(r).not.toMatch(/tool_call|not_known|\bok\b/);
    // Name-certain but unknown: dropped, so it leaves neither channel as text.
    const drops = events.filter((e) => e.type === "tool_call_drop");
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ name: "not_known" });
    expect(t).not.toContain("not_known");
    expect(t).toContain("ok");
  });
});
