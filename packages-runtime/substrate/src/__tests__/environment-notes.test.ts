// environment-notes — E3 (benchmark-defect-register.md §E): every note-shaped producer the
// runner emits (introduced-binding announcement, elision note, futility/duplicate advisory,
// attachment note) converges into ONE trailing block, labelled `── environment notes ──`, wrapped
// in a `#| ... |#` reader block comment (parses to zero forms — pasted back, it's inert, matching
// the precedent the old `#|introduced ...|#` note set) so it is unmistakably not part of the
// answer and never data. Real content (value/error observations, type-hint diagnostics, real
// attachment blocks) stays untouched, in order, BEFORE the footer.
//
// RED test per the design doc: one call producing a define + an elision + a futility note yields
// EXACTLY ONE notes block, labelled, after the data.

import { LexicalScope, RunContext, disposeRunContext, execState } from "@here.build/arrival";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AttachmentSink } from "../attachment-sink.js";
import type { BoundTool } from "../bound-tool.js";
import { FutilityTracker } from "../futility.js";
import { createDoorsRunner } from "../runner.js";
import { KWARGS_STRATEGIES } from "../strategies.js";

const noopSink: AttachmentSink = {
  beginCall(): void {},
  drainBlocks: () => [],
  drainNote: () => undefined,
};

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

describe("runner.ts — consolidated environment-notes footer (E3)", () => {
  it("a define + an elision + a futility note yields EXACTLY ONE notes block, labelled, after the data", async () => {
    // Seed a pending futile-retry door — mirrors what bind.ts does at the real membrane (this
    // package has no real MCP tools to call). Three genuinely SEPARATE calls (beginCall between
    // each — C1b) so the trigger actually fires.
    const tracker = new FutilityTracker();
    tracker.beginCall();
    tracker.record("t/search", { q: "a" }, "no results");
    tracker.beginCall();
    tracker.record("t/search", { q: "b" }, "no results");
    tracker.beginCall();
    tracker.record("t/search", { q: "c" }, "no results");

    const runner = createDoorsRunner({
      toolNaming: { toolName: "eval", argName: "expr" },
      strategies: KWARGS_STRATEGIES,
      attachmentSink: noopSink,
      tracker,
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
    const scope = freshScope("environment-notes-consolidated");
    const result = await runner.run({
      expr: "(define x 1)\n(iota 100)",
      capabilities,
      config,
      runCtx,
      scope,
      tools: noTools,
    });

    const noteBlocks = result.content.filter((b) => b.type === "text" && b.text.includes(NOTES_HEADER));
    expect(noteBlocks).toHaveLength(1);

    // it is the LAST block — after every data block.
    expect(result.content.at(-1)).toBe(noteBlocks[0]);

    const text = (noteBlocks[0] as { text: string }).text;
    expect(text).toContain("x — also available in subsequent calls."); // introduced
    expect(text).toContain("intact"); // elision reword
    expect(text.toLowerCase()).toContain("t/search"); // futility note names the tool

    // the block-comment wrapper: parses to zero forms, inert if pasted back.
    const { parse } = await import("@here.build/arrival");
    const forms = await parse(text);
    expect(forms.length).toBe(0);
  });
});
