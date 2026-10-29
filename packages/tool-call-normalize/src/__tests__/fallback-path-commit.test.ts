/**
 * R1: one-char-one-fate is now STRUCTURAL (via `commit()` in
 * normalize-stream.ts), not merely a convention honored by the step()-driven
 * path. These tests specifically drive the OTHER disposal path —
 * `firstClosedToolEnd` — which is reached whenever `resolveStepDialect`
 * returns null: an auto-dialect stream (no forced `opts.dialect`), or a
 * forced dialect whose step() returns `{consumed: 0, holding: false}`.
 *
 * Before R1, this fallback path wrote `recoveryText += span` UNCONDITIONALLY,
 * before the span's fate (call vs text vs dropped) was known — so a
 * call-fate span's characters reached both a live tool_call_end AND the EOS
 * assemble's recoveryText, which the assemble's own extract() could then rediscover
 * as a SECOND call. The isCommitted() name+args dedup at emitTools happened
 * to mask this in every case these tests can construct (see the note on the
 * highest-value test below), which is exactly why the bug was structural
 * rather than empirically visible — these tests assert the OBSERVABLE
 * absence of a second discovery, which the fix now guarantees by
 * construction (call-fate spans never reach recoveryText at all, so the
 * assemble literally cannot see their characters, dedup or no dedup).
 */
import dedent from "dedent";
import { describe, expect, it, beforeEach } from "vitest";

import { ensureBuiltins } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";
import { assembleEvents } from "../ir.js";
import type { ToolDef } from "../types.js";
import { buildLedger } from "./ledger.js";
import { runStream, expectSequence, start, end, finish } from "./stream-harness.js";

