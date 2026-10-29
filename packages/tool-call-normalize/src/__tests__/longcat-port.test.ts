import { describe, expect, it, beforeEach } from "vitest";

import { normalizeMessage, LONGCAT_NAME_ALIASES, LONGCAT_ARG_ALIASES, ensureBuiltins } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";

describe("longcat port (from longcat_tools tests)", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  it("JSON body form", () => {
    const r = normalizeMessage(
      `Ok.
<longcat_tool_call>
{"name": "read_file", "arguments": {"path": "a.ts"}}
</longcat_tool_call>`,
      {
        dialect: "longcat",
        nameAliases: LONGCAT_NAME_ALIASES,
        argAliases: LONGCAT_ARG_ALIASES,
      },
    );
    expect(r.content?.trim()).toBe("Ok.");
    expect(r.tool_calls.map((t) => t.function.name)).toEqual(["read_file"]);
  });

  it("unclosed trailing block marked partial", () => {
    const r = normalizeMessage(
      `hi<longcattoolcall>readfile
<longcatargkey>path</longcatargkey>
<longcatargvalue>x.py</longcatargvalue>`,
      {
        dialect: "longcat",
        nameAliases: LONGCAT_NAME_ALIASES,
        argAliases: LONGCAT_ARG_ALIASES,
      },
    );
    expect(r.content).toBe("hi");
    expect(r.tool_calls[0]!.function.name).toBe("read_file");
    expect(r.meta.partial.length).toBeGreaterThanOrEqual(1);
  });

  it("multiple consecutive calls", () => {
    const r = normalizeMessage(
      `<longcat_tool_call>
{"name":"read_file","arguments":{"path":"a"}}
</longcat_tool_call><longcat_tool_call>
{"name":"read_file","arguments":{"path":"b"}}
</longcat_tool_call>`,
      {
        dialect: "longcat",
        nameAliases: LONGCAT_NAME_ALIASES,
      },
    );
    expect(r.tool_calls).toHaveLength(2);
  });
});
