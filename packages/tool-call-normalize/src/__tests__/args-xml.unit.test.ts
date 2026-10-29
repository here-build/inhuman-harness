import { describe, expect, it } from "vitest";

import { tryParseFunctionArguments } from "../args-xml.js";

describe("args-xml (Continue #11453 class)", () => {
  it("parses normal JSON args", () => {
    const r = tryParseFunctionArguments('{"dirPath":"src"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.arguments)).toEqual({ dirPath: "src" });
  });

  it("parses <parameter=name>value</parameter>", () => {
    const raw = `<tool_call>
<function=ls>
<parameter=dirPath>
src
</parameter>
<parameter=recursive>
True
</parameter>
</function>
</tool_call>`;
    const r = tryParseFunctionArguments(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(JSON.parse(r.arguments)).toEqual({
        dirPath: "src",
        recursive: true,
      });
    }
  });

  it("returns ok:false for prose garbage", () => {
    const r = tryParseFunctionArguments("just some text, not args");
    expect(r.ok).toBe(false);
  });
});
