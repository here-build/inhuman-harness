/**
 * The parity law: every painted color states a role and a prominence.
 * Literal colors survive only inside named quarantines, and the brand makes
 * the naming mandatory — a bare Rgb cannot cross an API that asks for a
 * QuarantinedRgb.
 *
 * - `artwork`          — shader fields, Shadertoy sources: color is content.
 * - `test-vector`      — screenshot/emission fixtures: theming destroys them.
 * - `data-passthrough` — externally-owned colors (syntax tokens): honored
 *                        literally, still region-dimmed and depth-degraded.
 */

import type { Rgb } from "./color.js";

export type QuarantineKind = "artwork" | "test-vector" | "data-passthrough";

declare const __quarantine: unique symbol;

/** A literal color that has declared why it is allowed to exist. */
export type QuarantinedRgb = Rgb & { readonly [__quarantine]: QuarantineKind };

export function quarantine(rgb: Rgb, _kind: QuarantineKind): QuarantinedRgb {
  return rgb as QuarantinedRgb;
}
