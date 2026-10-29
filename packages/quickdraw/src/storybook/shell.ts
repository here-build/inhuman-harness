/**
 * Catalog sidebar + demo pane as a single LayoutNode tree.
 */

import { type Story, type StoryChapter, isStoryChapter } from "./types.js";
import { type LayoutNode } from "../layout/index.js";
import { BgP, FgP } from "../lexicon/index.js";
import { Text } from "../widgets/index.js";

export type SideItem = { kind: "chapter"; chapter: StoryChapter } | { kind: "story"; story: Story; index: number };

/** Chapter headers only for known pipeline chapters (synthetic catalogs stay flat). */
export function buildSideItems(stories: readonly Story[]): SideItem[] {
  const items: SideItem[] = [];
  let last: string | undefined;
  for (const [i, story] of stories.entries()) {
    const ch = story!.category;
    if (isStoryChapter(ch) && ch !== last) {
      items.push({ kind: "chapter", chapter: ch });
      last = ch;
    }
    items.push({ kind: "story", story: story!, index: i });
  }
  return items;
}

/** Demo chrome — family · id. Chapter is the sidebar header; don't restate it. */
function storyWhere(s: Story): string {
  return s.family ? `${s.family} · ${s.id}` : s.id;
}

export type ShellState = {
  cols: number;
  rows: number;
  filter: string;
  selected: number;
  focus: "list" | "demo";
  tick: number;
  sample: number;
  stories: Story[];
  nowMs?: number;
};

