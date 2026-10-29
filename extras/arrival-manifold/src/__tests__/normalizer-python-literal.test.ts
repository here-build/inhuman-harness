import { describe, expect, it } from "vitest";

import { parsePythonLiteralStrict } from "../normalizer/python-literal.js";

/** Narrowing helper — every accept-path assertion needs `value` visible without repeating the
 *  `ok === true` guard at each call site. */
function ok(s: string): unknown {
  const outcome = parsePythonLiteralStrict(s);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("unreachable");
  expect(outcome.format).toBe("python-literal");
  return outcome.value;
}

function refused(s: string): string {
  const outcome = parsePythonLiteralStrict(s);
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("unreachable");
  return outcome.reason;
}

describe("parsePythonLiteralStrict — accept", () => {
  it("parses a flat dict with mixed value types (required fixture)", () => {
    expect(ok("{'a': 1, 'b': 'two', 'c': True, 'd': None}")).toEqual({
      a: 1,
      b: "two",
      c: true,
      d: null,
    });
  });

  it("parses a list of dicts (required fixture)", () => {
    expect(ok("[{'k': 'v'}, {'k': 'w'}]")).toEqual([{ k: "v" }, { k: "w" }]);
  });

  it("parses a dict nested three levels deep", () => {
    expect(ok("{'a': {'b': {'c': 1}}}")).toEqual({ a: { b: { c: 1 } } });
  });

  it(String.raw`parses string escapes: \' \" \\ \n \t`, () => {
    expect(ok(String.raw`{'s': 'it\'s'}`)).toEqual({ s: "it's" });
    expect(ok(String.raw`{"s": "line\nbreak\ttab\\slash\"quote"}`)).toEqual({
      s: 'line\nbreak\ttab\\slash"quote',
    });
  });

  it("parses the airflow-realistic shape (str(dict) response)", () => {
    expect(ok("{'dag_id': 'x', 'is_paused': False, 'tags': []}")).toEqual({
      dag_id: "x",
      is_paused: false,
      tags: [],
    });
  });

  it("parses negative ints, floats, and exponent notation", () => {
    expect(ok("{'x': -3.5, 'y': 2.1e10, 'z': -4E-2}")).toEqual({
      x: -3.5,
      y: 2.1e10,
      z: -4e-2,
    });
  });

  it("tolerates whitespace around tokens", () => {
    expect(ok("  {  'a'  :  1  ,  'b'  :  [ 1 , 2 ]  }  ")).toEqual({ a: 1, b: [1, 2] });
  });

  it("accepts an empty dict and an empty list at the top level", () => {
    expect(ok("{}")).toEqual({});
    expect(ok("[]")).toEqual([]);
  });

  // --- JSON-overlap decision -------------------------------------------------------------
  // Some inputs are simultaneously valid JSON and valid Python-literal syntax: a
  // double-quoted string and a bare number read identically in both grammars, with no
  // ambiguity to resolve. This parser ACCEPTS that overlap rather than adding detection
  // logic to refuse something harmless (see module header for the full rationale). It does
  // NOT accept JSON's lowercase true/false/null spelling, because that spelling is not part
  // of the Python grammar at all (`str(dict)` never emits it) — that half is covered under
  // "refuse" below.
  it("accepts input that is simultaneously valid JSON (double quotes, no python-only tokens)", () => {
    expect(ok('{"a": 1, "b": "two"}')).toEqual({ a: 1, b: "two" });
  });
});

describe("parsePythonLiteralStrict — refuse", () => {
  it("refuses a bare top-level scalar: None / True / 123 / string", () => {
    expect(refused("None")).toMatch(/top-level scalar/i);
    expect(refused("True")).toMatch(/top-level scalar/i);
    expect(refused("123")).toMatch(/top-level scalar/i);
    expect(refused("'hello'")).toMatch(/top-level scalar/i);
  });

  it("refuses a tuple at the top level and recursively at any depth", () => {
    expect(refused("(1, 2)")).toMatch(/tuple/i);
    expect(refused("{'a': (1, 2)}")).toMatch(/tuple/i);
    expect(refused("[1, (2, 3)]")).toMatch(/tuple/i);
  });

  it("refuses a set at the top level and recursively at any depth (distinct from empty dict)", () => {
    expect(refused("{1, 2}")).toMatch(/set/i);
    expect(refused("{'a': {1, 2}}")).toMatch(/set/i);
    // Sanity: {} must NOT be mistaken for a set — it's Python's empty dict.
    expect(ok("{}")).toEqual({});
  });

  it("refuses non-string dict keys, including nested", () => {
    expect(refused("{1: 2}")).toMatch(/non-string.*key/i);
    expect(refused("{'a': {2: 3}}")).toMatch(/non-string.*key/i);
    expect(refused("{True: 'x'}")).toMatch(/non-string.*key/i);
  });

  it("refuses a datetime constructor repr", () => {
    expect(refused("{'a': datetime.datetime(2024, 9, 26)}")).toMatch(/repr|constructor/i);
  });

  it("refuses an object-repr leak", () => {
    expect(refused('<git.Actor "Matt">')).toMatch(/repr/i);
  });

  it("refuses bytes literals and f-strings", () => {
    expect(refused("b'hello'")).toMatch(/bytes|prefix/i);
    expect(refused("{'a': f'{x}'}")).toMatch(/f-string|prefix/i);
  });

  it("refuses trailing garbage after the literal", () => {
    expect(refused("{'a': 1} garbage")).toMatch(/trailing/i);
  });

  it("refuses empty input", () => {
    expect(refused("")).toMatch(/empty/i);
    expect(refused("   ")).toMatch(/empty/i);
  });

  // --- JSON-overlap decision, refuse half ------------------------------------------------
  it("refuses JSON's lowercase true/false/null spelling and points at the JSON parser", () => {
    expect(refused('{"a": true}')).toMatch(/json/i);
    expect(refused('{"a": false}')).toMatch(/json/i);
    expect(refused('{"a": null}')).toMatch(/json/i);
  });
});
