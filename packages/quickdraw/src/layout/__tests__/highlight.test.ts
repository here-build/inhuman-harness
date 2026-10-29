import { expect, test } from "vitest";

import { createBuffer, type Cell } from "../../buffer/index.js";
import { layout } from "../engine.js";
import { paintFrame } from "../paint.js";
import { extendSelection, startSelection, type SelectionState } from "../selection.js";
import { forEachHighlightCell } from "../selection_paint.js";
import type { Frame, LayoutNode } from "../types.js";

type Dark = { col: number; row: number };

function spans(hits: Array<{ col: number; row: number }>): Array<{ y: number; cols: [number, number] }> {
  const byRow = new Map<number, number[]>();
  for (const h of hits) {
    const list = byRow.get(h.row);
    if (list) list.push(h.col);
    else byRow.set(h.row, [h.col]);
  }
  const rows: Array<{ y: number; cols: [number, number] }> = [];
  for (const y of [...byRow.keys()].sort((a, b) => a - b)) {
    const cols = [...new Set(byRow.get(y)!)].sort((a, b) => a - b);
    let start = cols[0]!;
    let prev = start;
    for (let i = 1; i <= cols.length; i++) {
      const c = cols[i];
      if (c === prev + 1) {
        prev = c;
        continue;
      }
      rows.push({ y, cols: [start, prev] });
      if (c !== undefined) {
        start = prev = c;
      }
    }
  }
  return rows;
}

function lit(
  sel: SelectionState,
  buffer: { cells: Cell[]; width: number; height: number },
  frame: Frame,
  dark: Dark[] = [],
) {
  const hits: Array<{ col: number; row: number }> = [];
  forEachHighlightCell(sel, buffer, frame, (col, row) => hits.push({ col, row }));
  const set = new Set(hits.map((h) => `${h.col},${h.row}`));
  return {
    rows: spans(hits),
    dark: dark.map((d) => ({ ...d, lit: set.has(`${d.col},${d.row}`) })),
  };
}

function painted(node: LayoutNode, w: number, h: number) {
  const frame = layout(node, { w, h });
  const buf = createBuffer(w, h);
  paintFrame(frame, buf);
  return { frame, buf };
}

function drawing(buf: { cells: Cell[]; width: number; height: number }, re: RegExp): Dark[] {
  const out: Dark[] = [];
  for (let row = 0; row < buf.height; row++) {
    for (let col = 0; col < buf.width; col++) {
      if (re.test(buf.cells[row * buf.width + col]!.ch)) out.push({ col, row });
    }
  }
  return out;
}

const CHROME_CH = /[│╭╮╰╯─┌┐└┘❯]/u;

