import { describe, expect, it } from "vitest";

import { valueJson, valueSummary } from "../workflow/value-summary.js";
import { verbLabel } from "../workflow/verb-label.js";

describe("valueSummary", () => {
  it("keeps a string as prose", () => {
    expect(valueSummary("LGTM, ship it.")).toBe("LGTM, ship it.");
    expect(valueSummary(undefined)).toBe("");
  });

  it("reads a flat record as words", () => {
    expect(valueSummary({ warnings: 3, errors: 0 })).toBe("warnings 3 · errors 0");
  });

  it("prefers a title, name, or summary when one is present", () => {
    expect(valueSummary({ title: "Split the api seam", state: "open" })).toBe("Split the api seam");
    expect(valueSummary({ name: "porter", n: 1 })).toBe("porter");
    expect(valueSummary({ summary: "clean", extra: true })).toBe("clean");
    expect(valueSummary({ title: "  ", summary: "kept" })).toBe("kept");
  });

  it("counts a record that is nested or too wide", () => {
    expect(valueSummary({ a: 1, b: { c: 2 } })).toBe("2 fields");
    expect(valueSummary({})).toBe("0 fields");
    expect(valueSummary({ a: 1, b: 2, c: 3, d: 4, e: 5 })).toBe("5 fields");
  });

  it("summarizes a list without JSON", () => {
    expect(valueSummary(["src/ui.tsx:12: TODO"])).toBe("src/ui.tsx:12: TODO");
    expect(valueSummary([1, 2, 3, 4, 5])).toBe("5 items");
    expect(valueSummary([])).toBe("0 items");
  });

  it("keeps JSON for the expanded view only", () => {
    expect(valueSummary({ warnings: 3, errors: 0 })).not.toContain("{");
    expect(valueJson({ warnings: 3, errors: 0 })).toBe('{\n  "warnings": 3,\n  "errors": 0\n}');
  });
});

describe("verbLabel", () => {
  it("reads a slash wire verb as words", () => {
    expect(verbLabel("mcp/call")).toBe("MCP call");
    expect(verbLabel("read file")).toBe("read file");
  });
});
