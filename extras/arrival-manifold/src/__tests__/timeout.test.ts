// H-1 — per-eval timeout. Two composed bounds (see manifold-tool.ts):
// arrival's in-band `budgetMs` for CPU-bound runaways, an outer race (+grace) for evals
// parked inside a never-resolving host await. Both normalize to ONE frozen timeout string.

import { describe, expect, it } from "vitest";

import { buildManifoldEnv, type RemoteTool } from "../bind.js";
import { createManifoldTool } from "../manifold-tool.js";

const textOf = (r: { content: unknown }): string =>
  (r.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");

async function manifoldWith(tools: RemoteTool[], timeoutMs: number) {
  const manifoldEnv = await buildManifoldEnv(tools.length === 0 ? [] : [{ slug: "t", tools }]);
  return createManifoldTool(manifoldEnv, "CATALOG", { timeoutMs });
}

describe("manifold-tool eval timeout (H-1)", () => {
  it("kills a model-written infinite recursion — (define (f) (f)) (f) — instead of hanging", async () => {
    const tool = await manifoldWith([], 300);
    const start = Date.now();
    const result = await tool.call({ expr: "(define (f) (f)) (f)" });
    expect(Date.now() - start).toBeLessThan(5000);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Error: evaluation timed out after 300ms — the expr did not finish within the evaluation budget. " +
        "Likely an infinite loop/recursion, or a stuck tool call. The environment is still usable: " +
        "fix the runaway expression and try again, splitting the work into smaller exprs if needed.",
    );
  });

  it("kills a named-let loop the same way", async () => {
    const tool = await manifoldWith([], 300);
    const result = await tool.call({ expr: "(let loop () (loop))" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("evaluation timed out after 300ms");
  });

  it("never leaks arrival's raw budget message — the frozen string is the only timeout surface", async () => {
    const tool = await manifoldWith([], 200);
    const result = await tool.call({ expr: "(define (f) (f)) (f)" });
    expect(textOf(result)).not.toContain("execution budget exceeded");
  });

  it("unparks an eval stuck inside a never-resolving tool call (where the interpreter can't tick)", async () => {
    const tool = await manifoldWith(
      [{ name: "stuck", inputSchema: { type: "object" }, invoke: () => new Promise(() => {}) }],
      200,
    );
    const start = Date.now();
    const result = await tool.call({ expr: "(t/stuck)" });
    // 200ms budget + 250ms parked grace, with slack for CI scheduling.
    expect(Date.now() - start).toBeLessThan(3000);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("evaluation timed out after 200ms");
  });

  it("leaves the persistent env usable after a timeout, keeping bindings from forms that fully evaluated", async () => {
    const tool = await manifoldWith([], 300);
    const first = await tool.call({ expr: "(define zz 41) (define (f) (f)) (f)" });
    expect(first.isError).toBe(true);
    // Same env, next eval: works, and sees the define that completed before the runaway form.
    const second = await tool.call({ expr: "(+ zz 1)" });
    expect(second.isError).toBeFalsy();
    expect(textOf(second)).toBe("42");
  });

  it("an abandoned parked eval cannot act after its deadline — the late tool result is discarded, the env unharmed", async () => {
    let release!: (v: unknown) => void;
    const gate = new Promise((resolve) => (release = resolve));
    const tool = await manifoldWith(
      [{ name: "slow", inputSchema: { type: "object" }, invoke: () => gate.then(() => "late-result") }],
      200,
    );
    const result = await tool.call({ expr: "(define marker 1) (t/slow) (define after-slow 2)" });
    expect(result.isError).toBe(true);
    // Now the parked host op resolves — the abandoned run's budget is expired and its signal
    // aborted, so `(define after-slow 2)` must never execute.
    release(undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const check = await tool.call({ expr: "after-slow" });
    expect(check.isError).toBe(true);
    expect(textOf(check)).toContain("Unbound variable");
    // ...while the pre-deadline define persisted, and the env still evaluates normally.
    const marker = await tool.call({ expr: "(+ marker 100)" });
    expect(textOf(marker)).toBe("101");
  });

  it("a fast eval is untouched by the budget machinery", async () => {
    const tool = await manifoldWith([], 300);
    const result = await tool.call({ expr: "(+ 1 2)" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("3");
  });
});
