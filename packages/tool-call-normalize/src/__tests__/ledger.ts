/**
 * C1: the span conservation ledger.
 *
 * THE LAW: every character of the model's raw output lands in exactly one
 * bucket — painted-as-text, part-of-a-tool-call-span, or explicitly-dropped.
 * Disjoint. Union equals input. No character counted twice, none lost.
 *
 * This helper does not enforce the law — it *measures* it, against whatever
 * `span` data the current stream implementation actually attaches to
 * tool_call_start / tool_call_end / tool_call_drop (types.ts `RawSpan`,
 * populated best-effort in normalize-stream.ts). Where an event carries no
 * span (e.g. a tool_call recovered only at the EOS assemble, never routed
 * through the live probe path), it simply contributes no claim — the
 * ledger cannot invent data the implementation doesn't have. That absence
 * is itself a finding, not a bug in the ledger.
 *
 * IMPORTANT: `painted` is the raw concatenation of every `text_delta.text`,
 * in emission order, with NO trimEnd() applied. assembleEvents() (ir.ts)
 * applies content.trimEnd() when assembling the batch-shaped `content` —
 * that trim is a display-seam concern, not a conservation concern, and
 * would show up here as a false trailing gap if we reused it. Measure
 * pre-trim, straight off the event stream.
 */
import type { NormalizeEvent, RawSpan } from "../types.js";

export type TaggedSpan = RawSpan & { kind: "call" | "dropped" };

export type SpanMismatch =
  | {
      kind: "length";
      /** "gap": painted is shorter than the raw complement of claimed spans
       *  (some raw text vanished into no bucket at all).
       *  "overlap": painted is longer than the complement (some raw text is
       *  claimed by both a span AND painted). */
      direction: "gap" | "overlap";
      expectedLength: number;
      actualLength: number;
    }
  | {
      kind: "content";
      /** Same total length as expected, but the characters differ —
       *  order/identity mismatch rather than a pure count mismatch. */
      expected: string;
      actual: string;
    };

export type Ledger = {
  /** Raw concatenation of every text_delta.text, in order, untrimmed. */
  painted: string;
  /** Spans from tool_call_end events that carry one. */
  callSpans: RawSpan[];
  /** Spans from tool_call_drop events that carry one. */
  droppedSpans: RawSpan[];
  /** Painted-vs-(rawInput minus claimed spans) mismatches. Empty = no gap. */
  gaps: SpanMismatch[];
  /** Pairwise overlaps directly among callSpans/droppedSpans themselves. */
  overlaps: Array<{ a: TaggedSpan; b: TaggedSpan }>;
};

function clip(span: RawSpan, len: number): RawSpan | null {
  const start = Math.max(0, Math.min(span.start, len));
  const end = Math.max(0, Math.min(span.end, len));
  if (end <= start) return null;
  return { start, end };
}

/** Complement of a sorted, non-overlapping interval list, over [0, len). */
function complement(merged: RawSpan[], len: number): RawSpan[] {
  const out: RawSpan[] = [];
  let pos = 0;
  for (const s of merged) {
    if (s.start > pos) out.push({ start: pos, end: s.start });
    pos = Math.max(pos, s.end);
  }
  if (pos < len) out.push({ start: pos, end: len });
  return out;
}

/** Sort + merge overlapping/adjacent-or-not intervals (union). */
function mergeSpans(spans: RawSpan[]): RawSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: RawSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

export function buildLedger(events: NormalizeEvent[], rawInput: string): Ledger {
  const painted = events
    .filter((e): e is Extract<NormalizeEvent, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.text)
    .join("");

  const callSpans: RawSpan[] = [];
  const droppedSpans: RawSpan[] = [];
  for (const e of events) {
    if (e.type === "tool_call_end" && e.span) callSpans.push(e.span);
    if (e.type === "tool_call_drop" && e.span) droppedSpans.push(e.span);
  }

  const tagged: TaggedSpan[] = [
    ...callSpans.map((s) => ({ ...s, kind: "call" as const })),
    ...droppedSpans.map((s) => ({ ...s, kind: "dropped" as const })),
  ].sort((a, b) => a.start - b.start || a.end - b.end);

  const overlaps: Array<{ a: TaggedSpan; b: TaggedSpan }> = [];
  for (let i = 1; i < tagged.length; i++) {
    // Compare against every earlier span whose end extends past this
    // span's start (not just the immediate predecessor — spans need not
    // arrive pre-sorted by extent).
    for (let j = 0; j < i; j++) {
      if (tagged[j]!.end > tagged[i]!.start) {
        overlaps.push({ a: tagged[j]!, b: tagged[i]! });
      }
    }
  }

  const clipped = tagged.map((s) => clip(s, rawInput.length)).filter((s): s is RawSpan => s !== null);
  const merged = mergeSpans(clipped);
  const unclaimed = complement(merged, rawInput.length);
  const expectedPainted = unclaimed.map((iv) => rawInput.slice(iv.start, iv.end)).join("");

  const gaps: SpanMismatch[] = [];
  if (expectedPainted.length !== painted.length) {
    gaps.push({
      kind: "length",
      direction: painted.length > expectedPainted.length ? "overlap" : "gap",
      expectedLength: expectedPainted.length,
      actualLength: painted.length,
    });
  } else if (expectedPainted !== painted) {
    gaps.push({ kind: "content", expected: expectedPainted, actual: painted });
  }

  return { painted, callSpans, droppedSpans, gaps, overlaps };
}
