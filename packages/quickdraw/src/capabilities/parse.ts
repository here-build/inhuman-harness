/**
 * Pure parsers for terminal capability replies — no I/O.
 */

import type { Rgb } from "../lexicon/index.js";

/**
 * Parse OSC 11 (or OSC 10) color payload.
 * Accepts `rgb:rrrr/gggg/bbbb` (XParseColor) and `#rrggbb` / `rrggbb`.
 */
export function parseOscColorPayload(payload: string): Rgb | null {
  const s = payload.trim();

  const xparse = /^rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})$/.exec(s);
  if (xparse) {
    const scale = (hex: string) => {
      const n = Number.parseInt(hex, 16);
      const max = (1 << (hex.length * 4)) - 1;
      return Math.round((n / max) * 255);
    };
    return {
      r: scale(xparse[1]!),
      g: scale(xparse[2]!),
      b: scale(xparse[3]!),
    };
  }

  const hex = /^#?([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1]!;
    return {
      r: Number.parseInt(h.slice(0, 2), 16),
      g: Number.parseInt(h.slice(2, 4), 16),
      b: Number.parseInt(h.slice(4, 6), 16),
    };
  }

  return null;
}

/** Alias — OSC 11 is the common ground probe. */
export const parseOsc11Payload = parseOscColorPayload;

/**
 * Extract OSC 11 payload from a reply buffer (BEL or ST terminated).
 * H3: requires a terminator — an unterminated partial chunk (e.g. the first
 * stdin read delivering only `\x1b]11;rgb:1`) must return null so the probe
 * keeps waiting for the rest, instead of finishing early with a truncated
 * payload and `groundRgb: undefined`.
 */
export function extractOsc11FromBuffer(buf: string): string | null {
  const m = /\u001B\]11;([^\u0007\u001B]+)(?:\u0007|\u001B\\)/.exec(buf);
  return m?.[1] ?? null;
}

/**
 * Parse DECRQM reply for mode 2026.
 * CSI ? 2026 ; Ps $ y — Ps 1 or 3 ⇒ set/supported; 2 or 4 ⇒ reset.
 * Returns true if mode is reported as settable/set, false if reset, null if absent.
 */
export function parseDecrqm2026(buf: string): boolean | null {
  const m = /\u001B\[\?2026;(\d+)\$y/.exec(buf);
  if (!m) return null;
  const ps = Number.parseInt(m[1]!, 10);
  // 0 unknown, 1 set, 2 reset, 3 permanently set, 4 permanently reset
  if (ps === 1 || ps === 3) return true;
  if (ps === 2 || ps === 4) return false;
  return null;
}

/** True if DA1 (primary DA) reply present — probe batch completed. */
export function hasDa1Reply(buf: string): boolean {
  return /\u001B\[\?[\d;]*c/.test(buf);
}

/**
 * Remove known capability probe replies from a stdin accumulation buffer.
 * Residual bytes are user keystrokes (or unrelated sequences) typed during
 * the probe window — re-inject into the app's input path.
 *
 * Only complete, terminated replies are stripped:
 * - OSC 11 ground (BEL or ST)
 * - DECRQM mode 2026 (`CSI ? 2026 ; Ps $ y`)
 * - DA1 (`CSI ? … c`)
 *
 * Partial fragments that never completed (timeout mid-reply) are left as-is.
 */
export function stripProbeReplies(buf: string): string {
  return buf
    .replaceAll(/\u001B\]11;[^\u0007\u001B]+(?:\u0007|\u001B\\)/g, "")
    .replaceAll(/\u001B\[\?2026;\d+\$y/g, "")
    .replaceAll(/\u001B\[\?[\d;]*c/g, "");
}
