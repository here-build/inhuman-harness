/**
 * Text prior — the only constructor for `type: "text"`.
 */
import type { Style } from "../buffer/index.js";
import type { LayoutNode, UserSelect } from "../layout/index.js";
import type { LivePaint } from "../layout/live_paint.js";

export function Text(
  content: string,
  opts: {
    key?: string;
    whiteSpace?: "normal" | "nowrap" | "pre-wrap" | "pre-line";
    ellipsis?: boolean;
    lineClamp?: number;
    style?: Style;
    live?: LivePaint;
    userSelect?: UserSelect;
  } = {},
): LayoutNode {
  return {
    type: "text",
    content,
    key: opts.key,
    whiteSpace: opts.whiteSpace,
    ellipsis: opts.ellipsis,
    lineClamp: opts.lineClamp,
    style: opts.style,
    live: opts.live,
    userSelect: opts.userSelect,
  };
}
