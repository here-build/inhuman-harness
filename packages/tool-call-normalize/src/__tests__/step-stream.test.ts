/**
 * createStreamSession + Dialect.step: name-certain start before close.
 */
import { describe, expect, it, beforeEach } from "vitest";

import { ensureBuiltins } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";
import { collectEvents } from "./stream-harness.js";

describe("stream + step() name-certainty", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  it("hermes: start fires before close chunk", () => {
    const events = collectEvents(
      ["Hi\n", "<tool_call>\n", '{"name":"get_weather","arguments":', '{"city":"SF"}}\n', "</tool_call>\n", "bye"],
      { dialect: "hermes" },
    );
    const types = events.map((e) => e.type);
    const startIdx = types.indexOf("tool_call_start");
    const endIdx = types.indexOf("tool_call_end");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    const byeIdx = types.lastIndexOf("text_delta");
    expect(byeIdx).toBeGreaterThan(endIdx);
    const start = events[startIdx] as { name: string };
    expect(start.name).toBe("get_weather");
  });

  it("qwen: start at function open, end at close", () => {
    const events = collectEvents(["<function=read_file>\n", "<parameter=path>x.ts</parameter>\n", "</function>"], {
      dialect: "qwen_xml",
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
    const starts = events.filter((e) => e.type === "tool_call_start");
    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(starts).toHaveLength(1);
    expect((starts[0] as { name: string }).name).toBe("read_file");
    expect(ends).toHaveLength(1);
    expect(JSON.parse((ends[0] as { arguments: string }).arguments)).toEqual({ path: "x.ts" });
  });
});
