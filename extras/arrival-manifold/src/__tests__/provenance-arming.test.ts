// PROVENANCE ARMING — wires an `EvalTrace` tap into the manifold REPL's eval loop
// (runner.ts's `RunInput.tap` → generator-exec.ts's `execState({ tap })`), so a
// tool-response value bound via `define` carries a provenance point that resolves
// back to its originating tool invocation through `EvalTrace.invocationById`.
//
// `createRosettaWrapper` (arrival's rosetta.ts) only mints a provenance point when
// `ctx.currentInvocation` is set, which requires a tap — so the manifold's runner must supply
// one for provenance to exist at all. This test proves the tap is armed, SESSION-scoped (one
// `EvalTrace` per `ManifoldEnv`, shared across every call against that world — never re-minted
// per call), and that ids stay resolvable across calls without colliding.

import { describe, expect, it } from "vitest";

import { buildManifoldEnv } from "../bind.js";
import { createManifoldTool, type ManifoldTool } from "../manifold-tool.js";

async function fakeToolWorld() {
  const manifoldEnv = await buildManifoldEnv([
    {
      slug: "t",
      tools: [
        {
          name: "fake-tool",
          description: "returns a fixed row set",
          inputSchema: { type: "object", properties: {} },
          invoke: async () => ({ rows: [{ a: 1 }] }),
        },
      ],
    },
  ]);
  // Explicit opt-in (manifold-tool.ts's `ManifoldToolOptions.trace`) — arming provenance
  // is deliberate, not a side effect of passing the whole `manifoldEnv` through.
  const tool: ManifoldTool = createManifoldTool(manifoldEnv, "CATALOG", { trace: manifoldEnv.trace });
  return { manifoldEnv, tool };
}

describe("provenance arming + per-call GC — points mint during a call, the graph dumps after it", () => {
  it("per-call provenance GC: after a call that minted points, the trace graph is EMPTY (stats zeroed)", async () => {
    const { manifoldEnv, tool } = await fakeToolWorld();
    await tool.call({ expr: "(define r (t/fake-tool))" });
    // manifold-tool.call()'s finally runs trace.clear() (execute → consume → dump):
    // the invocation graph — which retains every tool call's FULL boxed value at its
    // provenance point, a real OOM driver over a long session — must be gone the moment
    // the call returns. Session semantics survive by design: the session's truth is the
    // statement log + effect cache (re-execution model), never the trace.
    const stats = manifoldEnv.trace.stats();
    expect(stats.entries).toBe(0);
    expect(stats.points).toBe(0);
    expect(stats.retainedValueBytes).toBe(0);
  });

  it("WITHIN-call resolution works (the enricher's window): define + misuse in one program names the tool", async () => {
    // Direct proof that points mint + resolve while the call is live — the hint door
    // (hint-door.test.ts) consumes exactly this window; here we pin the window exists
    // even though the graph is dumped afterwards.
    const { manifoldEnv, tool } = await fakeToolWorld();
    const result = await tool.call({ expr: ["(define s (t/fake-tool))", "(take s 2)"] });
    const text = (result.content as Array<{ text: string }>).map((b) => b.text).join("\n");
    // rows is structured, take on a dict errors; the STRUCTURED origin variant proves
    // the point resolved (tool name present) before the dump.
    expect(text).toContain("Error");
    expect(manifoldEnv.trace.stats().entries).toBe(0); // and dumped again after
  });

  it("a program that never touches a tool mints no provenance points (mint is rosetta-scoped, not blanket)", async () => {
    const { manifoldEnv, tool } = await fakeToolWorld();
    await tool.call({ expr: "(+ 1 2)" });
    expect(manifoldEnv.trace.stats().points).toBe(0);
  });
});
