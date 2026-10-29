// RING 3 — SPINE FIXTURE TABLE for the manifold type-hints feature.
//
// Exercises the full Ring 3 pipeline end to end — createSpineLens → selectHints →
// renderHint — against REAL manifold-bindable tools, harvested exactly as production would
// (buildManifoldEnv, not a mock).
//
// FIXTURE TABLE — see FIXTURES.md (sibling) for the human-readable acceptance contract,
// including the per-row rationale for each expected TS diagnostic code.

import { tokenize } from "@here.build/arrival/lsp-internals";
import { createSpineLens, renderHint, selectHints, type BoundTool } from "@inhuman.tools/substrate";
import { describe, expect, it } from "vitest";

import { type BoundServer, buildManifoldEnv, toBoundTools } from "../../bind.js";
import { createManifoldTool, type ManifoldWorldEnv } from "../../manifold-tool.js";

// ─── fixture tools — REAL manifold-bindable tools, bound via the real buildManifoldEnv ───

/** `fx/set_count` — one required NUMBER param. Its `invoke` self-validates (as a real
 *  upstream tool would) so a wrongly-typed call genuinely runtime-errors — the
 *  "high-evidence coincidence" §1 requires before a hint renders. */
async function fxSetCount(args: Record<string, unknown>): Promise<unknown> {
  if (typeof args.count !== "number") {
    throw new TypeError(`fx/set_count: expected :count to be a number, got ${JSON.stringify(args.count)}`);
  }
  return { count: args.count };
}

/** `fx/search` — one required STRING param, one optional NUMBER param
 *  (`max_results`) — the kwargs-typo fixtures' target: a near-typo (`:max_result`) and a
 *  far-typo (`:zzzzz_unrelated`) probe the did-you-mean shadowing (2561 vs 2353). */
async function fxSearch(args: Record<string, unknown>): Promise<unknown> {
  if (typeof args.query !== "string") {
    throw new TypeError(`fx/search: expected :query to be a string, got ${JSON.stringify(args.query)}`);
  }
  return { results: [], query: args.query };
}

const FIXTURE_SERVERS: readonly BoundServer[] = [
  {
    slug: "fx",
    tools: [
      {
        name: "set_count",
        inputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
        invoke: fxSetCount,
      },
      {
        name: "search",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" }, max_results: { type: "number" } },
          required: ["query"],
        },
        invoke: fxSearch,
      },
    ],
  },
];

async function fixtureEnv(): Promise<{ env: ManifoldWorldEnv; tools: ReadonlyMap<string, BoundTool> }> {
  // attestation "off" — these fixtures probe the TYPE-HINT lens, not the `s/*` boundary;
  // "off" keeps bare literal args from drawing unrelated attestation warnings (same
  // rationale as futility.test.ts's fakeUpstream).
  const manifoldEnv = await buildManifoldEnv(FIXTURE_SERVERS, { attestation: "off" });
  return { env: manifoldEnv, tools: toBoundTools(manifoldEnv) };
}

// ─── real-execution helper — derives erroredStatementIndexes HONESTLY (never hardcoded) ───
//
// A void-returning statement (a successful `define`) produces NO content block (H-3), so
// scanning the RETURNED blocks for "Error:" and using THAT array's index does not recover
// the STATEMENT index whenever an earlier statement is void — the block/statement indices
// silently desync. Instead, split the program into its real top-level statements (the SAME
// tokenizer-based split manifold-tool.ts uses internally) and call the REAL manifold tool
// ONCE PER STATEMENT against the SAME env/tool instance — session state (defines, etc.)
// persists across calls exactly as REPL-continue does, and each call's own `isError` is an
// honest, unambiguous per-statement verdict.

const isOpen = (tok: string): boolean =>
  tok === "(" || tok === "[" || tok === "{" || (tok.startsWith("#") && !tok.startsWith("#\\") && tok.endsWith("("));
const CLOSE = new Set([")", "]", "}"]);
const QUOTE_PREFIX = new Set(["'", "`", ",", ",@"]);
const isSkippable = (tok: string): boolean =>
  /^\s+$/.test(tok) || tok.startsWith(";") || tok.startsWith("#|") || tok.startsWith("#;");

