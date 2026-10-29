/**
 * Span ledger — make the conservation law measurable.
 *
 * THE LAW: every character of the model's output lands in exactly one
 * bucket — painted-as-text, part-of-a-tool-call-span, or
 * explicitly-dropped. Disjoint. Union equals input. No character counted
 * twice, none lost.
 *
 * These assertions were authored RED against the pre-transducer code and
 * went green when the one-fate rewrite landed. They are the law's
 * measurement, not examples: do not weaken, skip, or catch — a new red
 * here means a conservation regression, not a flaky test.
 */
import dedent from "dedent";
import { describe, expect, it, beforeEach } from "vitest";

import { ensureBuiltins } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";
import type { ToolDef } from "../types.js";
import { buildLedger } from "./ledger.js";
import { runStream } from "./stream-harness.js";

const writeFile: ToolDef = {
  name: "write_file",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
};

describe("span conservation ledger", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  it("[plain-prose] pure prose, no markup at all — fully painted, no spans", async () => {
    const raw = "Hello there.\nHow can I help you build this today?\n";
    const events = await runStream([raw], { dialect: "longcat" });
    const ledger = buildLedger(events, raw);
    expect(ledger.callSpans).toEqual([]);
    expect(ledger.droppedSpans).toEqual([]);
    expect(ledger.gaps).toEqual([]);
    expect(ledger.overlaps).toEqual([]);
  });

  it("[longcat-well-formed] a single closed LongCat call — one call span, nothing painted", async () => {
    const raw = dedent`
      <longcat_tool_call>
      get_weather
      <longcat_arg_key>city</longcat_arg_key>
      <longcat_arg_value>Paris</longcat_arg_value>
      </longcat_tool_call>
    `;
    const events = await runStream([raw], { dialect: "longcat" });
    const ledger = buildLedger(events, raw);
    expect(ledger.callSpans).toHaveLength(1);
    expect(ledger.callSpans[0]).toEqual({ start: 0, end: raw.length });
    expect(ledger.droppedSpans).toEqual([]);
    expect(ledger.gaps).toEqual([]);
    expect(ledger.overlaps).toEqual([]);
  });

  it("[qwen-well-formed] a single closed Qwen XML call — one call span, nothing painted", async () => {
    const raw = dedent`
      <tool_call>
      <function=write_file>
      <parameter=path>
      x.py
      </parameter>
      <parameter=content>
      print(1)
      </parameter>
      </function>
      </tool_call>
    `;
    const events = await runStream([raw], { dialect: "qwen_xml" });
    const ledger = buildLedger(events, raw);
    expect(ledger.callSpans).toHaveLength(1);
    expect(ledger.callSpans[0]).toEqual({ start: 0, end: raw.length });
    expect(ledger.droppedSpans).toEqual([]);
    expect(ledger.gaps).toEqual([]);
    expect(ledger.overlaps).toEqual([]);
  });

  it("[longcat-prose-then-call] prose before and after a well-formed call — both buckets, no overlap", async () => {
    const before = "Sure, let me check the weather.\n";
    const call = dedent`
      <longcat_tool_call>
      get_weather
      <longcat_arg_key>city</longcat_arg_key>
      <longcat_arg_value>Paris</longcat_arg_value>
      </longcat_tool_call>
    `;
    const after = "\nLet me know if you need anything else.";
    const raw = before + call + after;
    const events = await runStream([raw], { dialect: "longcat" });
    const ledger = buildLedger(events, raw);
    expect(ledger.callSpans).toHaveLength(1);
    expect(ledger.gaps).toEqual([]);
    expect(ledger.overlaps).toEqual([]);
  });

  it("[arg-value-close-collision] an unclosed argument value swallows the rest of the block — span still whole, one call, never two", async () => {
    // Same repro as required-args.unit.test.ts: "path"'s
    // <longcat_arg_value> is never closed, so it fail-closed swallows the
    // rest of the block — including the "content" key/value pair — into
    // path's own value, and the required-args gate flags the call partial
    // (never executable). The outer block still closes cleanly, so the
    // whole raw span is claimed by exactly one tool_call_end.
    // Character-conservation holds; argument-layer fidelity is a finer,
    // per-argument-span invariant this ledger deliberately does not
    // measure.
    const raw = dedent`
      <longcat_tool_call>
      write_file
      <longcat_arg_key>path</longcat_arg_key>
      <longcat_arg_value>a.ts
      <longcat_arg_key>content</longcat_arg_key>
      <longcat_arg_value>real content</longcat_arg_value>
      </longcat_tool_call>
    `;
    const events = await runStream([raw], {
      dialect: "longcat",
      tools: [writeFile],
    });
    const ledger = buildLedger(events, raw);
    expect(ledger.callSpans).toHaveLength(1);
    expect(ledger.callSpans[0]).toEqual({ start: 0, end: raw.length });
    expect(ledger.droppedSpans).toEqual([]);
    expect(ledger.gaps).toEqual([]);
    expect(ledger.overlaps).toEqual([]);
  });

  it("truncated at EOS: a name-certain call that never closes is dropped, not painted", async () => {
    // The live step names the call ("write_file") and starts it; EOS never
    // sees a close marker. Name-certainty decides fate: the span is
    // machinery, so close() drops it (reason: truncated) and it must NOT
    // also be painted as text — dropped AND painted was the original
    // double-accounting defect this case was authored (red) to expose.
    const raw = dedent`
      Sure, here goes:
      <longcat_tool_call>
      write_file
      <longcat_arg_key>path</longcat_arg_key>
      <longcat_arg_value>a.ts
    `;
    const events = await runStream([raw], { dialect: "longcat" });
    const ledger = buildLedger(events, raw);
    expect(ledger.droppedSpans.length).toBeGreaterThan(0);
    expect(ledger.gaps).toEqual([]);
    expect(ledger.overlaps).toEqual([]);
  });

  it("[false-positive-marker] text that looks like an open marker but never completes — control case, fully painted", async () => {
    // "<longcat_t" is a proper prefix of "<longcat_tool_call>" — held
    // speculatively across the chunk boundary — but the second chunk
    // resolves it to ordinary prose, never a real open marker. Split
    // across two chunks specifically to exercise the cross-chunk hold
    // offset bookkeeping (holdAbsStart), not just single-shot text.
    const chunk1 = "Note the syntax difference: <longcat_t";
    const chunk2 = "able>markdown table</longcat_table> is not a tool call.";
    const raw = chunk1 + chunk2;
    const events = await runStream([chunk1, chunk2], { dialect: "longcat" });
    const ledger = buildLedger(events, raw);
    expect(ledger.callSpans).toEqual([]);
    expect(ledger.droppedSpans).toEqual([]);
    expect(ledger.gaps).toEqual([]);
    expect(ledger.overlaps).toEqual([]);
  });
});
