// Integration suite for manifold type-hints — exercises the REAL manifold tool
// (createManifoldTool / buildManifoldServer, the actual statement loop, the real
// DoorSession, the real listChanged world-rebuild) with a STUB TypeHintLens injected
// through `ManifoldToolOptions.typeHints`. Every assertion here pins END-TO-END WIRING
// behavior — activation/race, telemetry, cap+trailing-block delivery, ring lifecycle —
// NOT the pure select/render/context-ring logic, which the sibling files in this
// directory already pin in isolation.

import { disposeRunContext, execState, LexicalScope, RunContext } from "@here.build/arrival";
import {
  DoorSession,
  HINT_RACE_BUDGET_MS,
  type LoweredUnit,
  type MappedDiagnostic,
  type SchemeSpan,
  type TypeHintLens,
  type TypeHintsMode,
  type TypeHintTelemetry,
} from "@inhuman.tools/substrate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildManifoldEnv, toBoundTools } from "../../bind.js";
import { connectServer } from "../../connect.js";
import { createManifoldTool, type ManifoldToolOptions } from "../../manifold-tool.js";
import { buildManifoldServer } from "../../server.js";

// ONE bare (runCtx, capabilities, config) triple (no capabilities, no tools) shared across
// every bare `createManifoldTool` call in this file — it is stateless and immutable, so
// sharing it costs nothing; only the SCOPE needs to be fresh per call, for isolation
// between cases. Tests that bind real tools (`buildManifoldEnv`) mint their own world
// instead and are unaffected by this one.
const capabilities: readonly [] = [];
const config: Record<string, unknown> = {};
let runCtx: RunContext;
beforeAll(async () => {
  const state = await execState("(begin)", { capabilities, config, scope: LexicalScope.fresh("type-hints-test-mint") });
  runCtx = state.runCtx;
});
afterAll(async () => {
  await disposeRunContext(runCtx);
});

type Block = { type: string; text: string };
const blocksOf = (r: { content: unknown }): Block[] => r.content as Block[];
const textOf = (r: { content: unknown }): string =>
  blocksOf(r)
    .map((b) => b.text)
    .join("\n");

/** Plain builder, kept for call-site brevity across this whole suite rather than repeating
 *  `{ ...base, typeHints: { mode, lens } }` at every `createManifoldTool` call. */
function withTypeHints(base: ManifoldToolOptions, mode: TypeHintsMode, lens: TypeHintLens): ManifoldToolOptions {
  return { ...base, typeHints: { mode, lens } };
}

// ─── fixtures: statement spans aligned to a program's REAL top-level layout ───
//
// manifold-tool.ts's `splitTopLevel` (the real lexer-based splitter) is not exported, so
// spans are computed here from the EXACT statement strings the caller supplies — they
// must appear verbatim (trimmed, in order) in `source`, the same shape splitTopLevel
// itself produces. This keeps every LoweredUnit fixture honest without duplicating the
// lexer-based splitter in test code.
function spansFor(source: string, statements: readonly string[]): SchemeSpan[] {
  const spans: SchemeSpan[] = [];
  let cursor = 0;
  for (const stmt of statements) {
    const start = source.indexOf(stmt, cursor);
    if (start === -1) throw new Error(`fixture bug: statement not found in source at/after ${cursor}: ${stmt}`);
    spans.push({ start, end: start + stmt.length });
    cursor = start + stmt.length;
  }
  return spans;
}

function unitFor(source: string, statements: readonly string[], programStartOffset = 0): LoweredUnit {
  return { programStartOffset, statementSpans: spansFor(source, statements) };
}

function diag(overrides: Partial<MappedDiagnostic> & { code: number; span: SchemeSpan }): MappedDiagnostic {
  return { tsMessage: "stub diagnostic — RED fixture, never rendered raw per doc §4", ...overrides };
}

// ─── the stub lens (TypeHintLens) — the only implementation under this suite's control ───

interface StubLensCall {
  programSource: string;
  contextDefines: readonly string[];
}
interface StubLens {
  lens: TypeHintLens;
  calls: StubLensCall[];
}

/** One fixed-behavior stub lens. `delayMs` simulates the language-service round trip
 *  (race/staleness tests); `crash` simulates a lens throw (doc §3: crash → render nothing,
 *  telemetry skip:"crash"). Every invocation is recorded, in call order. */