function splitStatements(source: string): string[] {
  const tokens = tokenize(source, true) as { token: string; offset: number }[];
  const starts: number[] = [];
  let depth = 0;
  let between = true;
  for (const { token, offset } of tokens) {
    if (isSkippable(token)) continue;
    if (between) {
      starts.push(offset);
      between = false;
    }
    if (isOpen(token)) depth++;
    else if (CLOSE.has(token)) {
      if (depth > 0) depth--;
      if (depth === 0) between = true;
    } else if (depth === 0 && !QUOTE_PREFIX.has(token)) {
      between = true;
    }
  }
  return starts.map((s, i) => source.slice(s, starts[i + 1] ?? source.length).trim()).filter(Boolean);
}

async function runProgram(env: ManifoldWorldEnv, program: string): Promise<{ erroredStatementIndexes: number[] }> {
  const statements = splitStatements(program);
  const tool = createManifoldTool(env, "CATALOG");
  const erroredStatementIndexes: number[] = [];
  for (const [i, statement] of statements.entries()) {
    const result = await tool.call({ expr: statement! });
    if (result.isError === true) erroredStatementIndexes.push(i);
  }
  return { erroredStatementIndexes };
}

/** The failing form's HEAD (doc §3 G12 trailing-block naming) — the first token after the
 *  statement's opening paren, e.g. "fx/set_count" or ":total". Statements in these fixtures
 *  are always a single top-level form, so a simple lexical scan suffices. */
