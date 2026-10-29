import { describe, expect, it, beforeEach } from "vitest";

import { ensureBuiltins, normalizeMessage } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";

describe("longcat dual-form", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  it("JSON-looking content inside arg_value stays tagged form", () => {
    const body = `<longcattoolcall>
writefile
<longcatargkey>path</longcatargkey>
<longcatargvalue>x.json</longcatargvalue>
<longcatargkey>content</longcatargkey>
<longcatargvalue>{"name":"not_a_tool"}</longcatargvalue>
</longcattoolcall>`;
    const r = normalizeMessage(body, {
      dialect: "longcat",
      mode: "repair",
      tools: [
        {
          name: "write_file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
          },
        },
      ],
    });
    expect(r.tool_calls.map((t) => t.function.name)).toEqual(["write_file"]);
    const args = JSON.parse(r.tool_calls[0]!.function.arguments);
    expect(args.content).toBe('{"name":"not_a_tool"}');
  });

  it("close marker inside arg_value does not truncate extract", () => {
    const body = `<longcattoolcall>
writefile
<longcatargkey>path</longcatargkey>
<longcatargvalue>a.ts</longcatargvalue>
<longcatargkey>content</longcatargkey>
<longcatargvalue>see </longcattoolcall> inside</longcatargvalue>
</longcattoolcall>`;
    const r = normalizeMessage(body, {
      dialect: "longcat",
      mode: "repair",
      tools: [
        {
          name: "write_file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
          },
        },
      ],
    });
    expect(r.tool_calls).toHaveLength(1);
    expect(r.meta.partial).toEqual([]);
    const args = JSON.parse(r.tool_calls[0]!.function.arguments);
    expect(args.path).toBe("a.ts");
    expect(args.content).toContain("</longcattoolcall>");
    expect(args.content).toContain("inside");
  });
});
