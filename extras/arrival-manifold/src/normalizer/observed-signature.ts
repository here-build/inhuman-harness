// normalizer/observed-signature — the OBSERVED half of the response-normalizer's
// auto-present ruling: once the
// membrane auto-presents a tool's raw text as a parsed value (server.ts's
// `unwrapToolResult`, extended past the grandfathered single-block JSON.parse to the
// full `detectParse` family), the model should SEE the shape it is about to receive, not
// just receive it silently. This module is the per-tool "first contact" latch plus the
// pure string transform that folds an observed shape into a tool's existing catalog
// signature line — server.ts owns the wiring (tracker construction, the invoke-seam
// callback, the soft-refresh/listChanged trigger); this module owns no MCP/scheme/
// catalog concerns of its own.
//
// "Declared wins; observed only fills the default/absent case" (§2.1.1) is implemented
// with NO separate declared/observed bookkeeping: `amendSignatureText` only ever touches
// a signature line that does not already carry a `-> ` suffix — a declared outputSchema
// (tool-signature.ts's `renderOutputShape`) is the ONLY thing that ever puts one there
// before this module runs, so the guard IS the "declared wins" rule, expressed
// structurally rather than via a second source of truth that could drift from the
// catalog's own rendering.
//
// One-shot, never re-amended: a tool's FIRST successfully-parsed response latches its
// annotation permanently (never re-derived from a later, differently-shaped response) —
// this is deliberately NOT the full monotonically-widening ShapeLadder (ladder.ts,
// observe-only, not yet wired into any live path); it is the narrow "first contact" fact
// the auto-present ruling asks for, nothing more.

/** One tool's observed-format latch: the detected format tag (`detectParse`'s
 *  `ParseOutcome.format` — "json" | "jsonl" | "csv" | "tsv" | "toon" | "python-literal" —
 *  or the grandfathered plain "json" from `unwrapToolResult`'s own JSON.parse branch,
 *  which never goes through `detectParse` at all) and the rendered catalog annotation. */
export interface ObservedSignature {
  format: string;
  annotation: string;
}

function kindOf(value: unknown): "object" | "array" | "scalar" {
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return "scalar";
}

/** A compact key sample for the catalog annotation. An array renders as records (the
 *  first element's keys, plus the row count actually seen this call — CSV/TOON/NDJSON/a
 *  JSON array always land here); a bare object renders its own keys; a scalar never
 *  reaches this function — {@link ObservedSignatureTracker.record} refuses to latch one
 *  (there is no shape worth teaching for `"3"` -> `3`). */
function keySampleOf(value: unknown): string {
  if (Array.isArray(value)) {
    const first = value[0];
    const keys =
      first !== null && typeof first === "object" && !Array.isArray(first)
        ? Object.keys(first as Record<string, unknown>)
        : [];
    const shape = keys.length > 0 ? `{${keys.join(", ")}}` : "value";
    return `records ${shape} (${value.length} row${value.length === 1 ? "" : "s"} seen)`;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  return `{${keys.join(", ")}}`;
}

/** `[observed] <format> <records {a,b,c} (N rows seen) | {a,b,c}>` — the exact suffix
 *  {@link amendSignatureText} splices into a tool's signature line. */
function renderAnnotation(format: string, value: unknown): string {
  return `[observed] ${format} ${keySampleOf(value)}`;
}

/** Splice `-> annotation` into a rendered `ToolSignature.signatureText`
 *  (`(head params...)[ -> shape][ - description]`, tool-signature.ts).
 *
 *  A5 — "declared wins" was BACKWARDS. The only way this function is ever CALLED for a
 *  tool is via the text-block auto-present path (server.ts's `toBoundServer`, wired to
 *  `unwrapToolResult`'s `onAutoPresent` hook), which is reachable ONLY when
 *  `structuredContent` did NOT arrive this call — `unwrapToolResult`'s rule 2
 *  (`structuredContent` present) short-circuits and returns BEFORE rule 3's auto-present
 *  logic ever runs. So an observation that reaches here is, by construction, evidence
 *  that a DECLARED prior never materialized structurally this call: the catalog's
 *  `-> {declared shape}` line is not ground truth, and suppressing the real observation
 *  would let the catalog keep actively lying. The declared shape is therefore demoted to
 *  a parenthetical note rather than winning outright:
 *  `-> [observed] <shape> (declared: <declared shape>)`.
 *
 *  IDEMPOTENCY (still required — `applyObservedAmendments`, server.ts, re-runs this on
 *  EVERY soft refresh for every tool with a latched observation, not just newly-changed
 *  ones): the guard is "does `signatureText` already contain THIS EXACT `annotation`
 *  substring" rather than "does it already contain ` -> `" — the tracker's one-shot latch
 *  means `annotation` never changes for a given tool once recorded, so once spliced in,
 *  the same annotation string reappearing on a later call is the no-op signal. Without
 *  this, a declared+amended line would keep re-wrapping its own `(declared: …)` note on
 *  every soft refresh (the old " -> " guard could rely on structural presence alone
 *  because it always left ` -> ` newly-added lines untouched forever; this fix can't). */
export function amendSignatureText(signatureText: string, annotation: string): string {
  if (signatureText.includes(annotation)) return signatureText;
  const closeParen = signatureText.indexOf(")");
  if (closeParen === -1) return signatureText;
  const rest = signatureText.slice(closeParen + 1);
  if (!rest.startsWith(" -> ")) {
    return `${signatureText.slice(0, closeParen + 1)} -> ${annotation}${rest}`;
  }
  const afterArrow = rest.slice(" -> ".length);
  const descriptionSepIndex = afterArrow.indexOf(" - ");
  const declaredShape = descriptionSepIndex === -1 ? afterArrow : afterArrow.slice(0, descriptionSepIndex);
  const tail = descriptionSepIndex === -1 ? "" : afterArrow.slice(descriptionSepIndex);
  return `${signatureText.slice(0, closeParen + 1)} -> ${annotation} (declared: ${declaredShape})${tail}`;
}

/** Per-tool, per-server-process latch: the FIRST successfully-parsed response (from
 *  either `unwrapToolResult`'s grandfathered JSON.parse or its `detectParse` extension)
 *  records an {@link ObservedSignature} for that tool, once, forever — and queues the
 *  tool name for the next soft refresh (server.ts drains it after each manifold-tool
 *  call completes, batching every amendment discovered within one program into at most
 *  one catalog rebuild + `tools/list_changed` notification). A scalar value (the
 *  grandfathered path's `"3"` -> `3`, `"true"` -> `true`) is deliberately never latched —
 *  there is no shape to teach, and latching it would burn the tool's one-shot slot on a
 *  non-answer. */
export class ObservedSignatureTracker {
  private readonly byTool = new Map<string, ObservedSignature>();
  private pendingNames: string[] = [];

  record(toolName: string, format: string, value: unknown): void {
    if (this.byTool.has(toolName)) return;
    if (kindOf(value) === "scalar") return;
    this.byTool.set(toolName, { format, annotation: renderAnnotation(format, value) });
    this.pendingNames.push(toolName);
  }

  get(toolName: string): ObservedSignature | undefined {
    return this.byTool.get(toolName);
  }

  /** Drains (and clears) the set of tool names newly latched since the last drain — the
   *  soft-refresh trigger's "did anything change since I last looked" read. */
  drainPending(): readonly string[] {
    if (this.pendingNames.length === 0) return [];
    const drained = this.pendingNames;
    this.pendingNames = [];
    return drained;
  }
}