function headOf(statementSource: string): string {
  const match = /^\(\s*([^\s()]+)/.exec(statementSource.trim());
  if (!match) throw new Error(`headOf: no head symbol found in: ${statementSource}`);
  return match[1]!;
}

// ── Row 2/3 activation-policy caveat (see FIXTURES.md's "Coverage boundaries" section):
// the kwargs-typo calls do NOT themselves runtime-error (arrival's kwargs runtime tolerantly
// DROPS an unknown keyword), so `erroredStatementIndexes: [0]` is supplied BY FIAT to isolate
// the spine's diagnostic MECHANICS from the separate, undecided ACTIVATION question.
const KWARGS_SIMULATED_ERRORED_INDEXES = [0];

// Shared across the vocabulary-sweep row: every rendered hint text produced by rows 1-3 and 6
// is collected here as it renders.
const renderedHints: string[] = [];

describe("type-hints spine fixtures (Ring 3 — full pipeline)", () => {
  const createLens = createSpineLens;
  const select = selectHints;
  const render = renderHint;

  // ── Row 1 — wrong kwarg VALUE TYPE (TS2322) ──
  it('fixture 1: (fx/set_count :count "five") → exactly one TS2322 hint, rendered with (string->number', async () => {
    const { env, tools } = await fixtureEnv();
    const program = '(fx/set_count :count "five")';
    const { erroredStatementIndexes } = await runProgram(env, program);
    expect(erroredStatementIndexes).toEqual([0]); // genuinely runtime-errors — the high-evidence coincidence (§1)

    const lens = createLens(tools);
    const { unit, diagnostics } = await lens.diagnose(program, []);
    const selected = select(unit, diagnostics, erroredStatementIndexes);

    expect(selected).toHaveLength(1);
    expect(selected[0]!.diagnostic.code).toBe(2322);
    expect(selected[0]!.diagnostic.span.start).toBeGreaterThanOrEqual(unit.programStartOffset);

    const rendered = render(selected[0]!, headOf(program));
    expect(rendered).not.toBeNull();
    expect(rendered as string).toContain("(string->number");
    renderedHints.push(rendered as string);
  });

  // ── Row 2 — CLOSE-typo kwarg (TS2561 — did-you-mean shadows 2353 whenever a near name exists) ──
  it('fixture 2: (fx/search :query "x" :max_result 5) → TS2561, propertyName max_result, candidate max_results', async () => {
    const { tools } = await fixtureEnv();
    const program = '(fx/search :query "x" :max_result 5)';
    const lens = createLens(tools);
    const { unit, diagnostics } = await lens.diagnose(program, []);
    const selected = select(unit, diagnostics, KWARGS_SIMULATED_ERRORED_INDEXES);
    const hint = selected.find((h) => h.diagnostic.code === 2561);
    expect(hint).toBeDefined();
    expect(hint!.diagnostic.propertyName).toBe("max_result");
    expect(hint!.diagnostic.candidateProperties).toContain("max_results");

    const rendered = render(hint!, headOf(program));
    if (rendered !== null) renderedHints.push(rendered);
  });

  // ── Row 3 — FAR-typo kwarg (TS2353 — no near-name candidate, so no did-you-mean shadow) ──
  it('fixture 3: (fx/search :query "x" :zzzzz_unrelated 5) → TS2353, propertyName zzzzz_unrelated, no candidate', async () => {
    const { tools } = await fixtureEnv();
    const program = '(fx/search :query "x" :zzzzz_unrelated 5)';
    const lens = createLens(tools);
    const { unit, diagnostics } = await lens.diagnose(program, []);
    const selected = select(unit, diagnostics, KWARGS_SIMULATED_ERRORED_INDEXES);
    const hint = selected.find((h) => h.diagnostic.code === 2353);
    expect(hint).toBeDefined();
    expect(hint!.diagnostic.propertyName).toBe("zzzzz_unrelated");

    const rendered = render(hint!, headOf(program));
    if (rendered !== null) renderedHints.push(rendered);
  });

  // ── Row 4 — arity (TS2554), a SCHEME-DEFINED lambda (never a tool call — tool calls lower
  // to one kwargs object, doc §5) ──
  it("fixture 4: a 2-required-param define called with 1 arg → TS2554 (needs batch 1c's define→const)", async () => {
    const { env, tools } = await fixtureEnv();
    const program = "(define (add2 a b) (+ a b)) (add2 1)";
    const { erroredStatementIndexes } = await runProgram(env, program);
    expect(erroredStatementIndexes).toEqual([1]); // the `define` succeeds; the call under-arities

    const lens = createLens(tools);
    const { unit, diagnostics } = await lens.diagnose(program, []);
    const selected = select(unit, diagnostics, erroredStatementIndexes);

    expect(selected).toHaveLength(1);
    expect(selected[0]!.statementIndex).toBe(1);
    expect(selected[0]!.diagnostic.code).toBe(2554);
  });

  // ── Row 5 — clean program (the false-positive canary / precision floor) ──
  it("fixture 5: a well-typed multi-statement program → ZERO whitelisted diagnostics selected", async () => {
    const { env, tools } = await fixtureEnv();
    const program = "(define (double x) (* x 2)) (fx/set_count :count (double 21))";
    const { erroredStatementIndexes } = await runProgram(env, program);
    expect(erroredStatementIndexes).toEqual([]); // genuinely clean — both statements succeed

    const lens = createLens(tools);
    const { unit, diagnostics } = await lens.diagnose(program, []);
    const selected = select(unit, diagnostics, erroredStatementIndexes);
    expect(selected).toEqual([]);
  });

  // ── Row 6 — CONTEXT-DEFINE CARRYOVER (§9a: the recipe is re-lowered SOURCE, not derived
  // data) — proves session-typed context actually narrows the CURRENT program, not just
  // "some error happens to fire": a broken/absent context wiring would leave `bad_count`
  // genuinely UNBOUND (2304, off-whitelist → empty selection), never 2322 with this
  // specific literal-string `actual` type. ──
  it("fixture 6: a context define's value carries its type into the current program (TS2322, actual reflects the context literal)", async () => {
    const { tools } = await fixtureEnv();
    const context = ['(define bad_count "not-a-number")'];
    const program = "(fx/set_count :count bad_count)";
    const lens = createLens(tools);
    const { unit, diagnostics } = await lens.diagnose(program, context);
    expect(unit.programStartOffset).toBeGreaterThan(0); // the context recipe shifted the program's coordinate space

    const selected = select(unit, diagnostics, [0]);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.diagnostic.code).toBe(2322);
    // TS WIDENS a `const`'s literal initializer when it's read at a later reference site
    // (`bad_count` here) — `actual` is the widened "string", not the literal "not-a-number".
    // Still a strong proof of context wiring: a broken/absent context leaves `bad_count`
    // genuinely UNBOUND (TS2304, off-whitelist) — never 2322/"string".
    expect(selected[0]!.diagnostic.actual).toBe("string");
    expect(selected[0]!.diagnostic.span.start).toBeGreaterThanOrEqual(unit.programStartOffset);

    const rendered = render(selected[0]!, headOf(program));
    if (rendered !== null) renderedHints.push(rendered);
  });

  // ── Row 7 — vocabulary sweep (doc §4/§7 "TS-never-leaks") ──
  it("fixture 7: every hint rendered by rows 1-3 and 6 avoids the TS carrier vocabulary", () => {
    // Populated by whichever of rows 1-3/6 actually rendered — this assertion runs LAST in
    // file order, after those `it`s have executed.
    expect(renderedHints.length).toBeGreaterThan(0);
    for (const text of renderedHints) {
      expect(text).not.toContain("Cons<");
      expect(text).not.toContain("readonly");
      expect(text).not.toContain("Promise<");
      expect(text).not.toMatch(/TS\d{4}/);
      expect(text).not.toContain("undefined");
    }
  });
});
