/**
 * Pierre diff prior — render expands via widgets/internals/diff-expand.
 *
 * WIDTH (opposite of Markdown): this prior honors `opts.width`. Markdown
 * ignores it (allocation is layout's; `markdown.ts` names that). Dropping
 * width here makes auto-split / wrap decide against the wrong column budget.
 */
import type { LayoutNode } from "../layout/types.js";
import type { DiffViewOpts } from "./internals/diff-expand.js";

export function Diff(opts: DiffViewOpts): LayoutNode {
  return {
    type: "diff",
    old: opts.old,
    new: opts.new,
    width: opts.width,
    path: opts.path,
    language: opts.language,
    mode: opts.mode,
    context: opts.context,
    key: opts.key,
    lineDiffType: opts.lineDiffType,
    noHighlight: opts.noHighlight,
    hideHeader: opts.hideHeader,
    stickyBottomRows: opts.stickyBottomRows,
    lineStart: opts.lineStart,
  };
}
