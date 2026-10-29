import { BgP, FgP } from "../../lexicon/index.js";
import { Indication, Text } from "../../widgets/index.js";
import type { Story } from "../types.js";

export const LAYOUT_STORIES: Story[] = [
  {
    id: "l-flex-row",
    name: "Flex row",
    category: "layout",
    family: "flex",
    description: "direction row + gap + fr children",
    build: (ctx) => ({
      type: "box",
      style: {
        width: ctx.cols,
        height: ctx.rows,
        border: true,
        padding: 1,
      },
      children: [
        Text("flex row", { style: { bold: true, role: "accent" } }),
        {
          type: "flex",
          style: {
            direction: "row",
            gap: 1,
            height: 5,
            width: Math.min(ctx.cols - 4, 40),
          },
          children: [
            {
              type: "box",
              style: {
                border: true,
                flex: { grow: 1, shrink: 1, basis: 0 },
                height: 5,
                // Surface alternation: no new vocabulary, just the BgP steps.
                background: {
                  bgRole: "surface",
                  bgProminence: BgP.wash,
                },
              },
              children: [Text("grow1", { style: { role: "foreground" } })],
            },
            {
              type: "box",
              style: {
                border: true,
                flex: { grow: 2, shrink: 1, basis: 0 },
                height: 5,
                background: {
                  bgRole: "surface",
                  bgProminence: BgP.panel,
                },
              },
              children: [Text("grow2", { style: { role: "foreground" } })],
            },
          ],
        },
      ],
    }),
  },
  {
    id: "l-flex-column",
    name: "Flex column",
    category: "layout",
    family: "flex",
    description: "direction column stack",
    build: (ctx) => ({
      type: "flex",
      style: {
        direction: "column",
        gap: 1,
        width: Math.min(36, ctx.cols),
        height: Math.min(12, ctx.rows),
        border: true,
        padding: 1,
      },
      children: [
        {
          type: "box",
          style: {
            border: true,
            height: 3,
            // Surface alternation: no new vocabulary, just the BgP steps.
            background: {
              bgRole: "surface",
              bgProminence: BgP.wash,
            },
          },
          children: [Text(" top ", { style: { role: "foreground" } })],
        },
        {
          type: "box",
          style: {
            border: true,
            flex: { grow: 1, shrink: 1, basis: 0 },
            background: {
              bgRole: "surface",
              bgProminence: BgP.panel,
            },
          },
          children: [Text(" grow ", { style: { role: "foreground" } })],
        },
      ],
    }),
  },
  {
    id: "l-indication",
    name: "Indication row",
    category: "layout",
    family: "indication",
    description: "Law 6 · [lead][gutter][gap][content] · content at col 3",
    build: () => ({
      type: "box",
      style: { padding: 1 },
      children: [
        Indication({
          key: "ind-a",
          gutter: { kind: "rule", glyph: "›" },
          children: [Text("body starts after gutter", { style: { role: "foreground" } })],
        }),
        Indication({
          key: "ind-b",
          gutter: { kind: "rule", glyph: "+" },
          style: { role: "diff_add" },
          children: [Text("diff_add role", { style: { role: "diff_add" } })],
        }),
        Indication({
          key: "ind-c",
          gutter: { kind: "rule", glyph: "-" },
          style: { role: "diff_del" },
          children: [Text("diff_del role", { style: { role: "diff_del" } })],
        }),
      ],
    }),
  },
  {
    id: "l-indication-gutters",
    name: "Indication · gutters",
    category: "layout",
    family: "indication",
    description: "gutter.kind top / rule / corners / spinner — Law 6 still holds",
    sampleCount: 4,
    build: (ctx) => {
      const ghost = {
        role: "border" as const,
        prominence: FgP.ghost,
      };
      const body = [
        Text("first body row", { style: { role: "foreground" } }),
        Text("second body row", { style: { role: "foreground" } }),
        Text("third body row", { style: { role: "foreground" } }),
      ];
      const kinds = [
        {
          label: "top · first row only",
          gutter: { kind: "top" as const, glyph: "⁖" },
        },
        {
          label: "rule · every row",
          gutter: { kind: "rule" as const, glyph: "│" },
        },
        {
          label: "corners · ∵ · ∴",
          gutter: {
            kind: "corners" as const,
            top: "∵",
            mid: "·",
            bottom: "∴",
          },
        },
        {
          label: "spinner · thinking / top",
          gutter: {
            kind: "spinner" as const,
            profile: "thinking" as const,
            rows: "top" as const,
          },
        },
      ];
      const pick = kinds[ctx.sample % kinds.length]!;
      return {
        type: "box",
        style: { padding: 1 },
        children: [
          Text(pick.label, {
            style: { role: "muted", prominence: FgP.secondary },
          }),
          Indication({
            key: "ind-gutter",
            gutter: pick.gutter,
            style: ghost,
            children: body,
          }),
        ],
      };
    },
  },
  {
    id: "l-grid",
    name: "Grid · inner lines",
    category: "layout",
    family: "grid",
    description: "type:grid · lines inner · cellPad x=1 — not a markdown table",
    build: (ctx) => ({
      type: "box",
      style: { padding: 1, width: Math.min(48, ctx.cols) },
      children: [
        Text("grid tracks", {
          style: { role: "muted", prominence: FgP.secondary },
        }),
        {
          type: "grid",
          key: "grid-inner",
          style: {
            columns: ["auto", "auto", "auto"],
            lines: "inner",
            cellPad: { x: 1 },
            lineStyle: {
              role: "border",
              prominence: FgP.ghost,
            },
          },
          children: [
            Text("check", { style: { bold: true, role: "foreground" } }),
            Text("status", { style: { bold: true, role: "foreground" } }),
            Text("ms", { style: { bold: true, role: "foreground" } }),
            Text("compile", { style: { role: "foreground" } }),
            Text("ok", { style: { role: "success" } }),
            Text("812", { style: { role: "muted" } }),
            Text("test", { style: { role: "foreground" } }),
            Text("ok", { style: { role: "success" } }),
            Text("4021", { style: { role: "muted" } }),
          ],
        },
      ],
    }),
  },
  {
    id: "l-viewport",
    name: "Viewport",
    category: "layout",
    family: "viewport",
    description: "overflowAnchor auto pins bottom; none + scroll is manual",
    sampleCount: 2,
    build: (ctx) => {
      const lines = Array.from({ length: 16 }, (_, i) =>
        Text(`row ${String(i).padStart(2, "0")} of the stack`, {
          key: `vp:${i}`,
          style: { role: "foreground" },
        }),
      );
      const pin = ctx.sample % 2 === 0;
      return {
        type: "box",
        style: { padding: 1, width: Math.min(40, ctx.cols), height: ctx.rows },
        children: [
          Text(pin ? "anchor auto · newest visible" : "anchor none · scroll 3", {
            style: { role: "muted", prominence: FgP.secondary },
          }),
          {
            type: "viewport",
            id: "vp-demo",
            key: "vp-demo",
            overflowAnchor: pin ? "auto" : "none",
            scroll: pin ? undefined : 3,
            style: { height: Math.min(8, Math.max(4, ctx.rows - 3)), border: true },
            children: lines,
          },
        ],
      };
    },
  },
  {
    id: "l-disclosure",
    name: "Disclosure",
    category: "layout",
    family: "disclosure",
    description: "collapsed = summary only; open = children only — never both",
    sampleCount: 2,
    build: (ctx) => {
      const collapsed = ctx.sample % 2 === 0;
      return {
        type: "box",
        style: { padding: 1 },
        children: [
          Text(collapsed ? "collapsed · summary" : "open · children", {
            style: { role: "muted", prominence: FgP.secondary },
          }),
          {
            type: "disclosure",
            key: "disc-demo",
            collapsed,
            summary: Text("summary row (hidden when open)", {
              style: { role: "foreground" },
            }),
            children: [
              Text("child body (unmeasured when collapsed)", {
                style: { role: "foreground" },
              }),
            ],
          },
        ],
      };
    },
  },
  {
    id: "l-text-wrap",
    name: "Text wrap",
    category: "layout",
    family: "text",
    description: "normal / nowrap+ellipsis / pre-wrap / pre-line / lineClamp",
    sampleCount: 5,
    build: (ctx) => {
      const w = Math.min(28, Math.max(16, ctx.cols - 4));
      const poses = [
        {
          label: "normal · collapse space",
          whiteSpace: "normal" as const,
          content: "keep  the   edges  but   collapse   interior",
        },
        {
          label: "nowrap + ellipsis",
          whiteSpace: "nowrap" as const,
          ellipsis: true,
          content: "word ".repeat(20).trim(),
        },
        {
          label: "pre-wrap · keep spaces + wrap",
          whiteSpace: "pre-wrap" as const,
          content: "keep  these   spaces\nand this hard break",
        },
        {
          label: "pre-line · hard breaks, collapse space",
          whiteSpace: "pre-line" as const,
          content: "collapse   these\nkeep the break",
        },
        {
          label: "lineClamp 2",
          whiteSpace: "normal" as const,
          lineClamp: 2,
          content: "first line wraps then the second line is the last visible then the rest is gone",
        },
      ];
      const pose = poses[ctx.sample % poses.length]!;
      return {
        type: "box",
        style: { padding: 1, width: w + 4 },
        children: [
          Text(pose.label, {
            style: { role: "muted", prominence: FgP.secondary },
          }),
          {
            type: "box",
            style: { width: w, border: true, padding: 1 },
            children: [
              Text(pose.content, {
                whiteSpace: pose.whiteSpace,
                ellipsis: pose.ellipsis,
                lineClamp: pose.lineClamp,
                style: { role: "foreground" },
              }),
            ],
          },
        ],
      };
    },
  },
  {
    id: "l-indication-exception",
    name: "Indication · exception",
    category: "layout",
    family: "indication",
    description: "Law 6 content at col 3 vs indentation_exception full-bleed (diff / fence allowlist)",
    build: () => ({
      type: "box",
      style: { padding: 1 },
      children: [
        Text("ruler  0123456789", {
          style: { role: "muted", prominence: FgP.ghost },
          whiteSpace: "nowrap",
        }),
        Indication({
          key: "ind-law6",
          gutter: { kind: "rule", glyph: "›" },
          style: { role: "border", prominence: FgP.ghost },
          children: [Text("body starts at col 3", { style: { role: "foreground" } })],
        }),
        {
          type: "indentation_exception",
          key: "ind-bleed",
          kind: "diff",
          children: [
            Text("full-bleed by declaration", {
              style: { role: "diff_add" },
            }),
          ],
        },
      ],
    }),
  },
];