const getWeather: ToolDef = {
  name: "get_weather",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

const readFile: ToolDef = {
  name: "read_file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

describe("fallback path (firstClosedToolEnd) commits each span to exactly one fate", () => {
  beforeEach(() => {
    resetRegistryForTests();
    ensureBuiltins();
  });

  it("[auto-single-call] a well-formed call recovered via the NON-step fallback path is emitted exactly once, never re-derived at EOS", async () => {
    const raw = dedent`
      Sure, let me check.
      <longcat_tool_call>
      get_weather
      <longcat_arg_key>city</longcat_arg_key>
      <longcat_arg_value>Paris</longcat_arg_value>
      </longcat_tool_call>
      Done.
    `;
    // No `dialect` forced: resolveStepDialect returns null, useStep is
    // false for the entire session — every "inside" span this stream ever
    // captures resolves via firstClosedToolEnd, never dialect.step().
    const events = await runStream([raw], { tools: [getWeather] });

    expectSequence(events, [start("get_weather"), end("get_weather", { city: "Paris" }), finish("tool_calls")]);

    // The actual C1 assertion: exactly one start/end pair for this call —
    // not two, which is what the unconditional `recoveryText += span`
    // (pre-fix) risked whenever the EOS assemble's own extract() rediscovered
    // the same markup from recoveryText.
    const starts = events.filter((e) => e.type === "tool_call_start");
    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);

    const assembled = assembleEvents(events);
    expect(assembled.tool_calls.map((t) => t.function.name)).toEqual(["get_weather"]);

    // Conservation: the call's raw span is claimed exactly once (call
    // fate), the surrounding prose is painted, nothing overlaps.
    const ledger = buildLedger(events, raw);
    expect(ledger.callSpans).toHaveLength(1);
    expect(ledger.droppedSpans).toEqual([]);
    expect(ledger.gaps).toEqual([]);
    expect(ledger.overlaps).toEqual([]);
  });

  it("[auto-two-calls] two distinct well-formed calls, separated by prose, both via the fallback path — no cross-contamination, no duplicates", async () => {
    const raw = dedent`
      First, the weather:
      <longcat_tool_call>
      get_weather
      <longcat_arg_key>city</longcat_arg_key>
      <longcat_arg_value>Paris</longcat_arg_value>
      </longcat_tool_call>
      Now the file:
      <longcat_tool_call>
      read_file
      <longcat_arg_key>path</longcat_arg_key>
      <longcat_arg_value>a.ts</longcat_arg_value>
      </longcat_tool_call>
      All done.
    `;
    const events = await runStream([raw], { tools: [getWeather, readFile] });

    const starts = events.filter((e) => e.type === "tool_call_start");
    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);

    const assembled = assembleEvents(events);
    expect(assembled.tool_calls.map((t) => t.function.name).sort()).toEqual(["get_weather", "read_file"]);

    // If the pre-fix bug were still present, recoveryText would carry BOTH
    // call spans verbatim, and the EOS assemble's batch-mode extract() would
    // rediscover both — this asserts the assemble does not even attempt a
    // rediscovery (meta carries no drop/ambiguous residue from a phantom
    // second pass over already-committed markup).
    const metaEvent = events.find((e) => e.type === "meta");
    expect(metaEvent?.type).toBe("meta");
    if (metaEvent?.type === "meta") {
      expect(metaEvent.meta.dropped).toEqual([]);
    }

    const ledger = buildLedger(events, raw);
    expect(ledger.callSpans).toHaveLength(2);
    expect(ledger.droppedSpans).toEqual([]);
    expect(ledger.gaps).toEqual([]);
    expect(ledger.overlaps).toEqual([]);
  });

  it("[auto-single-call-chunked] the same well-formed call split into many small chunks — holdAbsStart bookkeeping through the fallback path stays exact", async () => {
    const raw = dedent`
      Sure, let me check.
      <longcat_tool_call>
      get_weather
      <longcat_arg_key>city</longcat_arg_key>
      <longcat_arg_value>Paris</longcat_arg_value>
      </longcat_tool_call>
      Done.
    `;
    const chunks = raw.match(/.{1,3}/gs) ?? [raw];
    const events = await runStream(chunks, { tools: [getWeather] });

    const starts = events.filter((e) => e.type === "tool_call_start");
    const ends = events.filter((e) => e.type === "tool_call_end");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);

    const assembled = assembleEvents(events);
    expect(assembled.tool_calls).toHaveLength(1);

    const ledger = buildLedger(events, raw);
    expect(ledger.callSpans).toHaveLength(1);
    expect(ledger.gaps).toEqual([]);
    expect(ledger.overlaps).toEqual([]);
  });

  /**
   * The highest-value test this task asks for would construct a case where
   * isCommitted()'s name+argsEqual dedup MISSES — i.e. the live-committed
   * args differ from what the EOS assemble would independently re-derive for
   * the identical span. After genuine effort, this could not be
   * constructed, and here is why:
   *
   * `probeSpan(span)` (the live path) and the EOS assemble's
   * `normalizeMessageImpl({content: recoveryText, ...}, assembleOpts)` both
   * receive `opts.tools`/`mode` unchanged, and — critically — prior to this
   * fix, recoveryText's call-span contribution was `span` VERBATIM (the
   * exact same substring handed to `probeSpan`). `normalizeMessageImpl` is
   * a pure function of (content, tool_calls, opts): identical text +
   * identical schema + identical mode necessarily yields identical
   * extracted arguments. The only way recoveryText differs from a bare
   * `span` is
   * *surrounding* prose/other calls — and the stream machinery already
   * bounds each `hold` to exactly one call's own markup before resolving it
   * (each "inside" transition starts `hold` fresh at that call's open
   * marker), so neighboring content never leaks into THIS call's own
   * extracted boundaries. nativePolicy differs between the two calls
   * ("merge" forced for probeSpan vs the caller's own policy for the assemble)
   * but only changes behavior when native tool_calls are non-empty
   * (normalize-message.ts:610) — irrelevant for a purely content-recovered
   * call. No other opt differs. So for this extractor, the dedup's
   * "safety net" was structurally never going to miss on well-formed input;
   * the phantom-double-call risk this task fixes was that recoveryText
   * carried the call at all, not that the dedup itself was flaky. The fix
   * makes the double-commit unexpressible regardless: call-fate spans are
   * now excluded from recoveryText by construction, so the assemble cannot
   * even attempt a rediscovery — a stronger guarantee than "the dedup
   * happens to agree."
   */
  it.todo("no constructible args-mismatch case for isCommitted() to miss — see comment above");
});
