// Unique failure: a wrapping top-level `(begin …)` / `(list …)` / `[]` collapses
// to one form, so the REPL keeps only the last value and `analyzeStatement`
// misses inner defines. Nested wrappers (inside `if`) stay one form.

import { parse } from "@here.build/arrival";
import { writeForm } from "@here.build/arrival/provenance";
import { describe, expect, it } from "vitest";

import { unwrapTopLevel, unwrapTopLevelBegins, unwrapTopLevelSource } from "../unwrap-begin.js";

async function spliced(src: string): Promise<string[]> {
  const forms = unwrapTopLevelBegins(await parse(src));
  return forms.map((form) => writeForm(form));
}

describe("unwrapTopLevelBegins", () => {
  it.each([
    ["(+ 1 2)", ["(+ 1 2)"]],
    ["(begin (+ 1 2) (+ 3 4))", ["(+ 1 2)", "(+ 3 4)"]],
    ["(begin (begin 1) 2)", ["1", "2"]],
    ["(+ 1 2) (begin 3 4)", ["(+ 1 2)", "3", "4"]],
    ["(if #t (begin 1 2))", ["(if #t (begin 1 2))"]],
    ["(begin)", []],
    ["(begin . 1)", ["(begin . 1)"]],
    ["'(begin 1 2)", ["(quote (begin 1 2))"]],
    ["(list (+ 1 2) (+ 3 4))", ["(+ 1 2)", "(+ 3 4)"]],
    ["(list (list 1) 2)", ["1", "2"]],
    ["(if #t (list 1 2))", ["(if #t (list 1 2))"]],
    ["(list)", []],
    ["(list . 1)", ["(list . 1)"]],
    ["'(list 1 2)", ["(quote (list 1 2))"]],
    ["[(+ 1 2) (+ 3 4)]", ["(+ 1 2)", "(+ 3 4)"]],
    ["[[1] 2]", ["1", "2"]],
    ["(if #t [1 2])", ["(if #t [1 2])"]],
    ["[]", []],
    ["'[]", ["(quote [])"]],
    ["(list (begin 1) [2 3])", ["1", "2", "3"]],
  ] as const)("%s", async (src, want) => {
    expect(await spliced(src)).toEqual([...want]);
  });
});

describe("unwrapTopLevelSource", () => {
  it.each([
    ["(+ 1 2)", "(+ 1 2)"],
    ["(begin (+ 1 2) (+ 3 4))", "(+ 1 2)\n(+ 3 4)"],
    ["(list (+ 1 2) (+ 3 4))", "(+ 1 2)\n(+ 3 4)"],
    ["[(+ 1 2) (+ 3 4)]", "(+ 1 2)\n(+ 3 4)"],
    ["(if #t (begin 1 2))", "(if #t (begin 1 2))"],
    ["(if #t (list 1 2))", "(if #t (list 1 2))"],
    ["(if #t [1 2])", "(if #t [1 2])"],
    ["(+ 1 2) (begin 3 4)", "(+ 1 2)\n3\n4"],
    ["'(begin 1 2)", "'(begin 1 2)"],
    ["(begin . 1)", "(begin . 1)"],
    ["(list . 1)", "(list . 1)"],
    ["; keep comments\n(+ 1 2)", "; keep comments\n(+ 1 2)"],
  ] as const)("%s", (src, want) => {
    expect(unwrapTopLevelSource(src)).toBe(want);
  });
});

describe("unwrapTopLevel kinds", () => {
  it("names each splice spelling once, in first-seen order", async () => {
    const mixed = unwrapTopLevel(await parse("(list (begin 1) [2 3])"));
    const beginOnly = unwrapTopLevel(await parse("(begin 1 2)"));
    const listed = unwrapTopLevel(await parse("(list 1 2)"));
    const vector = unwrapTopLevel(await parse("[1 2]"));
    const nested = unwrapTopLevel(await parse("(if #t (begin 1 2))"));
    expect({
      mixed: mixed.kinds,
      beginOnly: beginOnly.kinds,
      listed: listed.kinds,
      vector: vector.kinds,
      nested: nested.kinds,
    }).toEqual({
      mixed: ["list", "begin", "vector"],
      beginOnly: ["begin"],
      listed: ["list"],
      vector: ["vector"],
      nested: [],
    });
  });
});
