// H-4 — THE FROZEN ERROR CONTRACT. These exact strings are what the python arrival_bridge
// and all four bench ports (tau / toolhop / toolsandbox / appworld) parse out of the
// manifold tool's error observations. Changing ANY pinned string here is a breaking change
// to that contract — do it only together with every consumer. The shape rule (documented in
// manifold-tool.ts above `call`): every failure is `isError: true` with EXACTLY ONE text
// block of the form `Error: <message>`; success never carries the `Error: ` prefix as a
// whole-block prefix of block 0.

import { describe, expect, it } from "vitest";

import { buildManifoldEnv, toBoundTools } from "../bind.js";
import { createManifoldTool, type ManifoldTool } from "../manifold-tool.js";

const blocksOf = (r: { content: unknown }): Array<{ type: string; text: string }> =>
  r.content as Array<{ type: string; text: string }>;

async function contractTool(timeoutMs?: number): Promise<ManifoldTool> {
  const manifoldEnv = await buildManifoldEnv([
    {
      slug: "t",
      tools: [
        {
          name: "boom",
          description: "always throws",
          inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          invoke: async () => {
            throw new Error("upstream exploded: repository not found (HTTP 404)");
          },
        },
      ],
    },
  ]);
  return createManifoldTool(manifoldEnv, "CATALOG", timeoutMs === undefined ? {} : { timeoutMs });
}

async function expectError(tool: ManifoldTool, expr: string): Promise<string> {
  const result = await tool.call({ expr });
  expect(result.isError).toBe(true);
  const blocks = blocksOf(result);
  // Shape: exactly ONE text block, `Error: ` prefixed.
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.type).toBe("text");
  expect(blocks[0]?.text).toMatch(/^Error: /);
  return blocks[0]!.text;
}

