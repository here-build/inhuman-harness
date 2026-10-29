/**
 * Buffer-law stories — content guard, transparent inherit, wide CJK,
 * dirty-row damage. Dual-dirty is catalogued under theme/depth (resolver
 * pose, not dirtyRows) but lives here because it builds two resolve trees.
 */

import { Panel } from "./demo-atoms.js";
import { cloneBuffer, createBuffer, dirtyRows, guardContent, put } from "../../buffer/index.js";
import { BgP, FgP, type SemanticRole } from "../../lexicon/index.js";
import { defaultTheme, makeStyleResolver, resolveStyle } from "../../theme/index.js";
import { Text } from "../../widgets/index.js";
import type { Story } from "../types.js";

/** Visible stand-in for ESC so story paint never injects CSI into the terminal. */
function visualizeEsc(s: string): string {
  return s.replaceAll("\u001B", "␛").replaceAll("\u009B", "␛");
}

// `resolveStyle` returns theme's StyleLike (`role: string`); widgets' TextStyle
// narrows it to the lexicon's SemanticRole union — the literal passed in is
// always a valid member, so this boundary widening is exact, not a lie.
const asRole = <T extends { role?: string; bgRole?: string }>(s: T) =>
  s as Omit<T, "role" | "bgRole"> & {
    role?: SemanticRole;
    bgRole?: SemanticRole;
  };

export const PAINT_STORIES: Story[] = [
  {
    id: "paint-content-guard",
    name: "Content guard",
    category: "buffer",
    family: "guard",
    description: "Raw CSI-bearing string vs guardContent result (two labeled lines)",
    build: (ctx) => {
      const raw = "hello\u001B[31mworld\u001B[?1049h";
      const guarded = guardContent(raw);
      return Panel(
        [
          Text("raw (CSI visualized):", {
            style: { bold: true, role: "foreground" },
          }),
          Text(visualizeEsc(raw), { style: { role: "error" } }),
          Text(`stripped: ${guarded !== raw}`, { style: { role: "warning" } }),
          Text("guardContent:", {
            style: { bold: true, role: "foreground" },
          }),
          Text(guarded, { style: { role: "success" } }),
        ],
        {
          title: "content guard",
          width: Math.min(48, ctx.cols),
          height: Math.min(11, ctx.rows),
        },
      );
    },
  },
  {
    id: "paint-transparent-bg",
    name: "Transparent bg",
    category: "buffer",
    family: "inherit",
    description: "Panel fill then border/text without bg — mergeStyle inherits under-cell bg (TERMINAL O1)",
    build: (ctx) => ({
      type: "box",
      style: {
        width: Math.min(40, ctx.cols),
        height: Math.min(9, ctx.rows),
        border: true,
        padding: 1,
        // color-parity-ignore: literal bg demonstrates the buffer transparency
        // law itself (mergeStyle keeps 235 under border/text) — the raw value
        // is the point of the story, not a themed surface fill.
        background: { bg: 235 },
      },
      children: [
        Text("fill bg=235 under border", { style: { role: "foreground" } }),
        Text("text style has no bg → inherit", { style: { role: "accent" } }),
        Text("mergeStyle: under.bg wins", {
          style: { role: "foreground", prominence: FgP.secondary },
        }),
      ],
    }),
  },
  {
    id: "paint-wide-cjk",
    name: "Wide CJK",
    category: "buffer",
    family: "measure",
    description: "CJK + ASCII on one line — wide glyph + placeholder mates",
    build: (ctx) =>
      Panel(
        [
          Text("ASCII only: abc XYZ 123", { style: { role: "foreground" } }),
          Text("CJK + ASCII: 日本語 ABC 中文", { style: { role: "accent" } }),
          Text("mixed: 漢a漢b · 你好 world", { style: { role: "foreground" } }),
          Text("emoji-ish wide: 日本語テスト", { style: { role: "warning" } }),
        ],
        {
          title: "wide CJK",
          width: Math.min(42, ctx.cols),
          height: Math.min(10, ctx.rows),
        },
      ),
  },
  {
    id: "paint-dual-dirty",
    name: "Depth · dual resolve",
    category: "theme",
    family: "depth",
    description: "Same tree, truecolor vs ansi256 resolveStyle — theme depth pose, not dirtyRows",
    build: (ctx) => {
      const theme = defaultTheme;
      // Left: truecolor resolve; right: ansi256 resolve — identical tree shape
      const leftResolve = makeStyleResolver({ theme, depth: "truecolor" });
      const rightResolve = makeStyleResolver({ theme, depth: "ansi256" });

      const body = (label: string, resolve: typeof leftResolve) => {
        const title = resolve({ role: "emphasis", bold: true });
        const accent = resolve({ role: "accent" });
        const muted = resolve({ role: "muted" });
        return {
          type: "box" as const,
          style: {
            border: true,
            flex: { grow: 1, shrink: 1, basis: 0 },
            height: 7,
            padding: 1,
            background: {
              bgRole: "surface" as const,
              bgProminence: BgP.panel,
            },
          },
          children: [
            Text(label, { style: asRole(title) }),
            Text("accent line", { style: asRole(accent) }),
            Text("muted line", { style: asRole(muted) }),
          ],
        };
      };

      return {
        type: "box",
        style: {
          width: Math.min(ctx.cols, 56),
          height: Math.min(ctx.rows, 11),
          padding: 1,
        },
        children: [
          Text("dual-dirty: layout once · recolor via resolveStyle", {
            style: {
              bold: true,
              ...asRole(resolveStyle({ role: "foreground" }, { theme })),
            },
          }),
          {
            type: "flex",
            style: {
              direction: "row",
              gap: 1,
              height: 7,
              width: Math.min(ctx.cols - 2, 52),
            },
            children: [body("truecolor", leftResolve), body("ansi256", rightResolve)],
          },
        ],
      };
    },
  },
  {
    id: "paint-dirty-rows",
    name: "Dirty rows",
    category: "buffer",
    family: "damage",
    description: "Text visualization of dirtyRows indices after a buffer change (debug)",
    build: (ctx) => {
      const prev = createBuffer(12, 5);
      put(prev, 0, 0, "row0 unchanged");
      put(prev, 0, 1, "row1 old");
      put(prev, 0, 2, "row2 unchanged");
      put(prev, 0, 3, "row3 old");
      put(prev, 0, 4, "row4 unchanged");

      const next = cloneBuffer(prev);
      put(next, 0, 1, "row1 NEW");
      put(next, 0, 3, "row3 NEW");

      const dirty = dirtyRows(prev, next);
      const mark = (y: number) => (dirty.includes(y) ? "◆ dirty" : "· clean");

      return Panel(
        [
          Text(`dirtyRows → [${dirty.join(", ")}]`, {
            style: { bold: true, role: "accent" },
          }),
          Text(`y0 ${mark(0)}  row0 unchanged`, {
            style: { role: "foreground", prominence: FgP.secondary },
          }),
          Text(`y1 ${mark(1)}  row1 NEW`, { style: { role: "error" } }),
          Text(`y2 ${mark(2)}  row2 unchanged`, {
            style: { role: "foreground", prominence: FgP.secondary },
          }),
          Text(`y3 ${mark(3)}  row3 NEW`, { style: { role: "error" } }),
          Text(`y4 ${mark(4)}  row4 unchanged`, {
            style: { role: "foreground", prominence: FgP.secondary },
          }),
        ],
        {
          title: "dirty rows",
          width: Math.min(40, ctx.cols),
          height: Math.min(12, ctx.rows),
        },
      );
    },
  },
];
