/**
 * Terminal feature snapshot — request/detect, never assume.
 */

/**
 * Color emission depth the paint path should use.
 * `mono` (NO_COLOR) strips color SGR entirely at the resolver — role solving
 * still runs (tier/prominence math, bold H-K compensation) but no fg/bg color
 * escape is emitted; bold/italic/strike/underline attributes still emit.
 */
import type { Rgb } from "../lexicon/index.js";

export type ColorDepth = "truecolor" | "ansi256" | "ansi16" | "mono";

/**
 * Detected (or guessed) terminal capabilities.
 * Unknown fields stay undefined — callers fall back honestly.
 */
export type TerminalCaps = {
  /** stdin+stdout are TTYs */
  tty: boolean;
  colorDepth: ColorDepth;
  /** OSC 11 background RGB if probed */
  groundRgb?: Rgb;
  /** Mode 2026 supported (DECRQM) when probed */
  sync2026?: boolean;
};
