export type SwipeDecision = "closed" | "open-leading" | "open-trailing" | "commit-leading" | "commit-trailing";

/**
 * Where a horizontal drag lets go.
 * Past about half the row, or a flick once the button is already out, runs the action.
 * Past half the button, the button stays open. Anything shorter closes.
 * `velocity` is the drag's x speed in pixels per millisecond.
 */
export function swipeRelease(
  offset: number,
  velocity: number,
  width: number,
  action: number,
  edges: { readonly leading: boolean; readonly trailing: boolean },
): SwipeDecision {
  const commit = Math.max(width * 0.55, action + 24);
  if (edges.trailing && offset < 0 && (offset <= -commit || (offset <= -action && velocity <= -1.2))) {
    return "commit-trailing";
  }
  if (edges.leading && offset > 0 && (offset >= commit || (offset >= action && velocity >= 1.2))) {
    return "commit-leading";
  }
  if (edges.trailing && offset < 0 && (offset <= -action / 2 || velocity <= -0.45)) return "open-trailing";
  if (edges.leading && offset > 0 && (offset >= action / 2 || velocity >= 0.45)) return "open-leading";
  return "closed";
}

/** Pull past the open range is slowed, so the row resists instead of flying off. */
export function resist(value: number, min: number, max: number): number {
  if (value < min) return min + (value - min) * 0.22;
  if (value > max) return max + (value - max) * 0.22;
  return value;
}