test("highlight cell-set", () => {
  const single = painted(
    {
      type: "box",
      userSelect: "text",
      style: { width: 20, height: 3 },
      children: [{ type: "text", key: "t", content: "abCDEFgh", userSelect: "text", whiteSpace: "nowrap" }],
    },
    20,
    3,
  );
  expect(
    lit(extendSelection(startSelection({ col: 2, row: 0 }), { col: 5, row: 0 })!, single.buf, single.frame),
  ).toEqual({ rows: [{ y: 0, cols: [2, 5] }], dark: [] });

  const multi = painted(
    {
      type: "box",
      userSelect: "text",
      style: { width: 12, height: 3 },
      children: [
        {
          type: "text",
          key: "t",
          content: "..HELLO\nWORLD\nxyZ",
          userSelect: "text",
          whiteSpace: "pre-wrap",
        },
      ],
    },
    12,
    3,
  );
  expect(
    lit(extendSelection(startSelection({ col: 2, row: 0 }), { col: 2, row: 2 })!, multi.buf, multi.frame, [
      { col: 7, row: 0 },
      { col: 11, row: 1 },
    ]),
  ).toEqual({
    rows: [
      { y: 0, cols: [2, 6] },
      { y: 1, cols: [0, 4] },
      { y: 2, cols: [0, 2] },
    ],
    dark: [
      { col: 7, row: 0, lit: false },
      { col: 11, row: 1, lit: false },
    ],
  });

  const gutter = painted(
    {
      type: "flex",
      style: { direction: "row" },
      children: [
        {
          type: "box",
          key: "gutter",
          userSelect: "none",
          style: { width: 4, height: 1 },
          children: [{ type: "text", content: "|   ", whiteSpace: "nowrap" }],
        },
        {
          type: "box",
          key: "body",
          userSelect: "text",
          style: { flex: 1, height: 1 },
          children: [{ type: "text", key: "hello", content: "hello", userSelect: "text", whiteSpace: "nowrap" }],
        },
      ],
    },
    20,
    1,
  );
  const hello = gutter.frame.byKey.get("hello")!;
  expect(
    lit(extendSelection(startSelection({ col: 0, row: 0 }), { col: 19, row: 0 })!, gutter.buf, gutter.frame, [
      { col: 0, row: 0 },
      { col: 3, row: 0 },
    ]),
  ).toEqual({
    rows: [{ y: 0, cols: [hello.hitRect.x, hello.hitRect.x + 4] }],
    dark: [
      { col: 0, row: 0, lit: false },
      { col: 3, row: 0, lit: false },
    ],
  });

  const gapped = painted(
    {
      type: "flex",
      style: { direction: "row", gap: 1, height: 3, width: 20 },
      children: [
        { type: "box", key: "side", userSelect: "none", style: { width: 6, height: 3 } },
        {
          type: "box",
          key: "stage",
          userSelect: "text",
          style: { flex: 1, height: 3 },
          children: [
            {
              type: "text",
              key: "xs",
              content: "XXXXX\nXXXXX\nXXXXX",
              userSelect: "text",
              whiteSpace: "pre-wrap",
            },
          ],
        },
      ],
    },
    20,
    3,
  );
  const side = gapped.frame.byKey.get("side")!;
  const stage = gapped.frame.byKey.get("stage")!;
  const gapCol = side.hitRect.x + side.hitRect.w;
  const sx = stage.hitRect.x;
  expect(
    lit(
      extendSelection(startSelection({ col: sx + 1, row: 0 }), {
        col: sx + 3,
        row: 2,
      })!,
      gapped.buf,
      gapped.frame,
      [
        { col: gapCol, row: 0 },
        { col: gapCol, row: 1 },
        { col: gapCol, row: 2 },
      ],
    ),
  ).toEqual({
    rows: [
      { y: 0, cols: [sx + 1, sx + 4] },
      { y: 1, cols: [sx, sx + 4] },
      { y: 2, cols: [sx, sx + 3] },
    ],
    dark: [
      { col: gapCol, row: 0, lit: false },
      { col: gapCol, row: 1, lit: false },
      { col: gapCol, row: 2, lit: false },
    ],
  });

  const halves = painted(
    {
      type: "box",
      key: "stage",
      userSelect: "text",
      style: { width: 30, height: 2 },
      children: [
        {
          type: "flex",
          key: "row",
          style: { direction: "row", gap: 2, width: 30 },
          children: [
            {
              type: "box",
              key: "L",
              userSelect: "none",
              style: { width: 14, height: 1 },
              children: [{ type: "text", key: "L:t", content: "AAAA", userSelect: "text", whiteSpace: "nowrap" }],
            },
            {
              type: "box",
              key: "R",
              userSelect: "none",
              style: { width: 14, height: 1 },
              children: [{ type: "text", key: "R:t", content: "BBBB", userSelect: "text", whiteSpace: "nowrap" }],
            },
          ],
        },
      ],
    },
    30,
    2,
  );
  const L = halves.frame.byKey.get("L:t")!;
  const R = halves.frame.byKey.get("R:t")!;
  const bridge: Dark[] = [];
  for (let c = L.hitRect.x + 4; c < R.hitRect.x; c++) bridge.push({ col: c, row: 0 });
  expect(
    lit(
      extendSelection(startSelection({ col: L.hitRect.x, row: 0 }), {
        col: R.hitRect.x + 3,
        row: 0,
      })!,
      halves.buf,
      halves.frame,
      bridge,
    ),
  ).toEqual({
    rows: [
      { y: 0, cols: [L.hitRect.x, L.hitRect.x + 3] },
      { y: 0, cols: [R.hitRect.x, R.hitRect.x + 3] },
    ],
    dark: bridge.map((d) => ({ ...d, lit: false })),
  });

  const tokens = painted(
    {
      type: "box",
      key: "stage",
      userSelect: "text",
      style: { width: 20, height: 1 },
      children: [
        {
          type: "flex",
          style: { direction: "row", gap: 0 },
          children: [
            { type: "text", key: "t0", content: "foo", userSelect: "text", whiteSpace: "nowrap" },
            { type: "text", key: "t1", content: " bar", userSelect: "text", whiteSpace: "nowrap" },
          ],
        },
      ],
    },
    20,
    1,
  );
  expect(tokens.buf.cells[3]!.ch).toEqual(" ");
  expect(
    lit(extendSelection(startSelection({ col: 0, row: 0 }), { col: 6, row: 0 })!, tokens.buf, tokens.frame),
  ).toEqual({ rows: [{ y: 0, cols: [0, 6] }], dark: [] });

  const bordered = painted(
    {
      type: "box",
      key: "stage",
      userSelect: "text",
      style: { width: 16, height: 7 },
      children: [
        {
          type: "box",
          key: "panel",
          userSelect: "text",
          style: { width: 12, height: 5, border: true, padding: 1 },
          children: [{ type: "text", key: "body", content: "hello", userSelect: "text", whiteSpace: "nowrap" }],
        },
      ],
    },
    16,
    7,
  );
  const body = bordered.frame.byKey.get("body")!;
  const borderDark = drawing(bordered.buf, CHROME_CH);
  expect(bordered.frame.byKey.get("panel:chrome")?.userSelect).toEqual("none");
  expect(
    lit(
      extendSelection(startSelection({ col: 0, row: 0 }), { col: 15, row: 6 })!,
      bordered.buf,
      bordered.frame,
      borderDark,
    ),
  ).toEqual({
    rows: [{ y: body.hitRect.y, cols: [body.hitRect.x, body.hitRect.x + 4] }],
    dark: borderDark.map((d) => ({ ...d, lit: false })),
  });

  const composer = painted({ type: "chrome_frame", key: "composer", width: 40, draft: "alpha\nbeta" }, 40, 6);
  const composeBody = composer.frame.byKey.get("composer")!;
  const composeDark = drawing(composer.buf, CHROME_CH);
  expect(
    lit(
      extendSelection(
        startSelection(
          { col: composeBody.hitRect.x, row: composeBody.hitRect.y },
          "char",
          "composer",
          composeBody.hitRect,
        ),
        { col: composeBody.hitRect.x + composeBody.hitRect.w - 1, row: composeBody.hitRect.y + 1 },
      )!,
      composer.buf,
      composer.frame,
      composeDark,
    ),
  ).toEqual({
    rows: [
      { y: composeBody.hitRect.y, cols: [composeBody.hitRect.x, composeBody.hitRect.x + 4] },
      { y: composeBody.hitRect.y + 1, cols: [composeBody.hitRect.x, composeBody.hitRect.x + 3] },
    ],
    dark: composeDark.map((d) => ({ ...d, lit: false })),
  });

  const staged = painted(
    {
      type: "box",
      key: "stage",
      userSelect: "text",
      style: { width: 40, height: 8 },
      children: [{ type: "chrome_frame", key: "composer", width: 40, draft: "hello\nworld" }],
    },
    40,
    8,
  );
  const stagedBody = staged.frame.byKey.get("composer")!;
  const edgeDark = drawing(staged.buf, CHROME_CH);
  expect(staged.frame.byKey.get("composer:chrome")?.userSelect).toEqual("none");
  expect(stagedBody.userSelect).toEqual("contain");
  expect(
    lit(extendSelection(startSelection({ col: 0, row: 0 }), { col: 39, row: 7 })!, staged.buf, staged.frame, edgeDark),
  ).toEqual({
    rows: [
      { y: stagedBody.hitRect.y, cols: [stagedBody.hitRect.x, stagedBody.hitRect.x + 4] },
      { y: stagedBody.hitRect.y + 1, cols: [stagedBody.hitRect.x, stagedBody.hitRect.x + 4] },
    ],
    dark: edgeDark.map((d) => ({ ...d, lit: false })),
  });
});