function makeStubLens(opts: {
  unit: LoweredUnit;
  diagnostics: readonly MappedDiagnostic[];
  delayMs?: number;
  crash?: boolean;
}): StubLens {
  const calls: StubLensCall[] = [];
  const lens: TypeHintLens = {
    async diagnose(programSource, contextDefines) {
      calls.push({ programSource, contextDefines });
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      if (opts.crash) throw new Error("stub lens crash (RED fixture)");
      return { unit: opts.unit, diagnostics: opts.diagnostics };
    },
  };
  return { lens, calls };
}

/** A SEQUENCED stub lens: the Nth `diagnose()` invocation uses `configs[N]` (clamped to
 *  the last entry). Models the REAL architecture faithfully for the stale-generation test
 *  (§1/G6): the lens is ONE instance living for the manifold server process's lifetime
 *  (doc §1: "The lens instance is per manifold server process"), so two overlapping calls
 *  share it — a generation counter, if implemented correctly, lives ABOVE this lens, not
 *  inside two separately-constructed stub instances. */
function makeSequencedStubLens(
  configs: readonly { unit: LoweredUnit; diagnostics: readonly MappedDiagnostic[]; delayMs?: number }[],
): StubLens {
  const calls: StubLensCall[] = [];
  let n = 0;
  const lens: TypeHintLens = {
    async diagnose(programSource, contextDefines) {
      const cfg = configs[Math.min(n, configs.length - 1)]!;
      n += 1;
      calls.push({ programSource, contextDefines });
      if (cfg.delayMs) await new Promise((resolve) => setTimeout(resolve, cfg.delayMs));
      return { unit: cfg.unit, diagnostics: cfg.diagnostics };
    },
  };
  return { lens, calls };
}

// ─── telemetry capture (DoorSession log hook — same pattern as doors.test.ts) ───

function telemetryEventsOf(lines: readonly string[]): TypeHintTelemetry[] {
  return lines
    .filter((l) => l.startsWith("{"))
    .map((l): unknown => JSON.parse(l))
    .filter(
      (e): e is TypeHintTelemetry =>
        typeof e === "object" && e !== null && (e as { door?: unknown }).door === "envelope/type-hint",
    );
}

/** Every TypeHintTelemetry event, wherever it is captured in this suite, must shape-match
 *  the frozen interface (types.ts) — doc §3/G7: "every skip is telemetry." */
function assertTelemetryShape(e: TypeHintTelemetry): void {
  expect(e.door).toBe("envelope/type-hint");
  expect(typeof e.rendered).toBe("boolean");
  if (e.rendered) {
    expect(e.skip).toBeUndefined();
  } else {
    expect(["crash", "race", "unmappable", "unrenderable", "no-diag", "mode-off"]).toContain(e.skip);
  }
  if (e.code !== undefined) expect(typeof e.code).toBe("number");
  if (e.latencyMs !== undefined) expect(typeof e.latencyMs).toBe("number");
}

// A symbol far from every stdlib/tool name by construction — never draws an
// unboundInExprDoor did-you-mean suggestion (see doors.test.ts's own "genuinely unknown"
// fixtures), so it isolates the unbound-error SHAPE without incidental enrichment noise.
const UNBOUND = "zzz-totally-unbound-zzz";

