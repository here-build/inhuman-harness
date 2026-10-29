/**
 * Host-local birth frontier for live stream peeks.
 *
 * Walks declared `live.kind === "birth"` ops in the visible tree, steps W,
 * and hands the map to paint. Only the last site in tape order crawls;
 * earlier sites snap W = T so they paint solid (missing W would rest at
 * T − tipWindow and leave a dim tail). Does not rebuild widget constructors.
 */

import type { PaintSnapshot } from "./frame.js";
import {
  birthFrontierLive,
  createBirthFrontier,
  stepBirthFrontier,
  type BirthFrontierState,
  type LayoutNode,
  type LivePaint,
} from "../layout/index.js";

export type BirthInject = {
  W: number;
};

export type BirthSite = {
  readonly siteId: string;
  readonly T: number;
};

export function collectBirthSites(node: unknown, out: BirthSite[] = [], seen: Set<string> = new Set()): BirthSite[] {
  if (typeof node !== "object" || node === null) return out;
  const rec = node as LayoutNode & {
    live?: LivePaint;
    children?: LayoutNode[];
    summary?: LayoutNode;
    collapsed?: boolean;
  };

  if (rec.type === "disclosure") {
    const visible = rec.collapsed === false ? (rec.children ?? []) : [rec.summary];
    for (const child of visible) collectBirthSites(child, out, seen);
    return out;
  }

  if (rec.live?.kind === "birth" && !seen.has(rec.live.siteId)) {
    seen.add(rec.live.siteId);
    out.push({ siteId: rec.live.siteId, T: rec.live.T });
  }

  if (Array.isArray(rec.children)) {
    for (const c of rec.children) collectBirthSites(c, out, seen);
  }
  return out;
}

export function stepThoughtBirthLedger(
  roots: readonly unknown[],
  frontiers: Map<string, BirthFrontierState>,
  nowMs: number,
): Map<string, BirthInject> {
  const sites: BirthSite[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const site of collectBirthSites(root)) {
      if (seen.has(site.siteId)) continue;
      seen.add(site.siteId);
      sites.push(site);
    }
  }
  return stepLatestBirthSites(sites, frontiers, nowMs);
}

/** Step frontiers from an already-collected site list (Paint DOM path). */
export function stepThoughtBirthFromSites(
  sites: readonly BirthSite[],
  frontiers: Map<string, BirthFrontierState>,
  nowMs: number,
): Map<string, BirthInject> {
  return stepLatestBirthSites(sites, frontiers, nowMs);
}

export function stepThoughtBirthFromSnapshot(
  snapshot: PaintSnapshot,
  frontiers: Map<string, BirthFrontierState>,
  nowMs: number,
): Map<string, BirthInject> {
  const roots: unknown[] = [];
  const tree = snapshot.tree as {
    root?: unknown;
    boxes?: Readonly<Record<string, number>>;
  } | null;
  if (tree && typeof tree === "object") {
    if (tree.root != null) roots.push(tree.root);
    if (tree.boxes && typeof tree.boxes === "object") {
      const ids = new Set(Object.values(tree.boxes));
      for (const id of ids) {
        if (typeof id === "number") roots.push(snapshot.getBox(id));
      }
    }
  }
  return stepThoughtBirthLedger(roots, frontiers, nowMs);
}

function stepLatestBirthSites(
  sites: readonly BirthSite[],
  frontiers: Map<string, BirthFrontierState>,
  nowMs: number,
): Map<string, BirthInject> {
  const unique: BirthSite[] = [];
  const seen = new Set<string>();
  for (const site of sites) {
    if (seen.has(site.siteId)) continue;
    seen.add(site.siteId);
    unique.push(site);
  }
  const latestId = unique.at(-1)?.siteId;
  const inject = new Map<string, BirthInject>();
  for (const site of unique) {
    const field = stepOneBirthSite(site, frontiers, nowMs, {
      resolve: site.siteId !== latestId,
    });
    if (field != null) inject.set(site.siteId, field);
  }
  for (const id of frontiers.keys()) {
    if (!seen.has(id)) frontiers.delete(id);
  }
  return inject;
}

function stepOneBirthSite(
  site: BirthSite,
  frontiers: Map<string, BirthFrontierState>,
  nowMs: number,
  opts?: { resolve?: boolean },
): BirthInject | null {
  const T = site.T;
  if (T <= 0) {
    frontiers.delete(site.siteId);
    return null;
  }
  if (opts?.resolve === true) {
    const resolved: BirthFrontierState = {
      W: T,
      T,
      lastStepMs: nowMs,
      sealed: true,
      lastAdvanceMs: nowMs,
      v: 0,
    };
    frontiers.set(site.siteId, resolved);
    return { W: T };
  }
  const prev = frontiers.get(site.siteId);
  const next = stepBirthFrontier(prev == null ? createBirthFrontier() : { ...prev, sealed: false }, {
    T,
    nowMs,
    sealed: false,
  });
  frontiers.set(site.siteId, next);
  return { W: next.W };
}

/** Any frontier still animating? Present arms its live timer off this. */
export function anyThoughtBirthLive(frontiers: ReadonlyMap<string, BirthFrontierState>): boolean {
  for (const state of frontiers.values()) {
    if (birthFrontierLive(state)) return true;
  }
  return false;
}
