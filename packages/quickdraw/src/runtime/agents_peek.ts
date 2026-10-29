/**
 * Agents-drawer peek — same-fill plaque next to the focused row.
 *
 * Placement is the copy-toast grain: prefer top-aligned to the anchor,
 * flip to bottom-align when that hangs off the viewport, then clamp.
 * Horizontal seat is 1 cell off the panel's right edge, and 1 cell
 * in from the viewport's right edge. No rim.
 */
import { layout } from "../layout/engine.js";
import { measureNode } from "../layout/measure.js";
import type { LayoutNode } from "../layout/types.js";

export const APP_AGENTS_PEEK_KEY = "agents:peek";
export const APP_AGENTS_PEEK_OVERLAY_KEY = "agents:peek-overlay";
/** Gap between the drawer panel and the peek. */
export const AGENTS_PEEK_GAP = 1;
/** Gap between the peek's right edge and the viewport. */
export const AGENTS_PEEK_RIGHT_MARGIN = 1;
/** Plaque height including pad. */
export const AGENTS_PEEK_MAX_HEIGHT = 9;

export type AgentsPeekPlace = {
  x: number;
  y: number;
  w: number;
  h: number;
  side: "down" | "up";
};

export function placeAgentsPeek(args: {
  anchor: { x: number; y: number; w: number; h: number };
  panel: { x: number; y: number; w: number; h: number };
  cols: number;
  rows: number;
  size: { w: number; h: number };
}): AgentsPeekPlace | null {
  const right = args.panel.x + args.panel.w + AGENTS_PEEK_GAP;
  const maxW = Math.max(0, args.cols - right - AGENTS_PEEK_RIGHT_MARGIN);
  if (maxW < 1 || args.rows < 1) return null;
  const w = Math.min(Math.max(1, args.size.w), maxW);
  const h = Math.min(Math.max(1, args.size.h), args.rows);
  const x = clamp(right, 0, Math.max(0, args.cols - w - AGENTS_PEEK_RIGHT_MARGIN));
  const downY = args.anchor.y;
  const upY = args.anchor.y + args.anchor.h - h;
  const downFits = downY >= 0 && downY + h <= args.rows;
  const upFits = upY >= 0 && upY + h <= args.rows;
  let side: "down" | "up";
  let y: number;
  if (downFits) {
    side = "down";
    y = downY;
  } else if (upFits) {
    side = "up";
    y = upY;
  } else {
    side = "down";
    y = clamp(downY, 0, Math.max(0, args.rows - h));
  }
  return { x, y, w, h, side };
}

export function withAgentsPeek(args: {
  root: LayoutNode;
  peek: LayoutNode;
  focusKey: string;
  cols: number;
  rows: number;
}): LayoutNode {
  if (args.root.type !== "box") return args.root;
  const frame = layout(args.root, { w: args.cols, h: args.rows });
  const panel = frame.byKey.get("agents:panel");
  const anchor = frame.byKey.get(args.focusKey);
  if (panel === undefined || anchor === undefined) return args.root;
  if (anchor.hitRect.w < 1 || anchor.hitRect.h < 1) return args.root;
  const room = args.cols - (panel.hitRect.x + panel.hitRect.w) - AGENTS_PEEK_GAP - AGENTS_PEEK_RIGHT_MARGIN;
  if (room < 1) return args.root;
  const measured = measureNode(args.peek, room, args.rows);
  const size = {
    w: Math.max(1, measured.w),
    h: Math.min(Math.max(1, measured.h), AGENTS_PEEK_MAX_HEIGHT, args.rows),
  };
  const place = placeAgentsPeek({
    anchor: anchor.hitRect,
    panel: panel.hitRect,
    cols: args.cols,
    rows: args.rows,
    size,
  });
  if (place === null) return args.root;
  const peek: LayoutNode =
    args.peek.type === "box"
      ? {
          ...args.peek,
          style: { ...args.peek.style, width: place.w, height: place.h, overflow: "hidden" },
        }
      : args.peek;
  return {
    ...args.root,
    children: [
      ...(args.root.children ?? []),
      {
        type: "overlay",
        key: APP_AGENTS_PEEK_OVERLAY_KEY,
        origin: { x: place.x, y: place.y },
        children: [peek],
      },
    ],
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
