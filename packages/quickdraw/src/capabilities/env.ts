/**
 * Env-based color depth heuristics when probes are unavailable.
 * Conservative defaults — prefer under-claiming over broken truecolor.
 */

import type { ColorDepth } from "./types.js";

export type EnvLike = {
  COLORTERM?: string | undefined;
  TERM?: string | undefined;
  TERM_PROGRAM?: string | undefined;
  WT_SESSION?: string | undefined; // Windows Terminal
  /** https://no-color.org — presence (any value, including "") wins over everything else. */
  NO_COLOR?: string | undefined;
  [key: string]: string | undefined;
};

/**
 * Guess ColorDepth from environment.
 * - NO_COLOR set (any value) → mono, before any other signal (no-color.org)
 * - COLORTERM=truecolor|24bit → truecolor
 * - TERM=*256color* → ansi256
 * - else ansi16
 */
export function guessColorDepth(env: EnvLike = process.env): ColorDepth {
  if (env.NO_COLOR !== undefined) return "mono";

  const ct = (env.COLORTERM ?? "").toLowerCase();
  if (ct === "truecolor" || ct === "24bit") return "truecolor";

  const term = env.TERM ?? "";
  if (/256color|truecolor|direct/i.test(term)) {
    // xterm-direct / *-truecolor often still set TERM with 256color or truecolor
    if (/truecolor|direct/i.test(term)) return "truecolor";
    return "ansi256";
  }

  // Well-known truecolor hosts even with dumb TERM.
  // Terminal.app (`Apple_Terminal`) is not truecolor — do not add it here.
  if (env.TERM_PROGRAM === "iTerm.app") return "truecolor";
  if (env.WT_SESSION) return "truecolor";

  if (/^xterm|^screen|^tmux|^rxvt|^vt100/i.test(term)) return "ansi16";

  return "ansi16";
}
