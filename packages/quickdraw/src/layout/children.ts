import type { LayoutNode } from "./types.js";

export function layoutChildren(node: LayoutNode): readonly LayoutNode[] {
  return "children" in node && Array.isArray(node.children) ? node.children : [];
}

/** Spread of a LayoutNode union does not re-join. */
export function mapLayoutChildren(node: LayoutNode, map: (child: LayoutNode) => LayoutNode): LayoutNode {
  if (!("children" in node) || !Array.isArray(node.children)) return node;
  let changed = false;
  const children = node.children.map((child) => {
    const next = map(child);
    if (next !== child) changed = true;
    return next;
  });
  if (!changed) return node;
  return { ...node, children } as LayoutNode;
}
