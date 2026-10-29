// THE SCOPE-CONFUSION DOOR — e2e coverage through a REAL manifold tool. The pure unit coverage of
// the classifier itself (`scopeConfusionDoor`, `scanLocalBindings`, `createLocalBindingTracker`)
// lives in `@inhuman.tools/substrate`'s own `scope-confusion.test.ts` — this file keeps only
// the wiring-through-a-real-tool matrix.

import { DoorSession } from "@inhuman.tools/substrate";
import { describe, expect, it } from "vitest";

import { toBoundTools, buildManifoldEnv } from "../bind.js";
import { createManifoldTool, type ManifoldTool } from "../manifold-tool.js";

const texts = (r: { content: unknown }): string[] =>
  (r.content as Array<{ type: string; text: string }>).map((b) => b.text);

async function scopeTool(session?: DoorSession): Promise<ManifoldTool> {
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
          invoke: async (args) => (args.a as number) + (args.b as number),
        },
      ],
    },
  ]);
  return createManifoldTool(manifoldEnv, "CATALOG", { session, tools: toBoundTools(manifoldEnv) });
}

describe("scope-confusion — e2e through the manifold tool", () => {
  it("cascade: a multi-define program where statement 1 fails — later Unbound errors point at it", async () => {
    const tool = await scopeTool();
    // NOTE: single-letter names (a, b, z, ...) collide with arrival's own polyglot-rich-errors
    // registry (every single char is edit-distance-1 from the bound `@` symbol) — that's a
    // library-symbol hit which correctly SKIPS this door (isLibraryEnriched), so the test names
    // are multi-char to isolate the scope-confusion behavior under test.
    const result = await tool.call({
      expr: "(define broken-source (car 5))\n(define downstream-result (car broken-source))\n(cdr downstream-result)",
    });
    expect(result.isError).toBe(true);
    const blocks = texts(result);
    expect(blocks[0]).toContain("does not support car");
    // H-4: the frozen first line is preserved verbatim; the cascade teaching is appended below it.
    expect(blocks[1]!.split("\n")[0]).toBe("Error: Unbound variable `broken-source'");
    expect(blocks[1]).toContain("Fix the FIRST error (see the error at statement 1)");
    expect(blocks[2]!.split("\n")[0]).toBe("Error: Unbound variable `downstream-result'");
    // Same session, same door SHAPE (both the cascade case) as `broken-source`'s firing above → same
    // per-shape gate key, so this SECOND occurrence renders the terse one-liner (still naming
    // statement 1). The gate keys on `verbosityKey ?? code`; sibling scope-confusion shapes
    // (cross-scope, repeated-local) each keep their OWN verbose slot — see door-verbosity-shapes.test.ts.
    expect(blocks[2]).toContain("statement 1 failed first; fix that and the rest will bind");
  });

  it("cross-scope: a let-bound name in call 1, referenced bare in call 2", async () => {
    const tool = await scopeTool();
    const call1 = await tool.call({ expr: "(let ((zed 5)) zed)" });
    expect(call1.isError).toBeFalsy();
    expect(texts(call1)).toEqual(["5"]);

    const call2 = await tool.call({ expr: "zed" });
    expect(call2.isError).toBe(true);
    const text = texts(call2)[0]!;
    expect(text.split("\n")[0]).toBe("Error: Unbound variable `zed'");
    expect(text).toContain("a local scope (a let/lambda body) 1 message ago");
    expect(text).toContain("Re-declare it at top level with (define zed");
  });

  it("≥2-local: zed locally bound in two prior calls — both paths acknowledged, neither forced", async () => {
    const tool = await scopeTool();
    await tool.call({ expr: "(let ((zed 5)) zed)" });
    await tool.call({ expr: "(let ((zed 6)) zed)" });
    const call3 = await tool.call({ expr: "zed" });
    expect(call3.isError).toBe(true);
    const text = texts(call3)[0]!;
    expect(text.split("\n")[0]).toBe("Error: Unbound variable `zed'");
    expect(text).toContain("is a local binding you've used before");
    expect(text).toContain("Either bind it in the same statement that uses it, or (define zed …)");
  });

  it("never defined anywhere — NO scope-confusion enrichment, the bare wall stands", async () => {
    const tool = await scopeTool();
    const result = await tool.call({ expr: "totally-unbound-thing-xyz" });
    expect(result.isError).toBe(true);
    expect(texts(result)).toEqual(["Error: Unbound variable `totally-unbound-thing-xyz'"]);
  });

  it("regression pin — a garbled REAL tool name still gets the three-tier tool door, never scope-confusion", async () => {
    const tool = await scopeTool();
    // "ad" is a single-char-typo away from the bound bare tool name "add" — tier-3's tight
    // promotion fires.
    const result = await tool.call({ expr: "(ad :a 1 :b 2)" });
    expect(result.isError).toBe(true);
    const text = texts(result)[0]!;
    expect(text.split("\n")[0]).toBe("Error: Unbound variable `ad'");
    expect(text).toContain("the symbol you want is `toy/add`");
    expect(text).not.toContain("local scope");
    expect(text).not.toContain("this program");
  });

  it("telemetry: one envelope/scope-confusion line per firing, verbose on first occurrence then terse", async () => {
    const lines: string[] = [];
    const session = new DoorSession((l) => lines.push(l));
    const tool = await scopeTool(session);

    await tool.call({ expr: "(let ((zed 5)) zed)" });
    const c2 = await tool.call({ expr: "zed" }); // 1st scope-confusion firing this session → verbose
    await tool.call({ expr: "(let ((dub 1)) dub)" });
    const c4 = await tool.call({ expr: "dub" }); // 2nd firing, same SHAPE (cross-scope) → terse

    const scopeLines = lines.filter((l) => (JSON.parse(l) as { door: string }).door === "envelope/scope-confusion");
    expect(scopeLines).toHaveLength(2);
    expect(JSON.parse(scopeLines[0]!)).toEqual({
      door: "envelope/scope-confusion",
      seq: expect.any(Number),
      tool: "zed",
    });
    expect(JSON.parse(scopeLines[1]!)).toEqual({
      door: "envelope/scope-confusion",
      seq: expect.any(Number),
      tool: "dub",
    });

    const text2 = texts(c2)[0]!;
    const text4 = texts(c4)[0]!;
    // Verbose (first occurrence): the full cross-scope teaching.
    expect(text2).toContain("was defined inside a local scope (a let/lambda body) 1 message ago");
    // Terse (repeat occurrence, same SHAPE — cross-scope): the shorter one-liner — never the verbose fact text.
    expect(text4).toContain("was only ever locally bound (1 message ago)");
    expect(text4).not.toContain("was defined inside a local scope");
  });
});
