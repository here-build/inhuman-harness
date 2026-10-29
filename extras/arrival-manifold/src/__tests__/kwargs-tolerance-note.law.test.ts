// THE KWARGS TOLERANCE MUST SPEAK — a dropped argument the model is never told about is a lie.
//
// Reported (real trajectory):
//   (memory/search_nodes :query "Michael Thompson" :limit 10)
//   => Error: arguments rejected — :limit — unknown key        [HARD CRASH]
//
// V: "we should be tolerant to missing keys, and instead of crashing just note that this key is
// not affecting anything."
//
// The B5 tolerance made the call PROCEED (right — `:limit` changes nothing, and a model should not
// eat a hard rejection over an argument the tool ignores). But the NOTE explaining what was dropped
// was produced into a WeakMap and never surfaced: `drainDroppedKwargNotes` had ZERO production
// callers. So the model went from an unexplained CRASH to an unexplained SILENT DROP — it still
// believed `:limit 10` had been honored, and would reasonably conclude the tool ignores limits, or
// that its own result set had been capped at 10.
//
// A silent drop is a lie of omission, and the governing diagnosis of this medium is that the return
// channel must never lie: EVERY "nothing happened" must name WHICH nothing it is.
//
// Two clauses, and the second is what makes the first safe:
//   1. The call PROCEEDS and the model is TOLD.
//   2. A NEAR key (a typo of a real parameter) still HARD-REJECTS — tolerance is for noise, not for
//      mistakes. Silently dropping `:queyr` would hide a real bug behind a helpful shrug.

import { describe, expect, it } from "vitest";

import { buildManifoldEnv } from "../bind.js";
import { createManifoldTool } from "../manifold-tool.js";

const textOf = (r: { content: unknown }): string =>
  (r.content as Array<{ type: string; text: string }>).map((b) => b.text).join("\n");

/** A tool declaring ONLY `:query` — exactly the shape of the reported `memory/search_nodes`. */
async function memoryWorld() {
  let received: unknown;
  const env = await buildManifoldEnv([
    {
      slug: "memory",
      tools: [
        {
          name: "search_nodes",
          description: "Search for nodes in the knowledge graph",
          inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          invoke: async (args: unknown) => {
            received = args;
            return JSON.stringify([{ name: "Michael Thompson" }]);
          },
        },
      ],
    },
  ]);
  return { tool: createManifoldTool(env, "CATALOG", { trace: env.trace }), received: () => received };
}

describe("LAW — a far-unknown kwarg is DROPPED, the call PROCEEDS, and the model is TOLD", () => {
  it("the reported trace: (memory/search_nodes :query … :limit 10)", async () => {
    const { tool, received } = await memoryWorld();
    const r = await tool.call({ expr: `(memory/search_nodes :query "Michael Thompson" :limit 10)` });

    // 1. It did not crash — that was the original defect.
    expect((r as { isError?: boolean }).isError ?? false).toBe(false);

    // 2. The tool saw only its declared parameter.
    expect(received()).toEqual({ query: "Michael Thompson" });

    const text = textOf(r);
    // 3. The answer is there.
    expect(text).toContain("Michael Thompson");

    // 4. AND THE MODEL WAS TOLD. This is the clause that was missing: without it the model believes
    //    `:limit 10` was honored and reasons from a false premise.
    expect(text).toContain(":limit is not a parameter of this tool");
    expect(text).toContain("ignored");

    // 5. It arrives as BOOKKEEPING, in the consolidated channel — a reader-comment block that parses
    //    to zero forms — so the model can tell it apart from the answer at a glance.
    expect(text).toContain("── environment notes ──");
  });

  it("the note is reported ONCE even when the tolerance fires on several calls in one program", async () => {
    const { tool } = await memoryWorld();
    const r = await tool.call({
      expr: [
        `(define a (memory/search_nodes :query "x" :limit 10))`,
        `(define b (memory/search_nodes :query "y" :limit 20))`,
      ],
    });
    const text = textOf(r);
    const occurrences = text.split(":limit is not a parameter").length - 1;
    // The model needs the FACT, not a tally.
    expect(occurrences).toBe(1);
  });
});

describe("LAW — a NEAR key is a TYPO, and still hard-rejects (tolerance is for noise, not mistakes)", () => {
  it("(:queyr …) — a misspelling of a real parameter — must NOT be silently dropped", async () => {
    const { tool, received } = await memoryWorld();
    const r = await tool.call({ expr: `(memory/search_nodes :queyr "Michael Thompson")` });

    // Silently dropping a typo would hide a real bug behind a helpful shrug, and the model would
    // get an unfiltered result set while believing it had searched.
    expect((r as { isError?: boolean }).isError ?? false).toBe(true);
    expect(received()).toBeUndefined();
    expect(textOf(r)).toContain("queyr");
  });
});
