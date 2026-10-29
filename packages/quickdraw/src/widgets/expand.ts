/**
 * Render-thread expand of widget prior nodes. The only widgets file besides
 * syntax-boot that may import widgets/internals.
 *
 * TEA ships { type: markdown | diff }. Layout never imports this module.
 */
import type { Style } from "../buffer/index.js";
import { mapLayoutChildren } from "../layout/children.js";
import { INDICATION_CONTENT_INSET } from "../layout/indication.js";
import type { LayoutNode } from "../layout/types.js";
import { buildDiffLayout } from "./internals/diff-expand.js";
import { createStreamingMarkdown, markdownToLayout, type StreamMarkdown } from "./internals/markdown-expand.js";

export type MarkdownExpandPull = {
  content: string;
  /** Snapshot without parser_end so open fences / inlines stay live. */
  live: boolean;
  width?: number;
  key?: string;
  style?: Style;
};

/**
 * Append-only markdown expand for a live response block.
 * Suffix writes reuse the SMD parser; a non-prefix, width, or key change
 * restarts. Sealing (`live: false`) calls parser_end once.
 */
export function createMarkdownExpandStream(): {
  pull(input: MarkdownExpandPull): LayoutNode;
} {
  let session: {
    md: StreamMarkdown;
    written: string;
    ended: boolean;
    width: number | undefined;
    key: string;
    style: Style | undefined;
  } | null = null;

  return {
    pull(input) {
      const width = input.width !== undefined && input.width > 0 ? Math.floor(input.width) : undefined;
      const key = input.key ?? "md";
      const style = input.style;
      const content = input.content;
      if (
        session == null ||
        session.ended ||
        session.width !== width ||
        session.key !== key ||
        session.style !== style ||
        !content.startsWith(session.written)
      ) {
        session = {
          md: createStreamingMarkdown({ key, width, style }),
          written: "",
          ended: false,
          width,
          key,
          style,
        };
      }
      const active = session!;
      const suffix = content.slice(active.written.length);
      if (suffix.length > 0) {
        active.md.write(suffix);
        active.written = content;
      }
      if (!input.live && !active.ended) {
        active.md.end();
        active.ended = true;
      }
      return active.md.root({ key });
    },
  };
}

function childExpandWidth(node: LayoutNode, width: number | undefined): number | undefined {
  if (width === undefined || width <= 0) return width;
  if (node.type === "indication") return Math.max(1, Math.floor(width) - INDICATION_CONTENT_INSET);
  return width;
}

export function expandWidgetPriors(node: LayoutNode, opts?: { width?: number }): LayoutNode {
  if (node.paintReady) return node;
  if (node.type === "markdown") {
    return markdownToLayout(node.content, {
      key: node.key,
      width: opts?.width,
      style: node.style,
    });
  }
  if (node.type === "diff") {
    return buildDiffLayout({
      old: node.old,
      new: node.new,
      width: node.width,
      path: node.path,
      language: node.language,
      mode: node.mode,
      context: node.context,
      key: node.key,
      lineDiffType: node.lineDiffType,
      noHighlight: node.noHighlight,
      hideHeader: node.hideHeader,
      stickyBottomRows: node.stickyBottomRows,
      lineStart: node.lineStart,
    });
  }
  const childOpts = { width: childExpandWidth(node, opts?.width) };
  if (node.type === "disclosure") {
    const collapsed = node.collapsed !== false;
    return {
      ...node,
      summary: expandWidgetPriors(node.summary, childOpts),
      // Layout only places summary when collapsed — expanding hidden markdown
      // / diff children is wasted work on every present.
      children: collapsed ? node.children : node.children?.map((child) => expandWidgetPriors(child, childOpts)),
    };
  }
  return mapLayoutChildren(node, (child) => expandWidgetPriors(child, childOpts));
}
