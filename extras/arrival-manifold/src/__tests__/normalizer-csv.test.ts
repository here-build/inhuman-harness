// Strict CSV/TSV recognizer tests (response-normalizer §4.1). Design law under test:
// strict-or-refuse — a refusal is free, a misparse is silent corruption. Every case here
// either asserts a specific, correctly-shaped ok:true value, or asserts ok:false and never
// inspects a partial/best-effort value (there is none to inspect).

import { describe, expect, it } from "vitest";

import { parseCsvStrict } from "../normalizer/csv.js";

describe("parseCsvStrict", () => {
  it("parses real CSV with an identifier-like header and 3 data rows", () => {
    const result = parseCsvStrict("name,age,city\nAlice,30,NYC\nBob,25,LA\nCara,22,SF");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.format).toBe("csv");
    expect(result.value).toEqual([
      { name: "Alice", age: "30", city: "NYC" },
      { name: "Bob", age: "25", city: "LA" },
      { name: "Cara", age: "22", city: "SF" },
    ]);
  });

  it("parses the TSV variant of the same shape, tagging format tsv", () => {
    const result = parseCsvStrict("name\tage\tcity\nAlice\t30\tNYC\nBob\t25\tLA\nCara\t22\tSF");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.format).toBe("tsv");
    expect(result.value).toEqual([
      { name: "Alice", age: "30", city: "NYC" },
      { name: "Bob", age: "25", city: "LA" },
      { name: "Cara", age: "22", city: "SF" },
    ]);
  });

  it("refuses the address-list counterexample — audit F5, the load-bearing guard", () => {
    // Consistent 2 columns, 3 lines — but the "header" is street-address prose, not a
    // label row. Column-count consistency alone is NOT sufficient (per §4.1); the header
    // must independently look like a set of identifiers.
    const result = parseCsvStrict("123 Main St, Springfield\n456 Oak Ave, Shelbyville\n789 Elm Rd, Capital City");
    expect(result.ok).toBe(false);
  });

  it("refuses header + 1 data row — not enough evidence this is tabular (rule 2)", () => {
    const result = parseCsvStrict("a,b\n1,2");
    expect(result.ok).toBe(false);
  });

  it("refuses single-column input regardless of content", () => {
    const result = parseCsvStrict("alpha\nbeta\ngamma\ndelta");
    expect(result.ok).toBe(false);
  });

  it("refuses ragged rows (inconsistent column count)", () => {
    const result = parseCsvStrict("a,b\n1,2\n3,4,5");
    expect(result.ok).toBe(false);
  });

  it("parses a quoted field containing a comma, preserving the comma in the value", () => {
    const result = parseCsvStrict('name,note\n1,"Smith, esq"\n2,"Doe, jr"');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.format).toBe("csv");
    expect(result.value).toEqual([
      { name: "1", note: "Smith, esq" },
      { name: "2", note: "Doe, jr" },
    ]);
  });

  it('parses a quoted field with an RFC-4180 escaped quote ("")', () => {
    const result = parseCsvStrict('name,note\n1,"She said ""hi"""\n2,"ok"');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).toEqual([
      { name: "1", note: 'She said "hi"' },
      { name: "2", note: "ok" },
    ]);
  });

  it("refuses a field with an unescaped newline (quote never re-balances)", () => {
    // The lone `"` before "unterminated" opens a quoted field that is never closed —
    // every subsequent newline is swallowed into that field instead of ending a row,
    // so quote-balance never recovers by end of input. That IS the "unescaped newline
    // inside a field" structural violation: refuse, never guess where the field ends.
    const result = parseCsvStrict('name,note\n1,"unterminated\n2,ok\n3,fine');
    expect(result.ok).toBe(false);
  });

  it("refuses prose with incidental commas (too few rows, no real header)", () => {
    const result = parseCsvStrict("Results for query: foo, bar, baz\nMore prose here, again");
    expect(result.ok).toBe(false);
  });

  it("refuses a markdown pipe-table — not CSV/TSV at all", () => {
    const result = parseCsvStrict("|a|b|\n|---|---|\n|1|2|");
    expect(result.ok).toBe(false);
  });

  it("refuses a numeric header", () => {
    const result = parseCsvStrict("1,2\n3,4");
    expect(result.ok).toBe(false);
  });

  it("refuses when both delimiters produce a plausible-looking table (never coin-flips)", () => {
    // Every row carries exactly one comma AND one tab, so BOTH splits find a
    // structurally consistent 2-column table (header + 2 data rows). Under comma-split,
    // the header's second cell ("name\textra") still carries the literal tab character
    // internally and fails header-plausibility; under tab-split, the header's first cell
    // ("id,name") still carries the literal comma and fails the same way. Since the
    // header-plausibility charset (§4.1) excludes both delimiter characters, a header row
    // can never simultaneously validate under two different delimiter splits — so this is
    // the reachable shape of "ambiguous": both readings look tabular, neither confirms,
    // and the function refuses rather than silently picking one.
    const result = parseCsvStrict("id,name\textra\n1,Alice\tfoo\n2,Bob\tbar");
    expect(result.ok).toBe(false);
  });

  it("refuses when an explicit delimiter is pinned but the input doesn't validate under it", () => {
    const result = parseCsvStrict("a,b\nc,d\ne,f", "\t");
    expect(result.ok).toBe(false);
  });

  it("honors an explicitly pinned delimiter even when the other would also parse", () => {
    const result = parseCsvStrict("name,age\nAlice,30\nBob,25", ",");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.format).toBe("csv");
  });
});
