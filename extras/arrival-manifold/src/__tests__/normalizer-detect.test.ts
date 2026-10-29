// Composition-layer tests for the response-normalizer's detection surface. `detectParse`
// is pure delegation over the four strict recognizers in priority order; `detectEnvelope`
// is the end-anchored prose+embedded-STRUCTURE recognizer. Design law under test
// throughout: strict-or-refuse — a refusal is free, a misparse (or a fabricated envelope)
// is silent corruption.

import { describe, expect, it } from "vitest";

import { detectBlockEnvelope, detectEnvelope, detectParse } from "../normalizer/detect.js";

describe("detectParse", () => {
  it("detects whole-string JSON object", () => {
    const result = detectParse('{"a":1,"b":"two"}');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.format).toBe("json");
    expect(result.value).toEqual({ a: 1, b: "two" });
  });

  it("priority: a valid JSON array of 3 objects is JSON, never falls through to jsonl", () => {
    // Every element independently looks like an NDJSON row, but the whole string is one
    // JSON array — JSON must win outright, not merely first-match-wins by luck.
    const result = detectParse('[{"id":1},{"id":2},{"id":3}]');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.format).toBe("json");
    expect(result.value).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("falls through to NDJSON once whole-string JSON refuses", () => {
    const result = detectParse('{"id":1}\n{"id":2}\n{"id":3}');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.format).toBe("jsonl");
  });

  it("falls through to CSV once JSON/NDJSON refuse", () => {
    const result = detectParse("name,age\nAlice,30\nBob,25");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.format).toBe("csv");
  });

  it("falls through to TOON once JSON/NDJSON/CSV refuse", () => {
    const result = detectParse("items[2]{id,name}:\n  1,alpha\n  2,beta");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.format).toBe("toon");
  });

  it("falls through to Python-literal once every other grammar refuses", () => {
    const result = detectParse("{'a': 1, 'b': 'two'}");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.format).toBe("python-literal");
    expect(result.value).toEqual({ a: 1, b: "two" });
  });

  it("refuses with 'no recognized format' when every recognizer refuses", () => {
    const result = detectParse("just some ordinary prose, nothing structured here");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("no recognized format");
  });
});

describe("detectEnvelope", () => {
  it("whole-string JSON object: ok, no prefix/suffix, raw === the string", () => {
    const s = '{"a":1,"b":2}';
    const result = detectEnvelope(s);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.raw).toBe(s);
    expect(result.value.value).toEqual({ a: 1, b: 2 });
    expect(result.value.prefix).toBeUndefined();
    expect(result.value.suffix).toBeUndefined();
  });

  it("whole-string JSON tolerates pure-whitespace padding — no envelope fields (empty-leftover rule)", () => {
    // JSON.parse itself is whitespace-tolerant, so this is caught by the whole-string
    // attempt (rule 1) before any anchored-span logic runs at all.
    const result = detectEnvelope('   {"a":1}   ');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.value).toEqual({ a: 1 });
    expect(result.value.prefix).toBeUndefined();
    expect(result.value.suffix).toBeUndefined();
  });

  it("opik case: bracketed-but-invalid prefix label, JSON suffix — prefix captured, value unwrapped", () => {
    const s = '[label: read]\n{"a":1}';
    const result = detectEnvelope(s);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.prefix).toBe("[label: read]\n");
    expect(result.value.suffix).toBeUndefined();
    expect(result.value.value).toEqual({ a: 1 });
    expect(result.value.raw).toBe('{"a":1}');
  });

  it("edgeone case: multi-line log prose, JSON results anchored at EOF", () => {
    const s = 'logs line 1\nlogs line 2\n\nresults:\n{"type":"ok","url":"x"}';
    const result = detectEnvelope(s);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.prefix).toBe("logs line 1\nlogs line 2\n\nresults:\n");
    expect(result.value.suffix).toBeUndefined();
    expect(result.value.value).toEqual({ type: "ok", url: "x" });
  });

  it("JSON prefix-struct with trailing prose suffix", () => {
    const s = '{"a":1}\nDone in 3.2s';
    const result = detectEnvelope(s);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.prefix).toBeUndefined();
    expect(result.value.suffix).toBe("\nDone in 3.2s");
    expect(result.value.value).toEqual({ a: 1 });
    expect(result.value.raw).toBe('{"a":1}');
  });

  it("refuses a scalar anchor — F4: prose ending in a number must never envelope", () => {
    const result = detectEnvelope("Current temperature: 23.5");
    expect(result.ok).toBe(false);
  });

  it("refuses short prose ending in a bare number", () => {
    const result = detectEnvelope("Done. 42");
    expect(result.ok).toBe(false);
  });

  it("refuses when both a BOF-anchored and an EOF-anchored structure exist (ambiguous)", () => {
    const result = detectEnvelope('{"a":1} and also {"b":2}');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/ambiguous/);
  });

  it("optuna case: label line + CSV line-run anchored at EOF", () => {
    const s = "Trials: \nid,value\n1,0.5\n2,0.7";
    const result = detectEnvelope(s);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.prefix).toBe("Trials: \n");
    expect(result.value.suffix).toBeUndefined();
    expect(result.value.value).toEqual([
      { id: "1", value: "0.5" },
      { id: "2", value: "0.7" },
    ]);
  });

  it("refuses pure prose with no structure and no parseable line-run", () => {
    const result = detectEnvelope("Commit history:\nCommit abc");
    expect(result.ok).toBe(false);
  });

  it(
    String.raw`whole-string parse wins over false-edge bracket scanning: a JSON string value containing '}\nfoo'`,
    () => {
      const s = '{"a": "}\nfoo"}';
      const result = detectEnvelope(s);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.value.raw).toBe(s);
      expect(result.value.value).toEqual({ a: "}\nfoo" });
      expect(result.value.prefix).toBeUndefined();
      expect(result.value.suffix).toBeUndefined();
    },
  );

  it("refuses when detectParse itself refuses and no anchored structure is found", () => {
    const result = detectEnvelope("no structure anywhere in this text at all");
    expect(result.ok).toBe(false);
  });
});

