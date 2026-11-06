/**
 * Neighbor prompt stacks and the 2-deep edge budget.
 * Tea owns the pin list.
 */

export type RewindNeighbor = {
  readonly key: string;
  readonly text: string;
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
