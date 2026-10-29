// REPL continue semantics (errors-as-doors Rule 2, discovery phase). Independent top-level
// statements in a multi-statement expr (manifold-tool.ts, the REPL CONTINUE block) CONTINUE
// after a failure — each statement's result or error appears AT ITS POSITION in the content
// blocks (the python bridge labels them `;; result N:`); `isError` is true iff ALL
// statements failed — partial success is success with inline errors. Whole-call exceptions
// (syntax, timeout) stay single-block; see the contract comment.
//
// Dependency attribution (skip-with-reason for a statement referencing a failed define) is
// still out of scope — the REPL never skips a sibling statement. But the natural unbound-
// variable error a dependent statement surfaces IS enriched by doors.ts's scope-confusion
// door (the "same-program cascade" case) — see the test below: the frozen
// `Error: Unbound variable \`X'` first line is preserved verbatim (H-4), with a teaching
// suffix appended pointing at the ROOT failing statement.

import { describe, expect, it } from "vitest";

import { buildManifoldEnv } from "../bind.js";
import { createManifoldTool, type ManifoldTool } from "../manifold-tool.js";

const texts = (r: { content: unknown }): string[] =>
  (r.content as Array<{ type: string; text: string }>).map((b) => b.text);

async function replTool(timeoutMs?: number): Promise<ManifoldTool> {
  const manifoldEnv = await buildManifoldEnv([
    {
      slug: "t",
      tools: [
        {
          name: "echo",
          description: "echoes",
          inputSchema: { type: "object", properties: { v: { type: "string" } }, required: ["v"] },
          invoke: async (args) => args.v,
        },
      ],
    },
  ]);
  return createManifoldTool(manifoldEnv, "CATALOG", timeoutMs === undefined ? {} : { timeoutMs });
}

describe("REPL continue semantics", () => {
  it("statement 2 of 4 erroring no longer kills siblings — results and the error each land at their position", async () => {
    const tool = await replTool();
    const result = await tool.call({ expr: "(+ 1 1)\n(car 42)\n(+ 3 3)\n(+ 4 4)" });
    // Partial success = SUCCESS with the error inline.
    expect(result.isError).toBeFalsy();
    expect(texts(result)).toEqual([
      "2",
      "Error: car: the number primitive does not support car (no arrival/tagless-final/car).",
      "6",
      "8",
    ]);
  });

  it("statements after a failure run against the same env — defines before AND after the failure land", async () => {
    const tool = await replTool();
    const result = await tool.call({ expr: "(define a 1)\n(car 42)\n(define b 2)" });
    expect(result.isError).toBeFalsy();
    const after = await tool.call({ expr: "(+ a b)" });
    expect(texts(after)).toEqual(["3"]);
  });

  it("isError is true iff ALL statements failed", async () => {
    const tool = await replTool();
    const allFail = await tool.call({ expr: "(car 1) (car 2)" });
    expect(allFail.isError).toBe(true);
    expect(texts(allFail)).toEqual([
      "Error: car: the number primitive does not support car (no arrival/tagless-final/car).",
      "Error: car: the number primitive does not support car (no arrival/tagless-final/car).",
    ]);
    // The single-statement failure keeps the historical frozen shape: ONE block, isError.
    const single = await tool.call({ expr: "(car 1)" });
    expect(single.isError).toBe(true);
    expect(texts(single)).toHaveLength(1);
  });

  it("a failed tool call doesn't kill the sibling statements either", async () => {
    const tool = await replTool();
    const result = await tool.call({ expr: '(this-symbol-is-unbound)\n(t/echo :v "still-ran")' });
    expect(result.isError).toBeFalsy();
    expect(texts(result)).toEqual(["Error: Unbound variable `this-symbol-is-unbound'", '"still-ran"']);
  });

  it("a statement depending on a FAILED define surfaces the natural unbound error (no causal skip), enriched by the scope-confusion cascade door", async () => {
    const tool = await replTool();
    const result = await tool.call({ expr: "(define broken (car 42))\n(+ broken 1)" });
    expect(result.isError).toBe(true); // both statements failed
    const blocks = texts(result);
    expect(blocks[0]).toContain("does not support car");
    // H-4: the frozen first line stays verbatim; the cascade door appends its teaching below it.
    expect(blocks[1]!.split("\n")[0]).toBe("Error: Unbound variable `broken'");
    expect(blocks[1]).toContain(
      "`broken' was defined above in this program, but an earlier statement failed, so its (define) never ran",
    );
    expect(blocks[1]).toContain("statement 1");
  });

  it("malformed syntax stays a WHOLE-CALL error with the reader's original coordinates — nothing runs", async () => {
    const tool = await replTool();
    const result = await tool.call({ expr: "(+ 1 2))" });
    expect(result.isError).toBe(true);
    expect(texts(result)).toEqual([
      "Error: unexpected ')' at 1:7 — check bracket balance near that point (a stray or missing " +
        "closer is the usual cause), fix, and resend.",
    ]);
    // …and the pre-close statements did NOT execute (the syntax gate runs before eval).
    const gated = await tool.call({ expr: "(define gated 9))" });
    expect(gated.isError).toBe(true);
    const check = await tool.call({ expr: "gated" });
    expect(texts(check)).toEqual(["Error: Unbound variable `gated'"]);
  });

  it("the timeout budget bounds the WHOLE call — never reset per statement — and stays the frozen single block", async () => {
    const tool = await replTool(400);
    const start = Date.now();
    // Statement 1 succeeds fast; statement 2 burns the budget; statement 3 must never run.
    const result = await tool.call({
      expr: "(define ok 1)\n(define (f) (f)) (f)\n(define never-defined-after-timeout 2)",
    });
    expect(Date.now() - start).toBeLessThan(5000);
    expect(result.isError).toBe(true);
    expect(texts(result)).toHaveLength(1);
    expect(texts(result)[0]).toContain("evaluation timed out after 400ms");
    const never = await tool.call({ expr: "never-defined-after-timeout" });
    expect(texts(never)).toEqual(["Error: Unbound variable `never-defined-after-timeout'"]);
    // …while the pre-deadline define persisted (H-1's existing guarantee).
    const ok = await tool.call({ expr: "ok" });
    expect(texts(ok)).toEqual(["1"]);
  });

  it("splitting respects vector/bytevector literals, char parens, strings, and quote prefixes", async () => {
    const tool = await replTool();
    const statements = [String.raw`(vector-ref #(1 2 3) 0)`, "'(a b)", String.raw`(string-length "a ) b")`];
    const result = await tool.call({ expr: statements.join("\n") });
    expect(result.isError).toBeFalsy();
    expect(texts(result)).toEqual(["1", "[a b]", "5"]);
  });
});
