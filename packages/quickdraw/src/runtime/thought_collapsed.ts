/**
 * Host-local thought expand/collapse — display only.
 * ThinkingStream stamps `onClick: { type: "toggle_collapsed", blockId }`; bare click
 * flips `collapsed` on the disclosure. Both branches already live in the tree.
 */
import type { PaintSnapshot } from "./frame.js";
import type { LayoutNode } from "../layout/index.js";

export type ToggleCollapsedClick = {
  readonly type: "toggle_collapsed";
  readonly blockId: string;
};

export function isToggleCollapsedClick(value: unknown): value is ToggleCollapsedClick {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  if (rec.type !== "toggle_collapsed") return false;
  return typeof rec.blockId === "string";
}

/**
 * Walk hit meta + byKey parent chain for toggle_collapsed.
 * Accepts raw HitMeta or elementAt's `{ key, meta }` wrapper.
 */
export function toggleCollapsedFromHit(
  hit:
    | { onClick?: unknown; parent?: string; key?: string }
    | { key: string; meta: { onClick?: unknown; parent?: string; key?: string } }
    | null
    | undefined,
  byKey: Map<string, { onClick?: unknown; parent?: string; key?: string }>,
): ToggleCollapsedClick | null {
  let cur: { onClick?: unknown; parent?: string; key?: string } | null | undefined =
    hit && "meta" in hit && hit.meta ? hit.meta : (hit as { onClick?: unknown; parent?: string } | null);
  const seen = new Set<string>();
  while (cur) {
    if (isToggleCollapsedClick(cur.onClick)) return cur.onClick;
    const parent = cur.parent;
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    cur = byKey.get(parent);
  }
  const startKey =
    hit && "meta" in hit && hit.meta
      ? (hit.meta.key ?? hit.key)
      : hit && "key" in hit
        ? (hit as { key?: string }).key
        : undefined;
  if (startKey) {
    let key = startKey;
    while (key.includes(":")) {
      const parentKey = key.slice(0, key.lastIndexOf(":"));
      if (seen.has(parentKey)) break;
      seen.add(parentKey);
      const meta = byKey.get(parentKey);
      if (meta && isToggleCollapsedClick(meta.onClick)) return meta.onClick;
      key = parentKey;
    }
  }
  return null;
}

/** `collapsedOverrides`: blockId → collapsed. Absent key → wire node.collapsed. */
export function applyThoughtCollapsed(node: unknown, collapsedOverrides: ReadonlyMap<string, boolean>): unknown {
  if (typeof node !== "object" || node === null) return node;
  const rec = node as LayoutNode & { onClick?: unknown; children?: LayoutNode[]; summary?: LayoutNode };

  if (rec.type === "disclosure" && isToggleCollapsedClick(rec.onClick)) {
    const { blockId } = rec.onClick;
    if (collapsedOverrides.has(blockId)) {
      return { ...rec, collapsed: collapsedOverrides.get(blockId)! };
    }
  }

  let changed = false;
  let summary = rec.type === "disclosure" ? rec.summary : undefined;
  if (summary) {
    const next = applyThoughtCollapsed(summary, collapsedOverrides);
    if (next !== summary) {
      summary = next as LayoutNode;
      changed = true;
    }
  }
  let children = rec.children;
  if (Array.isArray(children)) {
    const next = children.map((child) => {
      const c = applyThoughtCollapsed(child, collapsedOverrides);
      if (c !== child) changed = true;
      return c as LayoutNode;
    });
    if (changed) children = next;
  }
  if (!changed) return node;
  return {
    ...rec,
    summary,
    children,
  };
}

export function paintSnapshotWithThoughtCollapsed(
  snapshot: PaintSnapshot,
  collapsedOverrides: ReadonlyMap<string, boolean>,
): PaintSnapshot {
  if (collapsedOverrides.size === 0) return snapshot;
  return {
    tree: snapshot.tree,
    getBox(id: number) {
      return applyThoughtCollapsed(snapshot.getBox(id), collapsedOverrides);
    },
  };
}
