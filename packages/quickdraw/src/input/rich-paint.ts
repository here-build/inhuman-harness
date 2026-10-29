import type { RichRun } from "./rich-draft.js";

export type RichPaintSpan = {
  readonly start: number;
  readonly end: number;
  readonly id: string;
};

export type RichPaint = {
  readonly text: string;
  readonly spans: readonly RichPaintSpan[];
};

/** Project runs to clipboard text plus UTF-16 spans over each non-empty chip label. */
export function richPaint(runs: readonly RichRun[]): RichPaint {
  let text = "";
  const spans: RichPaintSpan[] = [];
  for (const run of runs) {
    if (typeof run === "string") {
      text += run;
      continue;
    }
    if (run.clipboard.length === 0) continue;
    const start = text.length;
    text += run.clipboard;
    spans.push({ start, end: text.length, id: run.id });
  }
  return { text, spans };
}
