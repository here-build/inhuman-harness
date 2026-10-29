/**
 * Host-facing paint bags. Structural types live in Quickdraw; MountLocal
 * and paint-mode unions stay here next to the MST models.
 */

/** TUI-only per-mount display. Keyed by the reader PaintNode pointer. */
export interface MountLocal {
  collapsed: boolean;
  hitKey: string;
}

export type ComposerPaintMode = "normal" | "secret" | "isolated" | "waiting";
export type CompletionPaintState = "live" | "successful" | "failed";
export type WorkCellPaintState = "live" | "ok" | "fail" | "ask" | "judging";
export type WorkReceiptKind =
  "none" | "text" | "markdown" | "diff" | "stream" | "syntax" | "number" | "boolean" | "parts";
export type ComposerErrorLevel = "warning" | "error";