describe("RING-2 (integration) — manifold type-hints, through the REAL tool + a stub lens", () => {
  describe("§1/§3/G12 — trailing-block delivery", () => {
    it("2-statement program, statement 1 errors, lens hits statement 1 → [stmt0, stmt1-error, TRAILING hint]; the first two blocks byte-identical to a typeHints-off run", async () => {
      const statements = ["(+ 1 2)", `(${UNBOUND})`];
      const source = statements.join("\n");
      const unit = unitFor(source, statements);
      const hitDiag = diag({ code: 2345, span: unit.statementSpans[1]!, expected: "number", actual: "string" });
      const { lens } = makeStubLens({ unit, diagnostics: [hitDiag] });

      const hintedTool = createManifoldTool(
        { capabilities, config, runCtx, scope: LexicalScope.fresh("test") },
        "CATALOG",
        withTypeHints({}, "on-error", lens),
      );
      const hinted = await hintedTool.call({ expr: source });

      const baselineTool = createManifoldTool(
        { capabilities, config, runCtx, scope: LexicalScope.fresh("test") },
        "CATALOG",
      );
      const baseline = await baselineTool.call({ expr: source });

      // Partial success: stmt0 succeeded, stmt1 failed → isError is false (REPL-continue).
      expect(hinted.isError).toBeFalsy();
      expect(baseline.isError).toBeFalsy();

      const baselineBlocks = blocksOf(baseline);
      expect(baselineBlocks).toHaveLength(2); // fixture sanity — no lens involved at all

      const hintedBlocks = blocksOf(hinted);
      // RED: today `typeHints` is wired nowhere — hintedBlocks is length 2 (identical to
      // baseline). This is the assertion that must start passing once the trailing-block
      // delivery is wired correctly.
      expect(hintedBlocks).toHaveLength(3);
      expect(hintedBlocks[0]!.text).toBe(baselineBlocks[0]!.text);
      expect(hintedBlocks[1]!.text).toBe(baselineBlocks[1]!.text);
      const trailing = hintedBlocks[2]!.text;
      expect(trailing.startsWith("Type")).toBe(true);
      expect(trailing).toContain(UNBOUND); // statement-head naming, G12
    });
  });

  describe("§1/§6/G9 — mode gate", () => {
    it('mode "off" → the lens is NEVER called, no trailing block, no telemetry', async () => {
      const statements = ["(+ 1 2)", `(${UNBOUND})`];
      const source = statements.join("\n");
      const unit = unitFor(source, statements);
      const { lens, calls } = makeStubLens({
        unit,
        diagnostics: [diag({ code: 2345, span: unit.statementSpans[1]! })],
      });
      const lines: string[] = [];
      const session = new DoorSession((l) => lines.push(l));
      const tool = createManifoldTool(
        { capabilities, config, runCtx, scope: LexicalScope.fresh("test") },
        "CATALOG",
        withTypeHints({ session }, "off", lens),
      );
      const result = await tool.call({ expr: source });

      expect(calls).toHaveLength(0);
      expect(blocksOf(result)).toHaveLength(2);
      expect(telemetryEventsOf(lines)).toHaveLength(0);
    });

    it('mode "telemetry" → the lens IS called, NEVER renders a trailing block, telemetry logs rendered:false', async () => {
      const statements = ["(+ 1 2)", `(${UNBOUND})`];
      const source = statements.join("\n");
      const unit = unitFor(source, statements);
      const { lens, calls } = makeStubLens({
        unit,
        diagnostics: [diag({ code: 2345, span: unit.statementSpans[1]! })],
      });
      const lines: string[] = [];
      const session = new DoorSession((l) => lines.push(l));
      const tool = createManifoldTool(
        { capabilities, config, runCtx, scope: LexicalScope.fresh("test") },
        "CATALOG",
        withTypeHints({ session }, "telemetry", lens),
      );
      const result = await tool.call({ expr: source });

      expect(calls).toHaveLength(1); // RED: never called today
      expect(blocksOf(result)).toHaveLength(2); // never renders in "telemetry" mode
      const events = telemetryEventsOf(lines);
      expect(events).toHaveLength(1);
      assertTelemetryShape(events[0]!);
      expect(events[0]!.rendered).toBe(false);
      // CONTRACT AMBIGUITY (flagged in the final report, not resolved here): types.ts's
      // `skip` enum has no value distinct from "off" for "mode configuration says never
      // render" — "mode-off" is the best-fit reading, pinned here.
      expect(events[0]!.skip).toBe("mode-off");
    });

    it('mode "on-error" with an all-succeeding program → lens IS called (§1: telemetry corpus), never renders (no error to attach to)', async () => {
      const statements = ["(+ 1 2)", "(+ 3 4)"];
      const source = statements.join("\n");
      const unit = unitFor(source, statements);
      const { lens, calls } = makeStubLens({ unit, diagnostics: [] });
      const lines: string[] = [];
      const session = new DoorSession((l) => lines.push(l));
      const tool = createManifoldTool(
        { capabilities, config, runCtx, scope: LexicalScope.fresh("test") },
        "CATALOG",
        withTypeHints({ session }, "on-error", lens),
      );
      const result = await tool.call({ expr: source });

      expect(result.isError).toBeFalsy();
      expect(calls).toHaveLength(1); // RED
      expect(blocksOf(result)).toHaveLength(2); // no trailing block — nothing errored
      const events = telemetryEventsOf(lines);
      expect(events).toHaveLength(1);
      assertTelemetryShape(events[0]!);
      expect(events[0]!).toMatchObject({ rendered: false, skip: "no-diag" });
    });
  });

  describe(`§1/G6 — race budget (HINT_RACE_BUDGET_MS = ${HINT_RACE_BUDGET_MS}ms)`, () => {
    it("lens resolving IMMEDIATELY → the hint is present", async () => {
      const statements = ["(+ 1 2)", `(${UNBOUND})`];
      const source = statements.join("\n");
      const unit = unitFor(source, statements);
      const { lens } = makeStubLens({
        unit,
        diagnostics: [diag({ code: 2345, span: unit.statementSpans[1]! })],
        delayMs: 0,
      });
      const tool = createManifoldTool(
        { capabilities, config, runCtx, scope: LexicalScope.fresh("test") },
        "CATALOG",
        withTypeHints({}, "on-error", lens),
      );
      const result = await tool.call({ expr: source });
      expect(blocksOf(result)).toHaveLength(3); // RED
    });

    it("lens resolving after budget+200ms → no trailing block, error blocks unmodified; telemetry (once it lands) logs skip:'race'", async () => {
      const statements = ["(+ 1 2)", `(${UNBOUND})`];
      const source = statements.join("\n");
      const unit = unitFor(source, statements);
      const { lens } = makeStubLens({
        unit,
        diagnostics: [diag({ code: 2345, span: unit.statementSpans[1]! })],
        delayMs: HINT_RACE_BUDGET_MS + 200,
      });
      const lines: string[] = [];
      const session = new DoorSession((l) => lines.push(l));
      const tool = createManifoldTool(
        { capabilities, config, runCtx, scope: LexicalScope.fresh("test") },
        "CATALOG",
        withTypeHints({ session }, "on-error", lens),
      );

      const result = await tool.call({ expr: source });
      expect(blocksOf(result)).toHaveLength(2); // race lost — no trailing block
      // "unmodified" means byte-identical to a no-lens run's error shape.
      expect(blocksOf(result)[1]!.text).toContain(`Unbound variable \`${UNBOUND}'`);

      // §1: "telemetry still records the eventual result when it lands" — wait past the
      // lens's own delay for its (late) telemetry line to land.
      await new Promise((resolve) => setTimeout(resolve, HINT_RACE_BUDGET_MS + 300));
      const events = telemetryEventsOf(lines);
      expect(events.some((e) => e.rendered === false && e.skip === "race")).toBe(true); // RED
    });
  });

  describe("§1/G6 — stale generation (a call-N lens result must never render for call N+1, nor leak into its telemetry)", () => {
    it("call N (slow lens) then call N+1 (fast lens) before N resolves → N+1 gets ITS OWN hint; N's stale result is discarded, never rendered, telemetry still logs it late", async () => {
      const env = { capabilities, config, runCtx, scope: LexicalScope.fresh("test") };
      const lines: string[] = [];
      const session = new DoorSession((l) => lines.push(l));

      const statementsN = ["(+ 1 2)", `(${UNBOUND})`];
      const sourceN = statementsN.join("\n");
      const unitN = unitFor(sourceN, statementsN);

      const statementsN1 = ["(+ 3 4)", `(${UNBOUND})`];
      const sourceN1 = statementsN1.join("\n");
      const unitN1 = unitFor(sourceN1, statementsN1);

      // ONE lens instance shared by both overlapping calls — the real architecture (doc
      // §1: "The lens instance is per manifold server process ... serialized: one
      // in-flight run; a new call ABANDONS a stale in-flight run").
      const CODE_N = 2345;
      const CODE_N1 = 2339;
      const { lens, calls } = makeSequencedStubLens([
        { unit: unitN, diagnostics: [diag({ code: CODE_N, span: unitN.statementSpans[1]! })], delayMs: 600 },
        { unit: unitN1, diagnostics: [diag({ code: CODE_N1, span: unitN1.statementSpans[1]! })], delayMs: 0 },
      ]);

      const tool = createManifoldTool(env, "CATALOG", withTypeHints({ session }, "on-error", lens));

      // Fire N WITHOUT awaiting, then immediately fire N+1 — N+1 starts before N's
      // in-flight lens run (or even N's own call()) has settled.
      const pN = tool.call({ expr: sourceN });
      const pN1 = tool.call({ expr: sourceN1 });
      const [resultN, resultN1] = await Promise.all([pN, pN1]);

      expect(blocksOf(resultN1)).toHaveLength(3); // N+1 is fast — carries its OWN trailing hint (RED)
      expect(blocksOf(resultN)).toHaveLength(2); // N lost the race — no trailing hint on N's own result

      // Let N's stale lens land (started ~t0, resolves at ~t0+600ms).
      await new Promise((resolve) => setTimeout(resolve, 900));

      expect(calls).toHaveLength(2); // RED: today the lens is invoked zero times
      const events = telemetryEventsOf(lines);
      // Two lens outcomes total: N+1's (fast, rendered) lands first; N's (stale, discarded)
      // lands last EVEN THOUGH N was issued first (§1: "not cancelled mid-flight ... dropped
      // on arrival"). NOTE: the exact interleaving of two overlapping calls reaching their
      // own `lens.diagnose()` call is scheduler-dependent — see the final report.
      expect(events).toHaveLength(2); // RED
      expect(events[0]).toMatchObject({ rendered: true, code: CODE_N1 });
      expect(events[1]).toMatchObject({ rendered: false, skip: "race", code: CODE_N });

      // The discarded stale result must never retroactively surface on the already-returned
      // N+1 result object.
      expect(blocksOf(resultN1)).toHaveLength(3);
    });
  });

  describe("§3/G7 — telemetry shape (every lens outcome logs exactly one event, shape-matching TypeHintTelemetry)", () => {
    it("a rendered hit logs exactly one event: rendered:true, no skip, code present", async () => {
      const statements = ["(+ 1 2)", `(${UNBOUND})`];
      const source = statements.join("\n");
      const unit = unitFor(source, statements);
      const { lens } = makeStubLens({ unit, diagnostics: [diag({ code: 2345, span: unit.statementSpans[1]! })] });
      const lines: string[] = [];
      const session = new DoorSession((l) => lines.push(l));
      const tool = createManifoldTool(
        { capabilities, config, runCtx, scope: LexicalScope.fresh("test") },
        "CATALOG",
        withTypeHints({ session }, "on-error", lens),
      );
      await tool.call({ expr: source });

      const events = telemetryEventsOf(lines);
      expect(events).toHaveLength(1); // RED
      assertTelemetryShape(events[0]!);
      expect(events[0]!.rendered).toBe(true);
      expect(events[0]!.skip).toBeUndefined();
      expect(events[0]!.code).toBe(2345);
    });

    it("a lens CRASH → no trailing block, the call never rejects, telemetry logs rendered:false skip:'crash'", async () => {
      const statements = ["(+ 1 2)", `(${UNBOUND})`];
      const source = statements.join("\n");
      const unit = unitFor(source, statements);
      const { lens } = makeStubLens({
        unit,
        diagnostics: [diag({ code: 2345, span: unit.statementSpans[1]! })],
        crash: true,
      });
      const lines: string[] = [];
      const session = new DoorSession((l) => lines.push(l));
      const tool = createManifoldTool(
        { capabilities, config, runCtx, scope: LexicalScope.fresh("test") },
        "CATALOG",
        withTypeHints({ session }, "on-error", lens),
      );

      const result = await tool.call({ expr: source }); // must not throw/reject
      expect(blocksOf(result)).toHaveLength(2); // no trailing hint
      const events = telemetryEventsOf(lines);
      expect(events).toHaveLength(1); // RED
      assertTelemetryShape(events[0]!);
      expect(events[0]!).toMatchObject({ rendered: false, skip: "crash" });
    });
  });

  describe("§2/§3/G13.2 — context-ring lifecycle (through buildManifoldServer + tools/listChanged)", () => {
    interface MutableUpstream {
      server: Server;
      clientTransport: InMemoryTransport;
      setTools(tools: Tool[]): void;
    }

    async function fakeUpstream(): Promise<MutableUpstream> {
      const server = new Server(
        { name: "fake-upstream", version: "0.1.0" },
        { capabilities: { tools: { listChanged: true } } },
      );
      let tools: Tool[] = [
        { name: "alpha", description: "Alpha tool", inputSchema: { type: "object" } },
        { name: "other", description: "Other tool", inputSchema: { type: "object" } },
      ];
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ran" }] }));
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      return {
        server,
        clientTransport,
        setTools: (next) => {
          tools = next;
        },
      };
    }

    it("a successful define's context dies on a listChanged rebuild (empty contextDefines, world-scoped ring); DoorSession verbosity SURVIVES the rebuild (existing, unchanged behavior)", async () => {
      const upstream = await fakeUpstream();
      const connected = await connectServer("up", upstream.clientTransport);
      const unit: LoweredUnit = { programStartOffset: 0, statementSpans: [{ start: 0, end: 10 }] };
      const { lens, calls } = makeStubLens({ unit, diagnostics: [] });

      const manifoldServer = await buildManifoldServer([connected], withTypeHints({}, "on-error", lens));
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await manifoldServer.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "0.1.0" });
      await client.connect(clientTransport);

      const call = async (expr: string) =>
        (await client.callTool({ name: "scheme-repl-with-all-mcp-tools", arguments: { expr } })) as {
          content: unknown;
          isError?: boolean;
        };

      // A successful top-level define — the FUTURE contextDefines ring should record it.
      await call("(define ctxvar 42)");

      // Pre-rebuild: the FIRST occurrence of the unbound-in-expr door (bare `alpha`,
      // de-namespaced) is verbose.
      const preRebuild = await call("(alpha)");
      expect(textOf(preRebuild)).toContain("Tool symbols keep their full server/tool-name form");

      // Trigger the world rebuild (H-2: rebuild-the-world) — keep "alpha" bound (so the
      // did-you-mean text stays comparable pre/post) but change the toolset, forcing a
      // genuine rebuild rather than a no-op.
      upstream.setTools([
        { name: "alpha", description: "Alpha tool", inputSchema: { type: "object" } },
        { name: "extra", description: "Extra tool", inputSchema: { type: "object" } },
      ]);
      await upstream.server.sendToolListChanged();
      await vi.waitFor(async () => {
        const { tools } = await client.listTools();
        expect(tools[0]?.description ?? "").toContain("up/extra");
      });

      // Error a program post-rebuild — this is where the (future) lens would receive
      // whatever contextDefines the new world's ring holds.
      await call(`(${UNBOUND})`);

      expect(calls.length).toBeGreaterThan(0); // RED: the lens is never invoked today
      const lastCall = calls.at(-1);
      // G13.2: the ring lives on the per-rebuild world object, NOT on DoorSession — after a
      // rebuild it is EMPTY (the earlier `ctxvar` define is gone with the old world).
      expect(lastCall?.contextDefines).toEqual([]);

      // Existing, UNCHANGED behavior: DoorSession verbosity survives the rebuild — the
      // SAME code's second occurrence (post-rebuild) renders terse, not verbose again.
      const postRebuild = await call("(alpha)");
      // `alpha`'s inputSchema is `{ type: "object" }` (no properties/required) — its synthesized
      // example call degrades to a bare `(up/alpha)` (example-call.ts).
      expect(textOf(postRebuild)).toBe(
        "Error: Unbound variable `alpha'\n  the symbol you want is `up/alpha` — e.g. (up/alpha).",
      );
    });
  });

  describe("§3/G5/G12 — echo co-occurrence (signature-echo + type-hint on the SAME statement)", () => {
    it("both fire: the signature echo stays inline on the error block, the type hint is its own trailing block; neither suppresses the other", async () => {
      const manifoldEnv = await buildManifoldEnv([
        {
          slug: "toy",
          tools: [
            {
              name: "add",
              description: "Add two numbers",
              inputSchema: {
                type: "object",
                properties: { a: { type: "number" }, b: { type: "number" } },
                required: ["a", "b"],
              },
              invoke: async () => 0,
            },
          ],
        },
      ]);

      // Dangling keyword — arrival's OWN kwargs wall fires before any upstream call, same
      // fixture shape as signature-echo.test.ts's proven-working case.
      const statement = "(toy/add :a 1 :b)";
      const unit = unitFor(statement, [statement]);
      const hitDiag = diag({ code: 2554, span: unit.statementSpans[0]!, expected: "(toy/add :a number :b number)" });
      const { lens } = makeStubLens({ unit, diagnostics: [hitDiag] });

      const tool = createManifoldTool(
        manifoldEnv,
        "CATALOG",
        withTypeHints({ tools: toBoundTools(manifoldEnv) }, "on-error", lens),
      );
      const result = await tool.call({ expr: statement });

      expect(result.isError).toBe(true);
      const text = textOf(result);
      // The signature echo (already-shipped, H-4 frozen first line preserved verbatim).
      expect(text.split("\n")[0]).toBe(
        "Error: kwargs call has a dangling keyword with no value — expected interleaved `:key value` pairs, got 3 arg(s)",
      );
      expect(text).toContain("\nSignature: (toy/add :a number :b number) - Add two numbers");

      // RED: the trailing type hint block does not exist yet. A single-statement call
      // normally keeps the exactly-one-error-block shape (error-contract.test.ts); G12
      // appends the hint as a SECOND block, never folded into the first.
      const blocks = blocksOf(result);
      expect(blocks).toHaveLength(2);
      expect(blocks[1]!.text.startsWith("Type")).toBe(true);
    });
  });
});