// Block-level envelope algebra: the arity gate (server.ts's block-count check) used to
// route EVERY multi-block response to raw passthrough before `detectParse` ever ran on
// any of it. Fixtures below mirror real multi-block MCP wire shapes actually seen from
// upstream servers — never single-text-block stand-ins.
describe("detectBlockEnvelope", () => {
  it("cli-mcp-server `run_command :command \"cat 'Barber Shop.csv'\"` shape: CSV payload block + the invariant '\\nCommand completed with return code: 0' trailer block → envelope, never raw", () => {
    const csvBlock =
      "Customer Gender,Customer Age,Barber_ID,Service,Price\n" +
      "Male,42,1,Haircut,$15.00\n" +
      "Male,37,2,Beard Trim,$8.00\n" +
      "Female,42,3,Haircut,$12.00";
    const trailerBlock = "\nCommand completed with return code: 0";
    const result = detectBlockEnvelope([csvBlock, trailerBlock]);
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") throw new Error("unreachable");
    expect(result.value.format).toBe("csv");
    expect(result.value.value).toEqual([
      { "Customer Gender": "Male", "Customer Age": "42", Barber_ID: "1", Service: "Haircut", Price: "$15.00" },
      { "Customer Gender": "Male", "Customer Age": "37", Barber_ID: "2", Service: "Beard Trim", Price: "$8.00" },
      { "Customer Gender": "Female", "Customer Age": "42", Barber_ID: "3", Service: "Haircut", Price: "$12.00" },
    ]);
    expect(result.value.prefix).toBeUndefined();
    expect(result.value.suffix).toBe(trailerBlock);
  });

  it("the structural block can be surrounded by prose on BOTH sides — MCP cuts are exact, never ambiguous", () => {
    // Unlike the single-string detectEnvelope (prefix XOR suffix), block boundaries are
    // exact — a structural block with prose on EITHER side is unambiguous.
    const result = detectBlockEnvelope(["preface prose", "id,name\n1,alpha\n2,beta", "trailer prose"]);
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") throw new Error("unreachable");
    expect(result.value.format).toBe("csv");
    expect(result.value.prefix).toBe("preface prose");
    expect(result.value.suffix).toBe("trailer prose");
  });

  it(
    "pubmed `search_pubmed_key_words` shape: EVERY block is a complete JSON object " +
      "(JSONL-by-blocks) → a vector of the parsed objects, never raw passthrough",
    () => {
      const block1 = JSON.stringify({
        PMID: "42386520",
        Title: "Developmental Trauma as a Prognostic Factor for Later Psychotic Disorder",
        Journal: "Acta psychiatrica Scandinavica",
        "Publication Date": "2026",
      });
      const block2 = JSON.stringify({
        PMID: "42385295",
        Title: "Sexual orientation and clinical outcome trajectories",
        Journal: "Journal of psychiatric research",
        "Publication Date": "2026",
      });
      const block3 = JSON.stringify({
        PMID: "42303069",
        Title: "Clinical profile of patients with eating disorders",
        Journal: "Spanish journal of psychiatry and mental health",
        "Publication Date": "2026",
      });
      const result = detectBlockEnvelope([block1, block2, block3]);
      expect(result.kind).toBe("vector");
      if (result.kind !== "vector") throw new Error("unreachable");
      expect(result.format).toBe("json");
      expect(result.value).toEqual([
        JSON.parse(block1) as unknown,
        JSON.parse(block2) as unknown,
        JSON.parse(block3) as unknown,
      ]);
    },
  );

  it("mixed structural KINDS (one object block, one array block) refuse — never silently flattened", () => {
    const result = detectBlockEnvelope(['{"a":1}', "[1,2,3]"]);
    expect(result.kind).toBe("raw");
  });

  it("zero structural blocks (pure prose, e.g. cli-mcp-server's security-violation pair) refuse — raw passthrough", () => {
    const result = detectBlockEnvelope([
      "Security violation: Flag '-la' is not allowed",
      "Security violation: Shell operator '|' is not supported. Set ALLOW_SHELL_OPERATORS=true to enable.",
    ]);
    expect(result.kind).toBe("raw");
  });

  it("2-of-3 structural (not exactly 1, not ALL) refuses — strict-or-refuse holds at the block level too", () => {
    const result = detectBlockEnvelope(['{"a":1}', "prose in the middle", '{"b":2}']);
    expect(result.kind).toBe("raw");
  });

  it("a single block is never dispatched here — that's the single-block seam's job (arity gate stays intact)", () => {
    // detectBlockEnvelope doesn't special-case length 1 (server.ts only calls it for
    // blocks.length > 1) — for completeness, one structural block alone still resolves
    // to "envelope" with no prefix/suffix (no other blocks to be prose).
    const result = detectBlockEnvelope(['{"a":1}']);
    expect(result.kind).toBe("envelope");
    if (result.kind !== "envelope") throw new Error("unreachable");
    expect(result.value.prefix).toBeUndefined();
    expect(result.value.suffix).toBeUndefined();
  });
});