describe("manifold error contract (H-4, frozen)", () => {
  it("unbound symbol — names the symbol so the model can re-check the catalog", async () => {
    const tool = await contractTool();
    expect(await expectError(tool, "(this-symbol-is-unbound 1 2)")).toBe(
      "Error: Unbound variable `this-symbol-is-unbound'",
    );
  });

  it("bad arity at a kwargs boundary — a dangling :keyword with no value teaches the pair rule", async () => {
    const tool = await contractTool();
    expect(await expectError(tool, "(t/boom :q)")).toBe(
      "Error: kwargs call has a dangling keyword with no value — expected interleaved `:key value` pairs, got 1 arg(s)",
    );
  });

  it("wrong-operand application — the teaching door names the op and the offending primitive", async () => {
    const tool = await contractTool();
    expect(await expectError(tool, "(car 42)")).toBe(
      "Error: car: the number primitive does not support car (no arrival/tagless-final/car).",
    );
    expect(await expectError(tool, '(+ "a" 1)')).toBe(
      "Error: Cannot apply + to (string, number): argument 0 is string",
    );
  });

  it("tool impl throwing — the upstream error text reaches the model VERBATIM (never rewrapped)", async () => {
    const tool = await contractTool();
    expect(await expectError(tool, '(t/boom :q "hi")')).toBe(
      "Error: upstream exploded: repository not found (HTTP 404)",
    );
  });

  it("malformed syntax — unclosed and over-closed forms report the reader's diagnosis", async () => {
    const tool = await contractTool();
    expect(await expectError(tool, "(+ 1 2")).toBe(
      "Error: unterminated list '(' at 1:0 — check bracket balance near that point " +
        "(a stray or missing closer is the usual cause), fix, and resend.",
    );
    expect(await expectError(tool, "(+ 1 2))")).toBe(
      "Error: unexpected ')' at 1:7 — check bracket balance near that point (a stray or missing " +
        "closer is the usual cause), fix, and resend.",
    );
    const truncatedDict = await expectError(tool, '(read_file "x.ts" {offset: 90');
    expect(truncatedDict).toContain("unterminated dict literal '{'");
    expect(truncatedDict).toContain("{offset: 90 limit: 40}");
    expect(truncatedDict).not.toContain("check bracket balance");
  });

  it("timeout — ONE frozen string for both the CPU-loop and the stuck-tool path (H-1)", async () => {
    const frozen =
      "Error: evaluation timed out after 250ms — the expr did not finish within the evaluation budget. " +
      "Likely an infinite loop/recursion, or a stuck tool call. The environment is still usable: " +
      "fix the runaway expression and try again, splitting the work into smaller exprs if needed.";
    const tool = await contractTool(250);
    expect(await expectError(tool, "(define (f) (f)) (f)")).toBe(frozen);

    const stuckManifoldEnv = await buildManifoldEnv([
      { slug: "t", tools: [{ name: "stuck", inputSchema: { type: "object" }, invoke: () => new Promise(() => {}) }] },
    ]);
    const parked = createManifoldTool(stuckManifoldEnv, "CATALOG", { timeoutMs: 250 });
    expect(await expectError(parked, "(t/stuck)")).toBe(frozen);
  });

  it("disabled verb — the first line is frozen '<verb> is not available.'; a door MAY carry a teaching tail", async () => {
    const tool = await contractTool();
    // (the target must be bound first — on an unbound target the lookup error fires before
    // the door. Bound in its OWN call: under REPL-continue semantics a define+set! pair in
    // one expr is a PARTIAL success — isError false with the door inline — while this test
    // pins the door through the frozen single-statement error shape.)
    await tool.call({ expr: "(define settable 1)" });
    const setBang = await expectError(tool, "(set! settable 2)");
    expect(setBang.split("\n")[0]).toBe("Error: set! @ scheme/r7rs/binding is not available.");
    expect(setBang).toContain("Why:"); // the door teaches the immutability rationale
    // `write` carries the no-IO exemplar. `display` is a HOST AFFORDANCE (substrate/display.ts):
    // the MCP runner rewrites the call form before evaluation, so arrival's door never fires for it.
    // Arrival's law is unchanged — ports and IO remain omitted by design, and `display` is still a
    // door IN THE LANGUAGE (a bare `display` used as a VALUE still teaches); only the host-satisfiable
    // exemplar moved, because the host can answer "show me this" without any IO surface.
    const write = await expectError(tool, '(write "x")');
    expect(write.split("\n")[0]).toBe("Error: write @ scheme/r7rs/host is not available.");
    expect(write).toContain("Why:"); // the door teaches the no-IO rationale
  });

  it("`display` is NO LONGER a disabled verb — the host answers the intent (see display-affordance.law.test.ts)", async () => {
    const tool = await contractTool();
    const r = await tool.call({ expr: '(display "x")' });
    // Not a door, and not an error: the model asked to see "x", so "x" is the answer.
    expect((r as { isError?: boolean }).isError ?? false).toBe(false);
    const text = (r.content as Array<{ text: string }>).map((b) => b.text).join("\n");
    expect(text).not.toContain("is not available");
    expect(text).toContain("x");
  });

  it("a scheme-raised (error ...) surfaces its message under the same prefix", async () => {
    const tool = await contractTool();
    expect(await expectError(tool, '(error "domain rule violated")')).toBe("Error: domain rule violated");
  });

  it("s/* type-assertion failure — names the expected kind, the actual typeof, and a truncated preview", async () => {
    const tool = await contractTool();
    expect(await expectError(tool, '(s/number "There are 81 songs")')).toBe(
      'Error: s/number: expected a number, got string: "There are 81 songs"',
    );
    const long = "x".repeat(100);
    const longError = await expectError(tool, `(s/integer ${JSON.stringify(long)})`);
    expect(longError).toMatch(/^Error: s\/integer: expected an integer, got string: ".+\.\.\.$/);
    expect(longError).not.toContain(long); // truncated — the full 100-char value never reaches the model
  });

  it("empty expr — a frozen FIRST LINE, NEVER a silent successful no-op; verbose door once, terse after", async () => {
    const tool = await contractTool();
    // First occurrence in the session: the VERBOSE door (errors-as-doors Rule 4) — its
    // first line is the frozen contract string, the tail teaches (consumers match the
    // first line, per the disabled-verb precedent).
    const first = await expectError(tool, "");
    expect(first.split("\n")[0]).toBe(
      "Error: repl-input-scheme-program is empty — provide at least one Scheme expression.",
    );
    expect(first).toContain("Why:");
    // Every later occurrence: the terse one-liner — EXACTLY the historical frozen string.
    expect(await expectError(tool, "   \n\t  ")).toBe(
      "Error: repl-input-scheme-program is empty — provide at least one Scheme expression.",
    );
  });

  it("invalid args — a missing/non-string expr is a door, never a crash or a silent success", async () => {
    const tool = await contractTool();
    const missing = await tool.call(undefined);
    expect(missing.isError).toBe(true);
    const missingText = blocksOf(missing)[0]!.text;
    expect(missingText.split("\n")[0]).toBe(
      "Error: repl-input-scheme-program must be a string of Scheme source, or an array of such strings — got nothing (the repl-input-scheme-program argument is missing).",
    );
    expect(missingText).toContain("Why:");
    // Second occurrence: terse, and it names the actual type.
    const wrongType = await tool.call({ expr: 42 as unknown as string });
    expect(wrongType.isError).toBe(true);
    expect(blocksOf(wrongType)[0]!.text).toBe(
      "Error: repl-input-scheme-program must be a string or array of strings — got number.",
    );
  });

  it("required-attestation rejection — the frozen teaching shape (names the arg, shows the exact wrap)", async () => {
    const manifoldEnv = await buildManifoldEnv(
      [
        {
          slug: "t",
          tools: [
            {
              name: "pay",
              inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
              invoke: async (args) => args,
            },
          ],
        },
      ],
      { attestation: "required" },
    );
    const tool = createManifoldTool(manifoldEnv, "CATALOG");
    expect(await expectError(tool, "(t/pay :amount 37)")).toBe(
      "Error: tool argument :amount requires an explicit type assertion — wrap it: (s/number 37)",
    );
  });
});

// ─── args-error-reporting v2 — line-head freeze ───
//
// Same H-4 one-commit rule as the contract above: these strings change only together with
// every consumer (arrival_bridge_parity.py's parity rows, doors.test.ts's bypass row,
// signature-echo.test.ts's wrong-keyword row).
//
// Only LINE HEADS are frozen, never full lines — the interpolated content is schema-derived
// and must stay free to follow the schema — so every assertion below pins a head substring.
const H4_WIRE_NAME = "clinicaltrialsgov-mcp-server_clinicaltrials_list_studies";

/** Fixture shared by every H-4 re-freeze row below — a trimmed 2-key `query` param, the
 *  SAME shape args-misuse-door.test.ts's e2e mechanic rows exercise (kept in sync
 *  deliberately: this file pins the frozen line-HEADS, that file proves the mechanic). */
async function queryFixtureTool() {
  const manifoldEnv = await buildManifoldEnv([
    {
      slug: "clinicaltrialsgov-mcp-server",
      tools: [
        {
          name: "clinicaltrials_list_studies",
          description: "List clinical trials studies",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "object",
                properties: {
                  cond: { type: "string" },
                  term: { type: "string" },
                },
              },
            },
          },
          invoke: async (args) => {
            const query = (args as { query?: unknown }).query;
            if (typeof query === "string") {
              throw new TypeError(
                `{"detail":"Failed to call tool '${H4_WIRE_NAME}': Input validation error: ` +
                  `'${query}' is not of type 'object'"}`,
              );
            }
            if (query && typeof query === "object") {
              const bad = Object.keys(query as Record<string, unknown>).find((k) => k !== "cond" && k !== "term");
              if (bad !== undefined) {
                throw new Error(
                  `{"detail":"Failed to call tool '${H4_WIRE_NAME}': Input validation error: ` +
                    `Additional properties are not allowed ('${bad}' was unexpected)"}`,
                );
              }
            }
            return { ok: true };
          },
        },
      ],
    },
  ]);
  return createManifoldTool(manifoldEnv, "CATALOG", { tools: toBoundTools(manifoldEnv) });
}

