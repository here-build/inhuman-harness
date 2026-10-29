// void-provenance-leak — E1 (benchmark-defect-register.md §E, "'undefined' blocks: 442
// occurrences / 63 files. ONE LINE."): runner.ts filtered non-observations with
// `r === theVoid`, but `AVoid.withProvenance(p)` mints a FRESH heap object (AVoid.ts:48-50),
// so a void re-stamped while crossing a tap (any EvalTap — provenance tracing, not just the
// real EvalTrace) is no longer `=== theVoid`. The filter then falls through, the fresh AVoid
// gets rendered, its `["arrival/toJS"]()` unwraps to plain JS `undefined`, and
// arrival-serializer's `toSExpr` stringifies that as the literal text "undefined" — the
// documented harm: a model reading our artifact concluded "It printed undefined many times...
// maybe my filtering failed" and debugged OUR bug for rounds.
//
// arrival's own `values/structural-equal.ts:126-129` already documents this exact trap
// ("provenance-clone trap: x === y is NOT sufficient... use instance-aware checks") — the
// runner was the one place that ignored its own rule.

import { LexicalScope, RunContext, disposeRunContext, execState, type EvalTap } from "@here.build/arrival";
import { AValue } from "@here.build/arrival/reflect-internals";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AttachmentSink } from "../attachment-sink.js";
import type { BoundTool } from "../bound-tool.js";
import { createDoorsRunner } from "../runner.js";
import { KWARGS_STRATEGIES } from "../strategies.js";

const noopSink: AttachmentSink = {
  beginCall(): void {},
  drainBlocks: () => [],
  drainNote: () => undefined,
};

function makeRunner(): ReturnType<typeof createDoorsRunner> {
  return createDoorsRunner({
    toolNaming: { toolName: "eval", argName: "expr" },
    strategies: KWARGS_STRATEGIES,
    attachmentSink: noopSink,
  });
}

const capabilities: readonly [] = [];
const config: Record<string, unknown> = {};
let runCtx: RunContext;
beforeAll(async () => {
  const state = await execState("(begin)", {
    capabilities,
    config,
    scope: LexicalScope.fresh("mcp-substrate-test-mint"),
  });
  runCtx = state.runCtx;
});
afterAll(async () => {
  await disposeRunContext(runCtx);
});

function freshScope(name: string): LexicalScope {
  return LexicalScope.fresh(name);
}

const noTools = new Map<string, BoundTool>();

/** Minimal `EvalTap` reproducing the documented provenance-clone trap generally — not the full
 *  EvalTrace machinery (which only re-stamps once a REAL provenance point exists upstream, e.g.
 *  behind a real tool call; see arrival-manifold's `provenance-arming.test.ts` for how that one
 *  is armed). Every resolved `AValue` — including `theVoid` — is re-stamped with a fresh,
 *  non-empty provenance Set via `withProvenance()`, exactly the operation `AVoid.withProvenance`
 *  performs when a REAL tap fires across a membrane crossing. This isolates the runner-side bug
 *  (its `r === theVoid` identity filter) from the timing details of when a real tap re-stamps. */
function makeRestampingTap(): EvalTap {
  let nextId = 0;
  const provenance = new Set([1]);
  return {
    enter: (node, parent) => ({ id: nextId++, node, parent, state: "open" }) as never,
    exit: (_invocation, result) => {
      if ("value" in result && result.value instanceof AValue) {
        return { value: result.value.withProvenance(provenance) };
      }
      return undefined;
    },
  };
}

describe("runner.ts — void results re-stamped by a tap must never render as 'undefined' (E1)", () => {
  it("RED (pre-fix): a void-result form under a restamping tap renders NOTHING, never the text 'undefined'", async () => {
    const runner = makeRunner();
    const scope = freshScope("void-provenance-leak-plain");
    const result = await runner.run({
      expr: "(if #f #f)",
      capabilities,
      config,
      runCtx,
      scope,
      tools: noTools,
      tap: makeRestampingTap(),
    });

    const texts = result.content.map((b) => (b.type === "text" ? b.text : ""));
    expect(texts.join("\n")).not.toContain("undefined");
    expect(result.content).toHaveLength(0);
  });

  it("a define whose value is void still announces the binding, never 'undefined', under a restamping tap", async () => {
    const runner = makeRunner();
    const scope = freshScope("void-provenance-leak-define");
    const result = await runner.run({
      expr: "(define x (if #f #f))",
      capabilities,
      config,
      runCtx,
      scope,
      tools: noTools,
      tap: makeRestampingTap(),
    });

    const texts = result.content.map((b) => (b.type === "text" ? b.text : ""));
    expect(texts.join("\n")).not.toContain("undefined");
    // the introduced-binding note is the ONLY content — the void result itself renders nothing.
    expect(result.content).toHaveLength(1);
  });
});
