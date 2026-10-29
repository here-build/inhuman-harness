import dedent from "dedent";
import { describe, expect, it, beforeEach } from "vitest";

import { normalizeMessage, ensureBuiltins } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";

describe("requireKnownTool", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  const hermesUnknown = dedent`
    <tool_call>
    {"name": "totally_fake_tool", "arguments": {"x": 1}}
    </tool_call>
  `;

  const hermesKnown = dedent`
    <tool_call>
    {"name": "read_file", "arguments": {"path": "a.ts"}}
    </tool_call>
  `;

  it("drops recovered unknown when tools[] present (default on)", () => {
    const r = normalizeMessage(hermesUnknown, {
      dialect: "hermes",
      tools: [{ name: "read_file", parameters: { type: "object" } }],
    });
    expect(r.tool_calls).toEqual([]);
    expect(r.meta.dropped.some((d) => d.reason === "unknown_name")).toBe(true);
  });

  it("keeps recovered known catalog name", () => {
    const r = normalizeMessage(hermesKnown, {
      dialect: "hermes",
      tools: [{ name: "read_file" }],
    });
    expect(r.tool_calls.map((t) => t.function.name)).toEqual(["read_file"]);
  });

  it("empty tools[] still recovers (open path)", () => {
    const r = normalizeMessage(hermesUnknown, { dialect: "hermes" });
    expect(r.tool_calls.map((t) => t.function.name)).toEqual(["totally_fake_tool"]);
  });

  it("requireKnownTool: false keeps unknown recovered", () => {
    const r = normalizeMessage(hermesUnknown, {
      dialect: "hermes",
      tools: [{ name: "read_file" }],
      requireKnownTool: false,
    });
    expect(r.tool_calls.map((t) => t.function.name)).toEqual(["totally_fake_tool"]);
  });

  it("does not drop unknown natives (requireKnown is recovered-only)", () => {
    const r = normalizeMessage(
      {
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "native_unknown",
              arguments: "{}",
            },
          },
        ],
      },
      {
        mode: "repair",
        tools: [{ name: "read_file" }],
      },
    );
    expect(r.tool_calls.map((t) => t.function.name)).toEqual(["native_unknown"]);
  });
});