describe("Frozen args-misuse line-heads", () => {
  it(String.raw`L1 fact line: '\n  Failing argument: :<param> — ' (design doc §3)`, async () => {
    const tool = await queryFixtureTool();
    const text = await expectError(tool, '(clinicaltrialsgov-mcp-server/clinicaltrials_list_studies :query "x")');
    expect(text).toContain("\n  Failing argument: :query — ");
  });

  it(String.raw`L1 script line: '\n  Retry shape: ' (design doc §3)`, async () => {
    const tool = await queryFixtureTool();
    const text = await expectError(tool, '(clinicaltrialsgov-mcp-server/clinicaltrials_list_studies :query "x")');
    expect(text).toContain("\n  Retry shape: ");
  });

  it(
    "case-B explicit-fact clause: 'the key you want is :<key>.' (design doc §3 — the one full-sentence " +
      "freeze, bridges may machine-read the rename)",
    async () => {
      const tool = await queryFixtureTool();
      // "cnd" is edit-distance 1 from the real key "cond" — a tight match (doors.ts's
      // isTightMatch, reused one level down at the key level per design doc §2.2 observation 2).
      const text = await expectError(
        tool,
        '(clinicaltrialsgov-mcp-server/clinicaltrials_list_studies :query {:cnd "x"})',
      );
      expect(text).toContain("the key you want is :cond.");
    },
  );

  it(
    String.raw`L2 head: '\n  Parameter :<param> in full — ' + the closed-world clause when it's a fact (design doc §3)`,
    async () => {
      const tool = await queryFixtureTool();
      const expr = '(clinicaltrialsgov-mcp-server/clinicaltrials_list_studies :query "x")';
      await tool.call({ expr });
      const text = await expectError(tool, expr);
      expect(text).toContain("\n  Parameter :query in full — ");
    },
  );

  it(String.raw`L3 head: '\n  This is rejected shape #<n> for :<param> on this tool.' (design doc §3)`, async () => {
    const tool = await queryFixtureTool();
    const expr = '(clinicaltrialsgov-mcp-server/clinicaltrials_list_studies :query "x")';
    await tool.call({ expr });
    await tool.call({ expr });
    const text = await expectError(tool, expr);
    expect(text).toContain("This is rejected shape #3 for :query on this tool.");
  });

  // The own-decode humanizer's frozen first line, at OUR (manifold) kwargs layer. Exercised
  // via a REQUIRED kwarg omitted entirely: the manifold's tool contracts are z.dynamic-per-param,
  // so a missing-required arg is the case this layer's own-decode humanizer fires for.
  it(`own-decode humanizer's new frozen first line: 'Error: <name>: arguments rejected — <n> problem(s):' + ${String.raw`'\n  :<param> — <issue>' (design doc §2.5, §4 — replaces today's raw ZodError dump)`}`, async () => {
    const manifoldEnv = await buildManifoldEnv([
      {
        slug: "h4",
        tools: [
          {
            name: "pay",
            description: "pay",
            inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
            invoke: async (args) => args,
          },
        ],
      },
    ]);
    const tool = createManifoldTool(manifoldEnv, "CATALOG", { tools: toBoundTools(manifoldEnv) });
    // The kwarg is omitted entirely — no `:amount` pair at all. The frozen part is the
    // FIRST LINE + the per-issue line grammar (consumers match line heads; the localized
    // door's teaching tail + Signature ride below them, the disabled-verb precedent —
    // never part of the freeze).
    const text = await expectError(tool, "(h4/pay)");
    const lines = text.split("\n");
    expect(lines[0]).toBe("Error: h4/pay: arguments rejected — 1 problem(s):");
    expect(lines[1]).toBe("  :amount — missing (required)");
  });
});
