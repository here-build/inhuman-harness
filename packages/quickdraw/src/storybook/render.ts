/**
 * Story → cell buffer via production `renderFrame` only.
 *
 * Binds `attuneTheme` (reference ground; depth from production detection)
 * instead of calling bare `paintFrame` with no theme: a theme-less
 * `paintFrame` skips `resolveStyle` entirely (`applyThemeStyle` falls through
 * unresolved), so role/bgRole-authored stories painted with no color at all.
 * Demos and goldens need to exercise the real resolver path.
 */

import type { Buffer as CellBuffer } from "../buffer/index.js";
import type { ColorDepth } from "../capabilities/index.js";
import { emptyEcho, renderFrame, resolvePresentConfig } from "../index.js";
import { attuneTheme, type LayoutNode } from "../layout/index.js";
import { canvasPolarity } from "../theme/index.js";
import { setHighlightPolarity } from "../widgets/internals/syntax.js";

/** Frozen clock for goldens / catalog paint — live labels stay deterministic. */
export const STORY_PAINT_NOW_MS = 1_700_000_000_000;

export function paintNode(
  node: LayoutNode,
  cols: number,
  rows: number,
  opts: { depth?: ColorDepth; nowMs?: number } = {},
): CellBuffer {
  // No probe in a demo/test host — resolvePresentConfig falls back to
  // guessColorDepth(env), so NO_COLOR-in-CI still lands on mono here too.
  const depth = opts.depth ?? resolvePresentConfig().colorDepth;
  const { paint, theme } = attuneTheme({ depth });
  setHighlightPolarity(canvasPolarity(theme.ground));
  return renderFrame({
    snapshot: { tree: { root: node, boxes: {} }, getBox: () => undefined },
    geometry: { cols, rows },
    state: {
      nowMs: opts.nowMs ?? STORY_PAINT_NOW_MS,
      echo: emptyEcho(),
      theme: paint,
    },
  }).buffer;
}
