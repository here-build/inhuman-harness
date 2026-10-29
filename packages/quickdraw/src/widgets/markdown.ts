/**
 * Prior markdown node — layout expands at measure/place.
 *
 * WIDTH: `opts.width` is ignored. Allocation is layout's. Honoring it
 * here fights measure/place. Diff is the opposite (`diff.ts`).
 */
import type { Style } from "../buffer/index.js";
import type { LayoutNode } from "../layout/types.js";

export function Markdown(content: string, opts: { key?: string; width?: number; style?: Style } = {}): LayoutNode {
  return {
    type: "markdown",
    key: opts.key,
    content,
    style: opts.style,
  };
}
