// render-observation — unit + round-trip coverage for the brace-style observation
// renderer (see ../render-observation.ts for the design rationale). The round-trip
// tests are the load-bearing ones: a rendered dict/list literal must PARSE under
// arrival's committed `{}`/`[]` reader grammar, closing the loop between what the model reads
// back and what it itself writes.
//
// String leaves round-trip too: toSExpr/formatSExpr print strings as R7RS double-quoted
// literals (`"Ada"`) with full `\\`/`\"`/`\n`/`\t`/`\r` escaping, verified against arrival's
// own reader — the earlier single-quote convention (`'Ada'`) did NOT re-parse
// (`exec("'hi'")` threw `expecting datum after '''`). See the positive test below.

import { exec, execState, LexicalScope, RunContext, disposeRunContext } from "@here.build/arrival";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_OBSERVATION_MAX_TOTAL_CHARS, renderObservation } from "../render-observation.js";

// ONE bare (runCtx, capabilities, config) triple (no capabilities, no tools) shared across every
// test in this file — it is stateless and immutable, so sharing it costs nothing; only the
// SCOPE (where a test's own defines would land) needs to be fresh per test, for isolation
// between cases.
const capabilities: readonly [] = [];
const config: Record<string, unknown> = {};
let runCtx: RunContext;
beforeAll(async () => {
  const state = await execState("(begin)", {
    capabilities,
    config,
    scope: LexicalScope.fresh("render-observation-mint"),
  });
  runCtx = state.runCtx;
});
afterAll(async () => {
  await disposeRunContext(runCtx);
});

const run = (scope: LexicalScope, expr: string) => exec(expr, { capabilities, config, runCtx, scope });

function freshEnv(): LexicalScope {
  return LexicalScope.fresh("render-observation-test");
}

describe("renderObservation — plain JS values", () => {
  it("renders a flat dict as {:k v ...}", () => {
    expect(renderObservation({ a: 1, b: 2 })).toBe("{:a 1 :b 2}");
  });

  it("renders a flat array as [a b ...]", () => {
    expect(renderObservation([1, 2, 3])).toBe("[1 2 3]");
  });

  it("renders empty dict/list", () => {
    expect(renderObservation({})).toBe("{}");
    expect(renderObservation([])).toBe("[]");
  });

  it("renders nested dict-in-list and list-in-dict", () => {
    expect(renderObservation({ items: [1, { x: 2 }, 3], flag: true })).toBe("{:items [1 {:x 2} 3] :flag #t}");
  });

  it("quotes a dict key that isn't a valid bare keyword, mirroring the reader's other admitted key shape", () => {
    expect(renderObservation({ "weird key!": 1 })).toBe('{"weird key!" 1}');
  });

  it("keeps a hyphenated/underscored key bare (both are valid keyword characters)", () => {
    expect(renderObservation({ "flight-number": 1, flight_id: 2 })).toBe("{:flight-number 1 :flight_id 2}");
  });
});

describe("renderObservation — real arrival exec() results", () => {
  it("renders a (dict ...) constructor result braced", async () => {
    const env = freshEnv();
    const [value] = await run(env, "(dict :a 1 :b 2)");
    expect(renderObservation(value)).toBe("{:a 1 :b 2}");
  });

  it("renders a (list ...) constructor result bracketed", async () => {
    const env = freshEnv();
    const [value] = await run(env, "(list 1 2 3)");
    expect(renderObservation(value)).toBe("[1 2 3]");
  });

  it("renders a {} / [] literal round-trip identically (both build the same value)", async () => {
    const env = freshEnv();
    const [value] = await run(env, "{:a 1 :b [2 3]}");
    expect(renderObservation(value)).toBe("{:a 1 :b [2 3]}");
  });

  it("renders nested lists head-recursively at any depth (partition's two arms as one product)", async () => {
    const env = freshEnv();
    // Multi-value returns (`values` / `call-with-values`) are omitted from arrival by
    // design — free multi-return packaging is the weak form of continuation arity.
    // `partition` therefore returns ONE structured product: a list of the two arms
    // (odds, then evens). Nested lists still flip to brackets at any depth.
    const state = await execState("(partition odd? '(1 2 3 4))", { capabilities, config, runCtx, scope: env });
    expect(renderObservation(state.values[0])).toBe("[[1 3] [2 4]]");
  });
});

