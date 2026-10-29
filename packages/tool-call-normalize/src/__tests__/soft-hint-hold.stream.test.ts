/**
 * audit-014 H2: modelHint must not narrow hold markers (union of allowStreamAuto).
 */
import { describe, expect, it, beforeEach } from "vitest";

import { ensureBuiltins } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";
import { collectEvents } from "./stream-harness.js";

describe("soft-hint hold union", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  it("qwen bare function under longcat modelHint is held (not painted)", () => {
    const input = "Sure.<function=read_file><parameter=path>a.txt</parameter></function> done";
    const chunks: string[] = [];
    for (let i = 0; i < input.length; i += 7) {
      chunks.push(input.slice(i, i + 7));
    }
    const events = collectEvents(chunks, {
      dialect: "auto",
      modelHint: "longcat-flash",
      mode: "repair",
      tools: [
        {
          name: "read_file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
    });
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("");
    expect(text).not.toMatch(/<function=/i);
    expect(text).toMatch(/Sure/);
    expect(text).toMatch(/done/);
    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(ends.length).toBe(1);
  });
});
