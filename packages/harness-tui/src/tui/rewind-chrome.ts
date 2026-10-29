/**
 * Neighbor prompt stacks and the 2-deep edge budget. Layout nodes only —
 * Tea owns the pin list; assemble seats them.
 */
import { chromeFrameTotalHeight, type LayoutNode } from "@inhuman.tools/quickdraw/layout";
import { ComposerFrame } from "@inhuman.tools/quickdraw/widgets";

export type RewindNeighbor = {
  readonly key: string;
  readonly text: string;
};

export type RewindNeighborEdge = {
  readonly side: "behind" | "ahead";
  /** Quickdraw T-join past the 2-deep window. */
  readonly moreOuter: boolean;
};

export function rewindNeighborSlots(
  aheadCount: number,
  behindCount: number,
): { readonly ahead: number; readonly behind: number } {
  return {
    ahead: Math.min(2, Math.max(0, aheadCount)),
    behind: Math.min(2, Math.max(0, behindCount)),
  };
}

export function compactPinDraft(prompt: string): string {
  const first = (prompt.split("\n")[0] ?? "").replaceAll(/\s+/g, " ").trim();
  return prompt.includes("\n") ? `${first}…` : first;
}

/** Chrome stack: first frame 3 rows, each extra omitTop frame 2. */
export function neighborColumnHeight(n: number): number {
  if (n <= 0) return 0;
  return chromeFrameTotalHeight(1) + (n - 1) * chromeFrameTotalHeight(1, { omitTop: true });
}

/** Past flex kept before neighbor rows are dropped. */
export const REWIND_MIN_TAPE_ROWS = 4;

export function dropOldestPastThenFarthestFuture(
  past: readonly RewindNeighbor[],
  future: readonly RewindNeighbor[],
  maxHeight: number,
): { past: RewindNeighbor[]; future: RewindNeighbor[] } {
  const budget = Math.max(0, Math.floor(maxHeight));
  let behind = [...past];
  let ahead = [...future];
  while (neighborColumnHeight(behind.length) + neighborColumnHeight(ahead.length) > budget) {
    if (behind.length > 0) behind = behind.slice(1);
    else if (ahead.length > 0) ahead = ahead.slice(0, -1);
    else break;
  }
  return { past: behind, future: ahead };
}

export function prepareRewindNeighbors(
  rows: readonly RewindNeighbor[],
  width: number,
  key: string,
  edge: RewindNeighborEdge,
): LayoutNode | null {
  if (rows.length === 0) return null;
  const n = rows.length;
  return {
    type: "flex",
    regionProminence: 0.45,
    key,
    style: { direction: "column", gap: 0, width },
    children: rows.map((row, i) => {
      const first = i === 0;
      const last = i === n - 1;
      const omitTop = !first;
      const joinTop = first && edge.side === "behind" && edge.moreOuter;
      const joinBottom = edge.side === "behind" ? !last : !last || edge.moreOuter;
      return {
        type: "box",
        key: row.key,
        intent: "activate",
        userSelect: "none",
        children: [
          ComposerFrame(
            {
              inputValue: compactPinDraft(row.text),
              interactive: false,
              readOnly: true,
            },
            {
              key: `${row.key}:chrome`,
              width,
              omitTop,
              joinTop,
              joinBottom,
              plainBottom: true,
            },
          ),
        ],
      };
    }),
  };
}
