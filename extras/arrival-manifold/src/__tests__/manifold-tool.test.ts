import { disposeRunContext, execState, LexicalScope, RunContext } from "@here.build/arrival";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PASSTHROUGH_ATTACHMENTS, MAX_PASSTHROUGH_ATTACHMENTS } from "../attachments.js";
import type { BypassResolution } from "../bind.js";
import { createManifoldTool, RESPONSE_SIZE_MAX_CHARS, RESPONSE_SIZE_MIN_CHARS } from "../manifold-tool.js";

// ONE bare (runCtx, capabilities, config) triple (no capabilities, no tools) shared across
// every test in this file — it is stateless and immutable, so sharing it costs nothing;
// only the SCOPE needs to be fresh per test, for isolation between cases.
const capabilities: readonly [] = [];
const config: Record<string, unknown> = {};
let runCtx: RunContext;
beforeAll(async () => {
  const state = await execState("(begin)", {
    capabilities,
    config,
    scope: LexicalScope.fresh("manifold-tool-test-mint"),
  });
  runCtx = state.runCtx;
});
afterAll(async () => {
  await disposeRunContext(runCtx);
});

describe("createManifoldTool", () => {
  it("describes itself as the single REPL tool with the given catalog as its description", async () => {
    const scope = LexicalScope.fresh("test");
    const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT");
    const described = tool.describe();
    expect(described.name).toBe("scheme-repl-with-all-mcp-tools");
    expect(described.description).toBe("CATALOG TEXT");
    expect(described.inputSchema).toEqual({
      type: "object",
      required: ["repl-input-scheme-program"],
      properties: {
        "repl-input-scheme-program": {
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: expect.any(String),
        },
        "response-size": {
          type: "integer",
          description: expect.any(String),
        },
        "response-attachments": {
          type: "integer",
          description: expect.any(String),
        },
        "eval-timeout-ms": {
          type: "integer",
          description: expect.any(String),
        },
      },
    });
  });

  it("omits `_meta` entirely when no bypassResolution is supplied (never an empty object)", () => {
    const scope = LexicalScope.fresh("test");
    const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT");
    expect(tool.describe()._meta).toBeUndefined();
  });

  it("serializes bypassResolution onto _meta.bypassResolution — the channel the python bridge reads at tools/list", () => {
    const scope = LexicalScope.fresh("test");
    const bypassResolution = new Map<string, BypassResolution>([
      ["filesystem_search_files", { kind: "unique", qualified: "filesystem/search_files" }],
      ["search", { kind: "ambiguous", candidates: ["github/search", "slack/search"] }],
    ]);
    const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT", { bypassResolution });
    expect(tool.describe()._meta).toEqual({
      bypassResolution: {
        filesystem_search_files: { kind: "unique", qualified: "filesystem/search_files" },
        search: { kind: "ambiguous", candidates: ["github/search", "slack/search"] },
      },
    });
  });

  it("omits intent/successCriteria from the schema by default (opt-in, measured dead weight on strong models)", () => {
    const scope = LexicalScope.fresh("test");
    const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT");
    const properties = tool.describe().inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual([
      "eval-timeout-ms",
      "repl-input-scheme-program",
      "response-attachments",
      "response-size",
    ]);
  });

  it("adds intent (only) to the schema when promptFields.intent is true", () => {
    const scope = LexicalScope.fresh("test");
    const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT", {
      promptFields: { intent: true },
    });
    const described = tool.describe();
    const properties = described.inputSchema.properties as Record<string, unknown>;
    expect(properties.intent).toMatchObject({ type: "string" });
    expect(properties.successCriteria).toBeUndefined();
    // still only expr is required
    expect(described.inputSchema.required).toEqual(["repl-input-scheme-program"]);
  });

  it("adds successCriteria (only) to the schema when promptFields.successCriteria is true", () => {
    const scope = LexicalScope.fresh("test");
    const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT", {
      promptFields: { successCriteria: true },
    });
    const properties = tool.describe().inputSchema.properties as Record<string, unknown>;
    expect(properties.successCriteria).toMatchObject({ type: "string" });
    expect(properties.intent).toBeUndefined();
  });

  it("adds both intent and successCriteria when both promptFields flags are true", () => {
    const scope = LexicalScope.fresh("test");
    const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT", {
      promptFields: { intent: true, successCriteria: true },
    });
    const properties = tool.describe().inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual([
      "eval-timeout-ms",
      "intent",
      "repl-input-scheme-program",
      "response-attachments",
      "response-size",
      "successCriteria",
    ]);
  });

  it("evaluates expr against the env and returns one text content entry per top-level form", async () => {
    const scope = LexicalScope.fresh("test");
    const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT");
    const result = await tool.call({ expr: "(+ 1 2)\n(+ 3 4)" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "text", text: "3" },
      { type: "text", text: "7" },
    ]);
  });

  it("accepts an optional intent alongside expr and still executes expr normally", async () => {
    const scope = LexicalScope.fresh("test");
    const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT");
    const result = await tool.call({ intent: "add two numbers", expr: "(+ 1 2)" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "3" }]);
  });

  it("still works with no intent field at all (existing callers unaffected)", async () => {
    const scope = LexicalScope.fresh("test");
    const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT");
    const result = await tool.call({ expr: "(+ 5 5)" });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "10" }]);
  });

  it("reports a runtime error as isError content instead of throwing", async () => {
    const scope = LexicalScope.fresh("test");
    const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT");
    const result = await tool.call({ expr: "(undefined-symbol)" });
    expect(result.isError).toBe(true);
    const [block] = result.content as Array<{ type: "text"; text: string }>;
    expect(block?.text).toMatch(/undefined-symbol/);
  });

  it("threads the observation.maxTotalChars budget into result rendering (both rendering modes)", async () => {
    const scope = LexicalScope.fresh("test");
    const braced = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT", {
      observation: { maxTotalChars: 400 },
    });
    const result = await braced.call({ expr: "(make-list 1000 1)" });
    expect(result.isError).toBeFalsy();
    const [block] = result.content as Array<{ type: "text"; text: string }>;
    expect(block?.text.length).toBeLessThanOrEqual(400);
    // Middle-elision (the manifold's default — serializer-elision plan): a small head+tail
    // around a loud "N ... were not rendered" marker, never the old tail-only "+N more of".
    expect(block?.text).toMatch(/#\| \d+ .+ were not rendered; total array length is 1000 \|#/);

    // sexpr mode rides the same budget + observation seeds (observationCaps). Collection
    // notation is serializer-owned; the invariant here is the shared cap and loud marker.
    const sexpr = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT", {
      rendering: "sexpr",
      observation: { maxTotalChars: 400 },
    });
    const sexprResult = await sexpr.call({ expr: "(make-list 1000 1)" });
    const [sexprBlock] = sexprResult.content as Array<{ type: "text"; text: string }>;
    expect(sexprBlock?.text.length).toBeLessThanOrEqual(400);
    expect(sexprBlock?.text).toMatch(/#\| \d+ .+ were not rendered; total array length is 1000 \|#/);
  });

  describe("response-size — model-controlled per-call compaction budget", () => {
    it("pins the schema's default/max + drift/cost teaching text verbatim", () => {
      const scope = LexicalScope.fresh("test");
      const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT", {
        observation: { maxTotalChars: 8000 },
      });
      const properties = tool.describe().inputSchema.properties as Record<
        string,
        { type?: string; description: string }
      >;
      expect(properties["response-size"]).toMatchObject({ type: "integer" });
      // Default reflects THIS deployment's configured budget, not a hardcoded number.
      expect(properties["response-size"]?.description).toContain(
        `Response character budget for this call (default 8000, max ${RESPONSE_SIZE_MAX_CHARS})`,
      );
      // The drift/cost warning sentence is the load-bearing teaching — pinned verbatim.
      expect(properties["response-size"]?.description).toContain(
        "Only increase this if you have a specific, rationalized need to see a bigger response at once — " +
          "larger responses can cause attention drift and increase costs for the user. " +
          "Prefer filtering/reducing in the REPL over raising the budget.",
      );
    });

    it("falls back to the world default budget when response-size is absent", async () => {
      const scope = LexicalScope.fresh("test");
      const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT", {
        observation: { maxTotalChars: 500 },
      });
      const result = await tool.call({ expr: "(iota 3000)" });
      const [block] = result.content as Array<{ type: "text"; text: string }>;
      expect(block?.text.length).toBeLessThanOrEqual(500);
      expect(block?.text).toMatch(/#\| \d+ .+ were not rendered; total array length is 3000 \|#/);
    });

    it("honors an explicit, larger response-size for this call only (no world config change)", async () => {
      const scope = LexicalScope.fresh("test");
      const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT", {
        observation: { maxTotalChars: 500 },
      });
      // A 3000-item array sits WELL over the manifold's default `topLevelArrayLimit` (100) —
      // that structural item-count cap is char-budget-independent BY DESIGN (serializer-elision
      // plan: this is exactly the fix for the grounding failure a large response-size used to
      // let happen — a huge array reading as a "complete" dump). So a bigger response-size does
      // NOT lift the array back to full: both calls elide identically.
      const result = await tool.call({ expr: "(iota 3000)", "response-size": 20_000 });
      const [block] = result.content as Array<{ type: "text"; text: string }>;
      expect(block?.text).toMatch(/#\| \d+ .+ were not rendered; total array length is 3000 \|#/);

      const later = await tool.call({ expr: "(iota 3000)" });
      const [laterBlock] = later.content as Array<{ type: "text"; text: string }>;
      expect(laterBlock?.text.length).toBeLessThanOrEqual(500);
      expect(laterBlock?.text).toMatch(/#\| \d+ .+ were not rendered; total array length is 3000 \|#/);
      expect(laterBlock?.text).toBe(block?.text); // identical — the item-count cap doesn't care about the budget

      // response-size DOES still matter for a payload the item-count cap doesn't touch — here,
      // 50 items sits well under `topLevelArrayLimit` (100), so size is driven entirely by
      // per-string char capping, which the budget genuinely controls.
      const stringExpr = String.raw`(map (lambda (x) (make-string 200 #\a)) (iota 50))`;
      const roomy = await tool.call({ expr: stringExpr, "response-size": 20_000 });
      const [roomyBlock] = roomy.content as Array<{ type: "text"; text: string }>;
      expect(roomyBlock?.text).not.toContain("chars)"); // full strings, unreduced

      const tight = await tool.call({ expr: stringExpr });
      const [tightBlock] = tight.content as Array<{ type: "text"; text: string }>;
      expect(tightBlock?.text.length).toBeLessThan(roomyBlock!.text.length); // smaller world default, visibly less content
      expect(tightBlock?.text).toContain("chars)"); // strings capped to fit the smaller world default
    });

    it(`clamps a response-size below ${RESPONSE_SIZE_MIN_CHARS} up to the floor`, async () => {
      const scope = LexicalScope.fresh("test");
      const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT");
      const result = await tool.call({ expr: "(iota 3000)", "response-size": 1 });
      const [block] = result.content as Array<{ type: "text"; text: string }>;
      expect(block?.text.length).toBeLessThanOrEqual(RESPONSE_SIZE_MIN_CHARS);
      expect(block?.text).toMatch(/#\| \d+ .+ were not rendered; total array length is 3000 \|#/);
    });

    it(`clamps a response-size above ${RESPONSE_SIZE_MAX_CHARS} down to the ceiling`, async () => {
      const scope = LexicalScope.fresh("test");
      const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT");
      const result = await tool.call({
        expr: String.raw`(map (lambda (x) (make-string 3000 #\a)) (iota 100))`,
        "response-size": 999_999,
      });
      const [block] = result.content as Array<{ type: "text"; text: string }>;
      expect(block?.text.length).toBeLessThanOrEqual(RESPONSE_SIZE_MAX_CHARS);
      expect(block?.text).toMatch(/#\| \d+ .+ were not rendered; total array length is \d+ \|#/);
    });

    it("ignores a non-numeric response-size (falls back to the world default, no error)", async () => {
      const scope = LexicalScope.fresh("test");
      const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT", {
        observation: { maxTotalChars: 500 },
      });
      const result = await tool.call({ expr: "(iota 3000)", "response-size": "not-a-number" as unknown as number });
      expect(result.isError).toBeFalsy();
      const [block] = result.content as Array<{ type: "text"; text: string }>;
      expect(block?.text.length).toBeLessThanOrEqual(500);
      expect(block?.text).toMatch(/#\| \d+ .+ were not rendered; total array length is 3000 \|#/);
    });
  });

  describe("response-attachments — schema pin (behavior lives in unwrap.test.ts, alongside AttachmentCollector)", () => {
    it("pins the schema's default/max + per-turn cost teaching text verbatim", () => {
      const scope = LexicalScope.fresh("test");
      const tool = createManifoldTool({ capabilities, config, runCtx, scope }, "CATALOG TEXT");
      const properties = tool.describe().inputSchema.properties as Record<
        string,
        { type?: string; description: string }
      >;
      expect(properties["response-attachments"]).toMatchObject({ type: "integer" });
      expect(properties["response-attachments"]?.description).toBe(
        "Optional. How many image/binary attachments from tool results to include in this response " +
          `(default ${DEFAULT_PASSTHROUGH_ATTACHMENTS}, max ${MAX_PASSTHROUGH_ATTACHMENTS}). Attachments cost ` +
          "tokens on every subsequent turn — request more only when you specifically need to see them.",
      );
    });
  });
});
