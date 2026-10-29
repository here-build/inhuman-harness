/**
 * Newest-line opacity wavefront on a live layout tree.
 *
 * Thinking peeks stamp birth on ShadowStream lines. Live speech is a
 * markdown tree — same live op, last visual row only. Host steps W.
 */
import {
  BIRTH_FRONTIER_DEFAULTS,
  type LayoutNode,
  birthLive,
  layoutChildren,
  mapLayoutChildren,
} from "../layout/index.js";
import { FgP } from "../lexicon/index.js";
import { displayWidth } from "../measure/index.js";

function defaultTipWindow(layoutWidth: number): number {
  const w = Math.max(8, layoutWidth);
  return Math.min(16, Math.max(8, Math.round(w / 4)));
}

function isRowFlex(node: LayoutNode): boolean {
  if (node.type !== "flex") return false;
  const dir = node.style?.direction;
  return dir !== "column" && dir !== "column_reverse";
}

function lastVisualTextLine(node: LayoutNode): Array<Extract<LayoutNode, { type: "text" }>> {
  if (node.type === "text") return [node];
  const kids = layoutChildren(node);
  if (kids.length === 0) return [];
  if (isRowFlex(node)) return kids.flatMap(lastVisualTextLine);
  for (let i = kids.length - 1; i >= 0; i--) {
    const line = lastVisualTextLine(kids[i]!);
    if (line.some((t) => (t.content ?? "").trim().length > 0)) return line;
  }
  return [];
}

function replaceNodes(node: LayoutNode, targets: ReadonlyMap<LayoutNode, LayoutNode>): LayoutNode {
  const hit = targets.get(node);
  if (hit !== undefined) return hit;
  return mapLayoutChildren(node, (child) => replaceNodes(child, targets));
}

/** Stamp `live.kind === "birth"` on the newest visual row. No-op when empty. */
export function stampStreamBirth(node: LayoutNode, opts: { siteId: string; width?: number }): LayoutNode {
  const line = lastVisualTextLine(node);
  if (line.length === 0) return node;
  const T = line.reduce((n, t) => n + displayWidth(t.content ?? ""), 0);
  if (T <= 0) return node;
  const tipWindow = defaultTipWindow(opts.width ?? 48);
  const targets = new Map<LayoutNode, LayoutNode>();
  let offset = 0;
  for (const text of line) {
    const w = displayWidth(text.content ?? "");
    targets.set(text, {
      ...text,
      live: birthLive({
        siteId: opts.siteId,
        T,
        offset,
        target: text.style?.prominence ?? FgP.secondary,
        birthFloor: BIRTH_FRONTIER_DEFAULTS.birthFloor,
        falloff: BIRTH_FRONTIER_DEFAULTS.falloff,
        tipWindow,
      }),
    });
    offset += w;
  }
  return replaceNodes(node, targets);
}
