import { layoutChildren } from "./children.js";
import type { LayoutNode } from "./types.js";

/**
 * Chrome-frame progress ease — renderer-plane motion.
 *
 * Logic declares a target 0..1 (and optional role). The host holds displayed
 * value and eases toward the target; paint samples the displayed number.
 * Same cut as birth: TEA names the end state, present interpolates.
 */

export const PROGRESS_EASE_MS = 240;

export function easeInOutCubic(t: number): number {
  const x = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export type ProgressBarAnim = {
  readonly displayed: number;
  readonly displayedRole?: string;
  readonly from: number;
  readonly to: number;
  readonly fromRole?: string;
  readonly toRole?: string;
  readonly startedAt: number;
  readonly durationMs: number;
};

export function stepProgressBar(
  prev: ProgressBarAnim | undefined,
  target: number,
  targetRole: string | undefined,
  nowMs: number,
): ProgressBarAnim {
  const to = clamp01(target);
  if (prev === undefined) {
    return {
      displayed: to,
      displayedRole: targetRole,
      from: to,
      to,
      fromRole: targetRole,
      toRole: targetRole,
      startedAt: nowMs,
      durationMs: PROGRESS_EASE_MS,
    };
  }
  const targetChanged = Math.abs(prev.to - to) > 1e-4 || (prev.toRole ?? "") !== (targetRole ?? "");
  if (targetChanged) {
    return {
      displayed: prev.displayed,
      displayedRole: prev.displayedRole,
      from: prev.displayed,
      to,
      fromRole: prev.displayedRole,
      toRole: targetRole,
      startedAt: nowMs,
      durationMs: PROGRESS_EASE_MS,
    };
  }
  const u = easeInOutCubic((nowMs - prev.startedAt) / Math.max(1, prev.durationMs));
  return {
    ...prev,
    displayed: prev.from + (prev.to - prev.from) * u,
    displayedRole: u < 0.5 ? prev.fromRole : prev.toRole,
  };
}

/** Still interpolating — host keeps the present timer armed. */
export function progressBarLive(anim: ProgressBarAnim): boolean {
  if (Math.abs(anim.displayed - anim.to) > 1e-3) return true;
  return (anim.displayedRole ?? "") !== (anim.toRole ?? "");
}

export type ProgressSite = {
  readonly key: string;
  readonly progress: number;
  readonly role?: string;
};

/** Walk a tree for chrome_frame progress targets (host steps these). */
export function collectProgressSites(node: LayoutNode): ProgressSite[] {
  const out: ProgressSite[] = [];
  walk(node, out);
  return out;
}

function walk(node: LayoutNode, out: ProgressSite[]): void {
  if (node.type === "chrome_frame") {
    const key = node.key;
    const progress = node.progress;
    if (key && typeof progress === "number" && node.plainBottom !== true) {
      out.push({
        key,
        progress,
        role: node.progressRole,
      });
    }
  }
  for (const child of layoutChildren(node)) walk(child, out);
  if (node.type === "disclosure") {
    walk(node.summary, out);
  }
}
