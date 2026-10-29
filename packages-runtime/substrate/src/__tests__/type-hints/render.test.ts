// Pins the frozen RenderHint contract: TS carrier vocabulary must NEVER leak into the
// rendered scheme-facing string (the bifunctor discipline). Returns null — never a
// half-rendered hint — whenever any part is unrenderable: a skipped hint is invisible, a
// wrong hint is poison.
//
// RED suite: render.ts does not exist yet, by design. See src/__red__/README.md for the
// migration path once it lands.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderHint } from "../../type-hints/render.js";
import type { MappedDiagnostic, SelectedHint } from "../../type-hints/types.js";

// ─── fixture factories ───

/** A MappedDiagnostic fixture. `span` is irrelevant to render.ts (select.ts already used
 *  it) so a placeholder is fine unless a test overrides it. */
function diag(overrides: Partial<MappedDiagnostic> & { code: number }): MappedDiagnostic {
  return { span: { start: 0, end: 1 }, tsMessage: "stub diagnostic message", ...overrides };
}

function hint(diagnostic: MappedDiagnostic, statementIndex = 0): SelectedHint {
  return { statementIndex, diagnostic };
}

// ─── the TS-never-leaks vocabulary blacklist — the ONE output-blacklist ───
//
// Every test in this file that expects a rendered (non-null) string MUST go through this
// `render` helper instead of calling `renderHint` directly, so the blacklist is checked
// for every rendered output produced anywhere in the file — not just in the dedicated
// blacklist describe block below.

function assertNoTsLeak(text: string): void {
  expect(text).not.toContain("Cons<");
  expect(text).not.toContain("readonly");
  expect(text).not.toContain("Promise<");
  expect(text).not.toMatch(/TS\d{4}/);
  expect(text).not.toContain("undefined");
}

let renderedThisTest: string[] = [];
beforeEach(() => {
  renderedThisTest = [];
});
afterEach(() => {
  for (const text of renderedThisTest) assertNoTsLeak(text);
});

/** The one call site every test in this file should use in place of `renderHint` directly. */
function render(h: SelectedHint, statementHead: string): string | null {
  const out = renderHint(h, statementHead);
  if (out !== null) renderedThisTest.push(out);
  return out;
}

describe("§4 — type back-translation vocabulary (shape pinned, full sentence not pinned)", () => {
  it("List<number> back-translates through 'a list of numbers'", () => {
    const out = render(hint(diag({ code: 2345, expected: "List<number>", actual: "string" })), "f");
    expect(out).not.toBeNull();
    expect(out).toContain("a list of numbers");
  });

  it("readonly string[] back-translates through 'a vector of strings'", () => {
    const out = render(hint(diag({ code: 2345, expected: "readonly string[]", actual: "number" })), "f");
    expect(out).not.toBeNull();
    expect(out).toContain("a vector of strings");
  });

  it("an object literal type back-translates to {:key type ...} scheme dict notation", () => {
    const out = render(
      hint(diag({ code: 2345, expected: "{ total: number; status: string }", actual: "string" })),
      "f",
    );
    expect(out).not.toBeNull();
    expect(out).toMatch(/\{:total number/);
  });

  it("string | null back-translates through 'a string or nil'", () => {
    const out = render(hint(diag({ code: 2345, expected: "string | null", actual: "number" })), "f");
    expect(out).not.toBeNull();
    expect(out).toContain("a string or nil");
  });
});

describe("§4 — unrenderable → null (never a half-rendered hint)", () => {
  it("a conditional type string in `expected` (contains 'extends' with a '?') → null", () => {
    const out = render(hint(diag({ code: 2345, expected: "T extends string ? A : B", actual: "number" })), "f");
    expect(out).toBeNull();
  });

  it("generic nesting depth > 3 in `expected` → null", () => {
    // 4 levels of Array<...> nesting — unambiguously past any depth>3 threshold, regardless
    // of the exact depth-counting algorithm: only the ">3" cutoff is pinned, not the method.
    const out = render(
      hint(diag({ code: 2345, expected: "Array<Array<Array<Array<number>>>>", actual: "string" })),
      "f",
    );
    expect(out).toBeNull();
  });
});

describe("§4 — action-by-mismatch-kind (the action comes from the mismatch SHAPE, never free-composed)", () => {
  it("string-where-number carries the (string->number ...) action", () => {
    const out = render(hint(diag({ code: 2345, expected: "number", actual: "string" })), "f");
    expect(out).not.toBeNull();
    expect(out).toContain("(string->number");
  });

  it("unknown-kwarg (2353, propertyName + candidateProperties) carries a did-you-mean naming the nearest candidate", () => {
    const out = render(
      hint(diag({ code: 2353, propertyName: "max_result", candidateProperties: ["max_results", "query"] })),
      "shop_list_orders",
    );
    expect(out).not.toBeNull();
    expect(out).toContain("max_results");
  });

  it("arity (2554) restates the parameter list", () => {
    // NB: types.ts does not pin which MappedDiagnostic field carries the parameter list
    // for an arity mismatch (unlike 2353, where propertyName/candidateProperties are
    // explicitly documented). Both plausible carriers are populated here so the fixture
    // is valid regardless of which one the implementation reads from.
    const out = render(
      hint(
        diag({
          code: 2554,
          expected: "(query: string, max_results?: number) => unknown",
          candidateProperties: ["query", "max_results"],
        }),
      ),
      "shop_search",
    );
    expect(out).not.toBeNull();
    expect(out).toContain("query");
    expect(out).toContain("max_results");
  });

  it("G12: the rendered string names the passed statementHead (trailing-block head naming)", () => {
    const out = render(hint(diag({ code: 2345, expected: "number", actual: "string" })), ":total");
    expect(out).not.toBeNull();
    expect(out).toContain(":total");
  });
});

describe("§4 — null-propagation (missing structured fields the diagnostic's kind needs)", () => {
  it("2345 (argument type mismatch) without expected/actual → null, never a half-rendered hint", () => {
    const out = render(hint(diag({ code: 2345 })), "f");
    expect(out).toBeNull();
  });

  it("2353 (unknown property) without propertyName/candidateProperties → null", () => {
    const out = render(hint(diag({ code: 2353 })), "f");
    expect(out).toBeNull();
  });
});

describe("§4/§7 — the TS-never-leaks vocabulary blacklist, as its own explicit test", () => {
  it("none of this file's rendered fixtures leak Cons<, readonly, Promise<, TS####, or undefined", () => {
    // Re-render a representative sample directly (in addition to the afterEach hook above,
    // which already checked every render() call in this file) so the invariant has one
    // dedicated, self-contained assertion callers can point to.
    const samples = [
      render(hint(diag({ code: 2345, expected: "List<number>", actual: "string" })), "f"),
      render(hint(diag({ code: 2345, expected: "readonly string[]", actual: "number" })), "f"),
      render(hint(diag({ code: 2345, expected: "string | null", actual: "number" })), "f"),
    ];
    for (const s of samples) {
      expect(s).not.toBeNull();
      assertNoTsLeak(s!);
    }
  });
});
