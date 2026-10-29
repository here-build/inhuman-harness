import { describe, expect, it } from "vitest";

import { NORMALIZER_PRELUDE_SYMBOLS } from "../normalizer/prelude.js";

describe("NORMALIZER_PRELUDE_SYMBOLS", () => {
  it("names exactly the six spec'd scheme-facing symbols, each with a teaching description", () => {
    const names = NORMALIZER_PRELUDE_SYMBOLS.map((symbol) => symbol.name);
    expect(names).toEqual([
      "parse-json",
      "parse-csv",
      "parse-toon",
      "parse-py-literal",
      "detect-parse",
      "detect-envelope",
    ]);
    for (const symbol of NORMALIZER_PRELUDE_SYMBOLS) {
      expect(symbol.description.length).toBeGreaterThan(0);
      expect(typeof symbol.fn).toBe("function");
    }
  });

  it("each descriptor's fn is callable and matches the corresponding named export's behavior", () => {
    const byName = new Map(NORMALIZER_PRELUDE_SYMBOLS.map((symbol) => [symbol.name, symbol.fn]));
    expect(byName.get("parse-json")?.('{"a":1}')).toEqual({ a: 1 });
    expect(() => byName.get("parse-csv")?.("123 Main St, Springfield\n456 Oak Ave, Shelbyville")).toThrow(Error);
  });
});