export function buildShell(state: ShellState): LayoutNode {
  const { cols, rows, filter, selected, focus, tick, sample, stories, nowMs } = state;
  const sideW = Math.min(30, Math.max(18, Math.floor(cols * 0.32)));
  const demoW = Math.max(10, cols - sideW - 1);
  const bodyH = Math.max(3, rows - 2);

  const sel = Math.min(selected, Math.max(0, stories.length - 1));
  const entry = stories[sel];

  // Window the catalog so the selected row is always painted. Pre-migration
  // (and Wave 5) only ever rendered stories.slice(0, bodyH-3) — j/k past that
  // window advanced `selected` while the sidebar stayed on Story 00…N, so
  // selection looked broken.
  // Side box: border(2) + filter row(1, nowrap) + list. Cap must match paint
  // height or the selected row is laid out then overflow-clipped.
  const listCap = Math.max(1, bodyH - 2 /* border */ - 1 /* filter */);
  const items = buildSideItems(stories);
  const selItem = Math.max(
    0,
    items.findIndex((it) => it.kind === "story" && it.index === sel),
  );
  let listStart = 0;
  if (selItem >= listStart + listCap) listStart = selItem - listCap + 1;
  if (selItem < listStart) listStart = selItem;
  listStart = Math.max(0, Math.min(listStart, Math.max(0, items.length - listCap)));
  const visible = items.slice(listStart, listStart + listCap);

  const list: LayoutNode[] = visible.map((item) => {
    if (item.kind === "chapter") {
      return {
        type: "box",
        key: `ch-${item.chapter}`,
        userSelect: "none",
        style: { height: 1, width: sideW - 2 },
        children: [
          Text(item.chapter, {
            key: `ch-${item.chapter}:t`,
            whiteSpace: "nowrap",
            ellipsis: true,
            style: {
              role: "chrome",
              prominence: FgP.ghost,
              bold: true,
            },
          }),
        ],
      };
    }
    const c = item.story;
    const i = item.index;
    // Selected row rides the SELECTION machinery (perception-preserving
    // recolor + accent-hued fill), not a role swap: accent's differentiate
    // tier sits BELOW foreground's baseline, so accent+primary made the
    // selected row DARKER than its neighbors — selection read inverted.
    // Luminance carries hierarchy; the wash carries "selected".
    const on = i === sel;
    const mark = on ? (focus === "list" ? "›" : "·") : " ";
    const prominence = on ? FgP.primary : FgP.secondary;
    const rowStyle = {
      role: "foreground" as const,
      prominence,
      bold: on,
      selected: on,
    };
    // Catalog rows are activate chrome, not transcript text. intent:activate
    // alone admits elementAt for click-to-pick; userSelect:text made multi-row
    // stream selection paint the whole left bar (full-width middle rows).
    return {
      type: "box",
      key: `s-${c.id}`,
      userSelect: "none",
      intent: "activate",
      style: { height: 1, width: sideW - 2 },
      children: [
        Text(`${mark}${c.name}`.slice(0, sideW - 2), {
          key: `s-${c.id}:t`,
          whiteSpace: "nowrap",
          style: rowStyle,
        }),
      ],
    };
  });

  // Demo pane chrome: border(2) + padding(2) + category line(1).
  // Stories used to get bodyH-2 / demoW-2 and overflow-clipped the last lines
  // (md-blockquote-strike lost `keep ~~remove~~ keep` into the bottom pad).
  const demoChromeH = 2 /* border */ + 2 /* padding */ + 1; /* category */
  const demoChromeW = 2 /* border */ + 2; /* padding */
  const demoCols = Math.max(8, demoW - demoChromeW);
  const demoRows = Math.max(3, bodyH - demoChromeH);

  let demo: LayoutNode;
  try {
    demo = entry
      ? entry.build({
          cols: demoCols,
          rows: demoRows,
          tick,
          sample,
          nowMs,
        })
      : Text("(empty catalog)", {
          style: { role: "foreground", prominence: FgP.ghost },
        });
  } catch (error) {
    demo = Text(`demo error: ${error instanceof Error ? error.message : error}`, {
      style: { role: "error" },
    });
  }

  const header =
    focus === "demo"
      ? ` storybook │ ${stories.length} · ←/→ sample · tab · esc list · q`
      : ` storybook │ ${stories.length} · j/k · / filter · tab · q`;

  return {
    type: "box",
    style: { width: cols, height: rows },
    children: [
      {
        type: "box",
        key: "hdr",
        style: { height: 1, width: cols },
        children: [
          Text(header.slice(0, cols), {
            style: {
              bold: true,
              role: "accent",
              prominence: FgP.primary,
            },
          }),
        ],
      },
      {
        type: "flex",
        style: { direction: "row", gap: 1, height: bodyH, width: cols },
        children: [
          {
            type: "box",
            key: "side",
            // Whole catalog pane is chrome for text-select (filter + rows).
            userSelect: "none",
            style: {
              width: sideW,
              height: bodyH,
              border: true,
              overflow: "hidden",
              background: {
                bgRole: "surface",
                bgProminence: BgP.panel,
              },
            },
            children: [
              {
                type: "box",
                key: "side-filter",
                userSelect: "none",
                style: { height: 1, width: sideW - 2 },
                children: [
                  Text((filter ? `/${filter}` : "/").slice(0, Math.max(4, sideW - 2)), {
                    key: "side-filter:t",
                    whiteSpace: "nowrap",
                    ellipsis: true,
                    style: {
                      role: "foreground",
                      prominence: FgP.ghost,
                    },
                  }),
                ],
              },
              ...list,
            ],
          },
          {
            type: "box",
            key: "demo",
            style: {
              width: demoW,
              height: bodyH,
              border: true,
              overflow: "hidden",
              padding: 1,
            },
            // Category is chrome (not drag-selected). Stage body is the
            // selectable surface — same law as harness content sites. Without
            // userSelect:text, SGR mouse + selection host recolors 0 cells
            // and clears the gesture (native terminal select is already dead).
            children: [
              {
                type: "box",
                key: "demo-cat",
                userSelect: "none",
                style: { height: 1, width: demoCols },
                children: [
                  Text((entry ? storyWhere(entry) : "—").slice(0, Math.max(4, demoCols)), {
                    key: "demo-cat:t",
                    whiteSpace: "nowrap",
                    ellipsis: true,
                    style: {
                      role: "foreground",
                      prominence: FgP.secondary,
                    },
                  }),
                ],
              },
              {
                type: "box",
                key: "demo-stage",
                userSelect: "text",
                children: [demo],
              },
            ],
          },
        ],
      },
    ],
  };
}
