/**
 * Host-facing paint-mode unions next to the MST models.
 */

export type ComposerPaintMode = "normal" | "secret" | "isolated" | "waiting";
export type CompletionPaintState = "live" | "successful" | "failed";
export type WorkCellPaintState = "live" | "ok" | "fail" | "ask" | "judging";
export type WorkReceiptKind =
  "none" | "text" | "markdown" | "diff" | "stream" | "syntax" | "number" | "boolean" | "parts";
export type ComposerErrorLevel = "warning" | "error";
