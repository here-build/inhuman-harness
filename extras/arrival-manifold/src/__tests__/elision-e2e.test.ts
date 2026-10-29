// elision-e2e — the full path: a REAL bound-tool upstream returns a too-long array, through
// `createManifoldTool`'s default calibration (`DEFAULT_MANIFOLD_OBSERVATION_ELISION` — no
// test-side override), and the observation the model reads back is middle-elided (small head +
// LOUD "N ... were not rendered" marker + small tail) with a trailing consolidated
// environment-notes block. This guards against a real grounding failure: a large array rendered
// near-complete with a tiny "+N more" marker buried at the very end reads to the model as
// complete, hiding the answer in the elided remainder.

import { describe, expect, it } from "vitest";

import { toBoundTools, buildManifoldEnv } from "../bind.js";
import { createManifoldTool, type ManifoldTool } from "../manifold-tool.js";

const texts = (r: { content: unknown }): string[] =>
  (r.content as Array<{ type: string; text: string }>).map((b) => b.text);

// 150 — clearly over the manifold's default `topLevelArrayLimit` (100), so this actually
// elides (an array sitting exactly AT the limit renders in full — no reduction needed at
// all, which is correct: the real MCP-Atlas failure was a small-content array shown almost
// complete via CHAR-budget-driven shrink, not the count boundary itself. 150 removes that
// ambiguity and demonstrates the mechanism unconditionally).
async function libraryTool(): Promise<ManifoldTool> {
  const books = Array.from({ length: 150 }, (_, i) => ({ id: i, title: `Book ${i}`, author: `Author ${i}` }));
  const manifoldEnv = await buildManifoldEnv([
    {
      slug: "library",
      tools: [
        {
          name: "list-books",
          description: "List every book in the catalog",
          inputSchema: { type: "object", properties: {} },
          invoke: async () => books,
        },
      ],
    },
  ]);
  return createManifoldTool(manifoldEnv, "CATALOG", { tools: toBoundTools(manifoldEnv) });
}

describe("elision e2e — a real bound-tool result that is a too-long array", () => {
  it("middle-elides (small head + LOUD marker + small tail) instead of a near-complete tail dump", async () => {
    const tool = await libraryTool();
    const result = await tool.call({ expr: "(library/list-books)" });
    expect(result.isError).toBeFalsy();

    const blocks = texts(result);
    const observation = blocks.find((t) => t.startsWith("["));
    expect(observation).toBeDefined();
    // Loud middle marker — never a buried tail footnote.
    expect(observation).toMatch(/#\| \d+ .+ were not rendered; total array length is 150 \|#/);
    // Only a SMALL head + tail actually render (id 0..4 and 145..149 — the manifold's default
    // elideHead/elideTail is 5/5), never a near-complete dump like the real failure had.
    expect(observation).toContain(":id 0");
    expect(observation).toContain(":id 149");
    expect(observation).not.toContain(":id 75"); // the hidden middle is genuinely absent
  });

  // The invariant this test protects: exactly ONE note summarizes the elision, regardless of how
  // many collections elided — riding the consolidated `#| ── environment notes ── … |#` trailing
  // block, never a standalone per-collection block. A per-collection enumeration is redundant
  // with the serializer's own inline `#| N similar items were not rendered … |#` marker
  // (arrival-serializer/src/serializer.ts) already carried at the elision site, and models have
  // misread that redundant enumeration as proof the value itself was destroyed — so the note
  // also states explicitly that the value is intact.
  it("carries exactly ONE trailing note summarizing the elision, and it says the value is intact", async () => {
    const tool = await libraryTool();
    const result = await tool.call({ expr: "(library/list-books)" });

    const blocks = texts(result);
    const noteBlocks = blocks.filter((t) => t.includes("── environment notes ──"));
    expect(noteBlocks).toHaveLength(1);
    // The model must be told the full value survives, so it binds and filters in-program
    // instead of concluding the data was lost.
    expect(noteBlocks[0]).toContain("the full value is intact in the session");
    expect(noteBlocks[0]).toContain("bind it and filter/aggregate in-program");
    expect(noteBlocks[0]).toContain("large results were sampled for display");
    // The note states only that the value survives — never a per-collection
    // enumeration/tautology re-describing what was shown.
    expect(noteBlocks[0]).not.toContain("array of 150 items:");
  });

  it("a call whose result fits within the manifold's limits carries no elision marker and no note", async () => {
    const manifoldEnv = await buildManifoldEnv([
      {
        slug: "library",
        tools: [
          {
            name: "list-books",
            description: "List every book in the catalog",
            inputSchema: { type: "object", properties: {} },
            invoke: async () => Array.from({ length: 5 }, (_, i) => ({ id: i, title: `Book ${i}` })),
          },
        ],
      },
    ]);
    const tool = createManifoldTool(manifoldEnv, "CATALOG", { tools: toBoundTools(manifoldEnv) });
    const result = await tool.call({ expr: "(library/list-books)" });

    const blocks = texts(result);
    expect(blocks.some((t) => t.includes("were not rendered"))).toBe(false);
    // Nothing elided ⇒ no elision advisory — checked against the consolidated
    // environment-notes channel's header, the sole surviving advisory block.
    expect(blocks.some((t) => t.includes("── environment notes ──"))).toBe(false);
  });
});
