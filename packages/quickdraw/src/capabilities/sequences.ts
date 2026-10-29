/**
 * Terminal query sequences (feature detection).
 * BEL-terminated OSC where common; ST also accepted by modern terms.
 */

/** OSC 11 — background color query */
export const OSC11_QUERY = "\u001B]11;?\u0007";

/** Mode 2031: subscribe to terminal color-scheme changes (CSI ? 997 ; Ps n). */
export const THEME_REPORT_ENABLE = "\u001B[?2031h";
export const THEME_REPORT_DISABLE = "\u001B[?2031l";

/** OSC 10 — foreground color query */
export const OSC10_QUERY = "\u001B]10;?\u0007";

/**
 * DECRQM — request Mode 2026 (synchronized output) state.
 * Reply: CSI ? 2026 ; Ps $ y  (Ps 1/3 set, 2/4 reset)
 */
export const DECRQM_2026 = "\u001B[?2026$p";

/** Primary Device Attributes — often ends a probe batch */
export const DA1_QUERY = "\u001B[c";

/** XTVERSION — terminal identity (many support) */
export const XTVERSION_QUERY = "\u001B[>0q";

/** Concatenated best-effort probe batch (OSC11 + DECRQM 2026 + DA1 last). */
export const PROBE_BATCH = OSC11_QUERY + DECRQM_2026 + DA1_QUERY;

/**
 * OSC 52 — clipboard write.
 *
 * Pure byte builder; caller writes to the TTY. Unsupported terminals ignore
 * the sequence (graceful degradation).
 *
 * Pc: `c` = CLIPBOARD, `p` = PRIMARY, `cp` = both. That is the XTerm map;
 * renaming the tokens to clipboard/primary breaks the sequence.
 */
export function osc52Set(text: string, pc: "c" | "p" | "cp" = "cp"): string {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return `\u001B]52;${pc};${b64}\u0007`;
}
