/**
 * Cell-grid lengths. px is banned — never rewrite to cells.
 */

export type Length = number | "auto" | { fr: number } | { pct: number } | { ch: number } | { lh: number };

/** Resolve length against definite containing-block size (cells). */
export function resolveLength(len: Length | undefined, cb: number, axis: "main" | "cross" = "main"): number | "auto" {
  if (len === undefined || len === "auto") return "auto";
  if (typeof len === "number") return Math.max(0, Math.floor(len));
  if ("fr" in len) return "auto"; // fr resolved in flex/grid free-space pass
  if ("pct" in len) return Math.max(0, Math.floor((cb * len.pct) / 100));
  if ("ch" in len) return Math.max(0, len.ch);
  if ("lh" in len) return Math.max(0, len.lh);
  void axis;
  return "auto";
}

export function isFr(len: Length | undefined): len is { fr: number } {
  return typeof len === "object" && len !== null && "fr" in len;
}