describe("renderObservation — round-trip sanity (renders PARSE under the arrival reader)", () => {
  it("a rendered nested dict/list literal parses back and evaluates to an equivalent value", async () => {
    const env = freshEnv();
    const [value] = await run(env, "(dict :a 1 :b (list 2 3 (dict :c 4)))");
    const rendered = renderObservation(value);
    expect(rendered).toBe("{:a 1 :b [2 3 {:c 4}]}");

    // Feed the rendered literal back through the reader/eval — a `(:k <rendered>)`
    // probe, exactly the shape a model would use to read a field off its own
    // previous observation.
    const [a] = await run(env, `(:a ${rendered})`);
    expect(renderObservation(a)).toBe("1");

    // `[...]` is a VECTOR literal (not a list — arrival-curly-vector-literals.md's
    // deliberate choice), so the rendered `:b` reads back as a vector: index with
    // vector-ref, not list accessors.
    const [nestedC] = await run(env, `(:c (vector-ref (:b ${rendered}) 2))`);
    expect(renderObservation(nestedC)).toBe("4");
  });

  it("a rendered flat list parses back as a vector and composes with vector ops", async () => {
    const env = freshEnv();
    const [value] = await run(env, "(list 10 20 30)");
    const rendered = renderObservation(value);
    expect(rendered).toBe("[10 20 30]");
    const [sum] = await run(env, `(vector-fold + 0 ${rendered})`);
    expect(renderObservation(sum)).toBe("60");
  });

  it("a rendered dict with a quoted odd key parses back via the reader's string-key form", async () => {
    const env = freshEnv();
    const rendered = renderObservation({ "weird key!": 42 });
    expect(rendered).toBe('{"weird key!" 42}');
    const [viaAt] = await run(env, `(@ ${rendered} "weird key!")`);
    expect(renderObservation(viaAt)).toBe("42");
  });

  it("a rendered STRING LEAF round-trips end-to-end — the preamble's field-accessor probe chain", async () => {
    // The exact probe shape preamble-honesty.test.ts pins: read a string field off a
    // dict, render it, feed the rendering back through the reader, and confirm it
    // evaluates to the identical string (not just "is defined" — genuinely re-parses).
    const env = freshEnv();
    const [name] = await run(env, '(:name {:name "Ada" :role "analyst"})');
    const rendered = renderObservation(name);
    expect(rendered).toBe('"Ada"');

    const [roundTripped] = await run(env, rendered);
    expect(renderObservation(roundTripped)).toBe('"Ada"');

    // A string containing the escape-worthy characters (quote, backslash, newline,
    // tab, CR) round-trips too — not just the happy-path bare-word case.
    const [tricky] = await run(env, String.raw`"a\"b\\c\nd\te\rf"`);
    const trickyRendered = renderObservation(tricky);
    const [trickyRoundTripped] = await run(env, trickyRendered);
    expect(renderObservation(trickyRoundTripped)).toBe(trickyRendered);
  });
});

describe("renderObservation — caps + shrink ride the brace notation natively", () => {
  it("reduces an oversize result to fit the budget WITHOUT leaving the brace notation", async () => {
    // SerializeOpts.format wires the brace formatter into toSExprString's own streaming caps +
    // fair shrink-to-fit. The inline `+N more of TOTAL` marker is the only truncation signal —
    // no banner, no ⚠/"output reduced" text — and the budget is genuinely honored.
    const env = freshEnv();
    const [value] = await run(env, String.raw`(map (lambda (x) (make-string 3000 #\a)) (iota 100))`);
    const rendered = renderObservation(value);
    expect(rendered.length).toBeLessThanOrEqual(DEFAULT_OBSERVATION_MAX_TOTAL_CHARS);
    expect(rendered).toMatch(/#\| \+\d+ more of \d+ \|#/);
    expect(rendered).not.toMatch(/\(list/);
    expect(rendered.startsWith("[")).toBe(true);
  });

  it("honors a caller-provided maxTotalChars budget", async () => {
    const env = freshEnv();
    const [value] = await run(env, "(iota 2000)");
    const roomy = renderObservation(value); // default budget — renders in full
    expect(roomy).not.toContain("output reduced");
    const tight = renderObservation(value, { maxTotalChars: 500 });
    expect(tight.length).toBeLessThanOrEqual(500);
    expect(tight).toMatch(/#\| \+\d+ more of 2000 \|#/);
    expect(tight.startsWith("[")).toBe(true);
  });

  it("keeps a capped dict's truncation marker inside the braces", () => {
    const wide = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`key_${i}`, "v".repeat(400)]));
    const rendered = renderObservation(wide, { maxTotalChars: 2000 });
    // The marker is the LAST dict entry, immediately before the closing brace.
    expect(rendered).toContain(" more of 300 |#}");
  });

  it("an under-budget observation renders byte-identically to the uncapped formatter", () => {
    // ("two words" — a plain JS string that does NOT pass formatSExpr's bare-symbol
    // heuristic — pins the quoting; symbol-looking plain strings render bare, as before.)
    expect(renderObservation({ a: [1, 2, 3], b: "two words" })).toBe('{:a [1 2 3] :b "two words"}');
  });
});

describe("renderObservation — raw top-level string truncation carries an inline elision marker, no banner", () => {
  // A provenance-less native string (e.g. a bare JS string returned top-level, not boxed in
  // an AString) hits the shortcut branch in renderObservation directly. Truncation is signaled
  // INLINE (the `…(+N chars)` suffix, matching the serializer's own `capString` convention) —
  // there is no separate banner.
  const raw = "x".repeat(1000);

  it("caps the string and appends the inline elision marker", () => {
    const rendered = renderObservation(raw, { maxTotalChars: 100 });
    expect(rendered).toContain("…(+900 chars)");
    expect(rendered).not.toContain("⚠");
    expect(rendered).not.toContain("output reduced");
  });

  it("an under-budget string is unaffected — no marker, plain JSON string", () => {
    const rendered = renderObservation("short", { maxTotalChars: 100 });
    expect(rendered).toBe('"short"');
  });
});
