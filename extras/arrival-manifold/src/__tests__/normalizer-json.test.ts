// normalizer/json — strict-or-refuse pins for the response-normalizer's JSON/NDJSON
// recognizers. Every fixture here traces
// to a named audit finding (F3/NEW-6 scalar-yield corruption, §4.2 NDJSON objects-only
// ≥2-line gate) — the point of the suite is that a refusal is free and a misparse is not.

import { describe, expect, it } from "vitest";

import { parseJsonStrict, parseNdjsonStrict } from "../normalizer/json.js";

describe("parseJsonStrict", () => {
  it("accepts a top-level object", () => {
    const result = parseJsonStrict('{"a":1}');
    expect(result).toEqual({ ok: true, value: { a: 1 }, format: "json" });
  });

  it("accepts a top-level array", () => {
    const result = parseJsonStrict('[{"a":1},{"b":2}]');
    expect(result).toEqual({ ok: true, value: [{ a: 1 }, { b: 2 }], format: "json" });
  });

  it("tolerates leading/trailing whitespace around a valid object", () => {
    const result = parseJsonStrict('  \n {"a":1}\t\n  ');
    expect(result).toEqual({ ok: true, value: { a: 1 }, format: "json" });
  });

  it.each([
    ["123", "number"],
    ['"hello"', "string"],
    ["true", "boolean"],
    ["null", "null"],
    ["23.5", "number"],
  ])("refuses a scalar-yield: %s", (input) => {
    const result = parseJsonStrict(input);
    expect(result.ok).toBe(false);
  });

  it("refuses '0123' (invalid JSON syntax — leading zero)", () => {
    const result = parseJsonStrict("0123");
    expect(result.ok).toBe(false);
  });

  it(
    "'0123' and '123' both refuse, and via the SAME outcome shape (F3/NEW-6: a real fix " +
      "does not let one scalar's digit content decide whether it survives as a value while a " +
      "structurally-similar sibling doesn't)",
    () => {
      const a = parseJsonStrict("0123");
      const b = parseJsonStrict("123");
      expect(a.ok).toBe(false);
      expect(b.ok).toBe(false);
      // Both are refusals — neither produced a value, regardless of why parsing/kind-checking
      // rejected them. Digit content never determines pass/fail asymmetrically.
      expect(a.ok).toBe(b.ok);
    },
  );

  it("refuses malformed JSON with a syntax reason, not a crash", () => {
    const result = parseJsonStrict("{not json");
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("not valid JSON") });
  });

  it("refuses prose that happens to contain braces", () => {
    const result = parseJsonStrict("Commit history:\nCommit: abc");
    expect(result.ok).toBe(false);
  });

  it("accepts a huge valid object with no size cap (capping is the caller's job)", () => {
    const bigObject: Record<string, number> = {};
    for (let i = 0; i < 50_000; i++) {
      bigObject[`key${i}`] = i;
    }
    const result = parseJsonStrict(JSON.stringify(bigObject));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.value as Record<string, number>)).toHaveLength(50_000);
    }
  });
});

describe("parseNdjsonStrict", () => {
  it("accepts 3 lines of objects as an array of 3", () => {
    const result = parseNdjsonStrict('{"a":1}\n{"a":2}\n{"a":3}');
    expect(result).toEqual({
      ok: true,
      value: [{ a: 1 }, { a: 2 }, { a: 3 }],
      format: "jsonl",
    });
  });

  it("refuses when one line is an array among objects", () => {
    const result = parseNdjsonStrict('{"a":1}\n[1,2]\n{"a":3}');
    expect(result.ok).toBe(false);
  });

  it("refuses a single object line (that's just JSON, not NDJSON — use parseJsonStrict)", () => {
    const result = parseNdjsonStrict('{"a":1}');
    expect(result.ok).toBe(false);
  });

  it("tolerates blank lines between objects (filtered before the line-count / per-line checks)", () => {
    const result = parseNdjsonStrict('{"a":1}\n\n{"a":2}\n\n\n{"a":3}');
    expect(result).toEqual({
      ok: true,
      value: [{ a: 1 }, { a: 2 }, { a: 3 }],
      format: "jsonl",
    });
  });

  it("refuses when a line is a bare scalar", () => {
    const result = parseNdjsonStrict('{"a":1}\n123\n{"a":3}');
    expect(result.ok).toBe(false);
  });

  it("refuses when a line fails to parse at all", () => {
    const result = parseNdjsonStrict('{"a":1}\n{not json}\n{"a":3}');
    expect(result.ok).toBe(false);
  });

  it("refuses prose", () => {
    const result = parseNdjsonStrict("Commit history:\nCommit: abc");
    expect(result.ok).toBe(false);
  });
});
