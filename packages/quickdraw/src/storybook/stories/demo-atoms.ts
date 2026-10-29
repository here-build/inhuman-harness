/**
 * Storybook-local demo constructors. Not on the product widgets barrel.
 */
import type { Intent, LayoutNode } from "../../layout/index.js";
import { BgP, FgP, type SemanticRole } from "../../lexicon/index.js";
import { Text } from "../../widgets/index.js";

type TextStyle = {
  bold?: boolean;
  dim?: boolean;
  strike?: boolean;
  fg?: number;
  bg?: number;
  fgRgb?: { r: number; g: number; b: number };
  bgRgb?: { r: number; g: number; b: number };
  role?: SemanticRole;
  bgRole?: SemanticRole;
  prominence?: number;
  bgProminence?: number;
  regionProminence?: number;
};

export function Button(
  label: string,
  opts: {
    key?: string;
    intent?: Intent;
    onClick?: unknown;
    style?: TextStyle;
  } = {},
): LayoutNode {
  return {
    type: "box",
    key: opts.key,
    intent: opts.intent,
    onClick: opts.onClick,
    style: {
      border: true,
      padding: { t: 0, r: 1, b: 0, l: 1 },
    },
    children: [
      Text(label, {
        key: opts.key ? `${opts.key}:label` : undefined,
        style: opts.style,
      }),
    ],
  };
}

const PANEL_BG: { bgRole: SemanticRole; bgProminence: number } = {
  bgRole: "surface",
  bgProminence: BgP.panel,
};

const TITLE_STYLE: TextStyle = {
  role: "foreground",
  prominence: FgP.primary,
  bold: true,
};

export function Panel(
  children: LayoutNode[],
  opts: { key?: string; title?: string; width?: number; height?: number } = {},
): LayoutNode {
  const kids: LayoutNode[] = [];
  if (opts.title) kids.push(Text(opts.title, { style: TITLE_STYLE }));
  kids.push(...children);
  return {
    type: "box",
    key: opts.key,
    style: {
      border: true,
      width: opts.width,
      height: opts.height,
      padding: 1,
      background: PANEL_BG,
    },
    children: kids,
  };
}

export function Modal(
  body: LayoutNode,
  opts: {
    key?: string;
    title?: string;
    width?: number;
    height?: number;
  } = {},
): LayoutNode {
  const kids: LayoutNode[] = [];
  if (opts.title) kids.push(Text(opts.title, { style: TITLE_STYLE }));
  kids.push(body);
  return {
    type: "overlay",
    key: opts.key ?? "modal",
    center: true,
    backdrop: true,
    children: [
      {
        type: "box",
        key: `${opts.key ?? "modal"}:panel`,
        style: {
          border: true,
          width: opts.width,
          height: opts.height,
          padding: 1,
          background: PANEL_BG,
        },
        children: kids,
      },
    ],
  };
}
