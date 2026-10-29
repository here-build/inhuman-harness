// elision-note — runner.ts's aggregation of arrival-serializer's `ElisionRecord`s into the
// consolidated `── environment notes ──` trailing block (E3), contributing exactly ONE line
// regardless of how many collections elided this call. The middle-elision feature itself is
// OPT-IN via `calibration.observationElision` — a runner that never sets it (every OTHER test in
// this package) keeps today's tail-truncation, no note, ever. This file is the one place that
// turns it on and exercises the note.
//
// E2/S5 (benchmark-defect-register.md §E + ADDENDUM) — the OLD per-array enumeration was 100%
// redundant (the serializer already emits an inline `#| N similar items were not rendered… |#`
// marker at the exact elision site — strictly better placement) and, worse, READ AS DATA LOSS:
// measured 1805 lines / 171 blocks / 67 files of pure bookkeeping, one file carrying 125,571
// bytes of notes (33% of the file); both models in the corpus concluded the VALUE itself was cut
// and permanently abandoned the REPL for python. FIX: delete the per-collection enumeration,
// emit ONE line that says the value is INTACT.

import { LexicalScope, RunContext, disposeRunContext, execState } from "@here.build/arrival";
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

/** A runner with middle-elision turned ON — the manifold's own defaults (serializer-elision
 *  plan §7): a small per-array display cap, a generous topLevelArrayLimit so a
 *  moderately-sized array isn't ALSO caught by the plain maxItems, and a 5/5 head/tail
 *  window. */
function makeElidingRunner(): ReturnType<typeof createDoorsRunner> {
  return createDoorsRunner({
    toolNaming: { toolName: "eval", argName: "expr" },
    strategies: KWARGS_STRATEGIES,
    attachmentSink: noopSink,
    calibration: {
      observationElision: {
        maxItems: 20,
        topLevelArrayLimit: 100,
        secondLevelArrayLimit: 100,
        elideHead: 5,
        elideTail: 5,
      },
    },
  });
}

function makePlainRunner(): ReturnType<typeof createDoorsRunner> {
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

const NOTES_HEADER = "── environment notes ──";
const isNotesBlock = (b: { type: string; text?: string }): boolean =>
  b.type === "text" && (b as { text: string }).text.includes(NOTES_HEADER);

describe("runner.ts — elision contributes ONE line to the environment-notes block (E2/S5)", () => {
  it("a manifold-style 100-item array observation produces ONE environment-notes block, with a line saying the value is INTACT", async () => {
    const runner = makeElidingRunner();
    const scope = freshScope("elision-note-single");
    const result = await runner.run({ expr: "(iota 100)", capabilities, config, runCtx, scope, tools: noTools });

    expect(result.isError).not.toBe(true);
    const noteBlocks = result.content.filter(isNotesBlock);
    expect(noteBlocks).toHaveLength(1);
    const text = (noteBlocks[0] as { text: string }).text;
    expect(text).toContain("intact");
    // never the old per-collection enumeration or "not rendered" tautology bookkeeping
    expect(text).not.toContain("array of 100 items");
  });

  it("two forms that each elide STILL contribute only ONE line to the notes block (never per-collection)", async () => {
    const runner = makeElidingRunner();
    const scope = freshScope("elision-note-two-forms");
    const result = await runner.run({
      expr: "(iota 100)\n(iota 200)",
      capabilities,
      config,
      runCtx,
      scope,
      tools: noTools,
    });

    expect(result.isError).not.toBe(true);
    const noteBlocks = result.content.filter(isNotesBlock);
    expect(noteBlocks).toHaveLength(1);
    const text = (noteBlocks[0] as { text: string }).text;
    const elisionLines = text
      .split("\n")
      .filter((l) => l.toLowerCase().includes("sampled") || l.toLowerCase().includes("intact"));
    expect(elisionLines).toHaveLength(1);
  });

  it("no elision configured → no environment-notes block, ever", async () => {
    const runner = makePlainRunner();
    const scope = freshScope("elision-note-off");
    const result = await runner.run({ expr: "(iota 100)", capabilities, config, runCtx, scope, tools: noTools });

    expect(result.isError).not.toBe(true);
    expect(result.content.filter(isNotesBlock)).toHaveLength(0);
  });

  it("a small array that fits under the limits elides nothing → no environment-notes block", async () => {
    const runner = makeElidingRunner();
    const scope = freshScope("elision-note-small");
    const result = await runner.run({ expr: "(iota 5)", capabilities, config, runCtx, scope, tools: noTools });

    expect(result.isError).not.toBe(true);
    expect(result.content.filter(isNotesBlock)).toHaveLength(0);
  });
});
