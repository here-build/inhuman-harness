import { expect, test } from "vitest";

import { createBuffer, type Cell } from "../../buffer/index.js";
import { layout } from "../engine.js";
import { paintFrame } from "../paint.js";
import { extendSelection, startSelection } from "../selection.js";
import { serializeSelection } from "../serialize.js";
import type { Frame, LayoutNode } from "../types.js";

const BLANK = (ch = " "): Cell => ({ ch, style: {} });
const TXT = (ch: string): Cell => ({ ch, style: {} });
const WIDE = (ch: string): Cell => ({ ch, style: {} });
const PH = (): Cell => ({ ch: "", style: {}, placeholder: true });

function grid(width: number, height: number, rows: Cell[][]): Cell[] {
  const cells = new Array<Cell>(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const row = rows[r];
      cells[r * width + c] = row && c < row.length ? row[c]! : BLANK();
    }
  }
  return cells;
}

function emptyFrame(w: number, h: number): Frame {
  return layout({ type: "box", style: { width: w, height: h } }, { w, h });
}

function painted(node: LayoutNode, w: number, h: number) {
  const frame = layout(node, { w, h });
  const buf = createBuffer(w, h);
  paintFrame(frame, buf);
  return { frame, buf };
}

const inventoryTable: LayoutNode = {
  type: "grid",
  key: "t",
  style: {
    columns: ["auto", "auto", "auto"],
    lines: "inner",
    lineStyle: { dim: true, fg: 240 },
    cellPad: { x: 1 },
    columnGap: 1,
    rowGap: 1,
  },
  children: [
    { type: "text", key: "t:0:0", content: "check", style: { bold: true }, whiteSpace: "nowrap" },
    { type: "text", key: "t:0:1", content: "status", style: { bold: true }, whiteSpace: "nowrap" },
    { type: "text", key: "t:0:2", content: "ms", style: { bold: true }, whiteSpace: "nowrap" },
    { type: "text", key: "t:1:0", content: "compile", whiteSpace: "nowrap" },
    { type: "text", key: "t:1:1", content: "ok", whiteSpace: "nowrap" },
    { type: "text", key: "t:1:2", content: "812", whiteSpace: "nowrap" },
    { type: "text", key: "t:2:0", content: "test", whiteSpace: "nowrap" },
    { type: "text", key: "t:2:1", content: "ok", whiteSpace: "nowrap" },
    { type: "text", key: "t:2:2", content: "4021", whiteSpace: "nowrap" },
  ],
};

const streamCells = [
  [TXT("a"), TXT("b"), TXT("C"), TXT("D"), TXT("E"), TXT("F"), TXT("G"), TXT("H")],
  [TXT("1"), TXT("2"), TXT("3"), TXT("4"), TXT("5"), TXT("6"), TXT("7"), TXT("8")],
  [TXT("x"), TXT("y"), TXT("z"), TXT("W"), TXT("X"), TXT("Y"), TXT("Z"), TXT("Q")],
];

test.each([
  {
    name: "join \\n right-trim one trailing newline",
    run: () => {
      const w = 12;
      const buf = {
        width: w,
        height: 3,
        cells: grid(w, 3, [
          [TXT("h"), TXT("e"), TXT("l"), TXT("l"), TXT("o")],
          [TXT("w"), TXT("o"), TXT("r"), TXT("l"), TXT("d")],
          [TXT("a"), TXT("b"), TXT("c")],
        ]),
      };
      const sel = extendSelection(startSelection({ col: 0, row: 0 }), { col: 10, row: 2 })!;
      return serializeSelection(buf, emptyFrame(w, 3), sel);
    },
    out: "hello\nworld\nabc\n",
  },
  {
    name: "internal whitespace; trim only trailing",
    run: () => {
      const w = 12;
      const buf = {
        width: w,
        height: 1,
        cells: grid(w, 1, [[TXT("a"), TXT(" "), TXT("b"), TXT(" "), TXT(" "), TXT(" ")]]),
      };
      const sel = extendSelection(startSelection({ col: 0, row: 0 }), { col: 10, row: 0 })!;
      return serializeSelection(buf, emptyFrame(w, 1), sel);
    },
    out: "a b\n",
  },
  {
    name: "drop userSelect none",
    run: () => {
      const root: LayoutNode = {
        type: "flex",
        style: { direction: "row" },
        children: [
          { type: "box", key: "border", userSelect: "none", style: { width: 5, height: 1 } },
          { type: "box", key: "body", userSelect: "text", style: { flex: 1, height: 1 } },
        ],
      };
      const frame = layout(root, { w: 20, h: 1 });
      const buf = {
        width: 20,
        height: 1,
        cells: grid(20, 1, [
          [TXT("|"), TXT(" "), TXT(" "), TXT(" "), TXT(" "), TXT("h"), TXT("e"), TXT("l"), TXT("l"), TXT("o")],
        ]),
      };
      const sel = extendSelection(startSelection({ col: 0, row: 0 }), { col: 19, row: 0 })!;
      return serializeSelection(buf, frame, sel);
    },
    out: "hello\n",
  },
  {
    name: "empty if only chrome",
    run: () => {
      const frame = layout(
        { type: "box", key: "allchrome", userSelect: "none", style: { width: 10, height: 1 } },
        { w: 10, h: 1 },
      );
      const buf = {
        width: 10,
        height: 1,
        cells: grid(10, 1, [[TXT("a"), TXT("b"), TXT("c")]]),
      };
      const sel = extendSelection(startSelection({ col: 0, row: 0 }), { col: 9, row: 0 })!;
      return serializeSelection(buf, frame, sel);
    },
    out: "",
  },
  {
    name: "wide reassembly 日本語",
    run: () => {
      const w = 12;
      const buf = {
        width: w,
        height: 1,
        cells: grid(w, 1, [
          [TXT("a"), TXT("b"), WIDE("日"), PH(), WIDE("本"), PH(), WIDE("語"), PH(), TXT("c"), TXT("d")],
        ]),
      };
      const sel = extendSelection(startSelection({ col: 0, row: 0 }), { col: w - 1, row: 0 })!;
      return serializeSelection(buf, emptyFrame(w, 1), sel);
    },
    out: "ab日本語cd\n",
  },
  {
    name: "placeholder skip",
    run: () => {
      const w = 6;
      const buf = {
        width: w,
        height: 1,
        cells: grid(w, 1, [[PH(), TXT("a"), TXT("b"), PH(), TXT("c"), PH()]]),
      };
      const sel = extendSelection(startSelection({ col: 0, row: 0 }), { col: 5, row: 0 })!;
      return serializeSelection(buf, emptyFrame(w, 1), sel);
    },
    out: "abc\n",
  },
  {
    name: "placeholder skip of partial wide glyph",
    run: () => {
      const w = 6;
      const buf = {
        width: w,
        height: 1,
        cells: grid(w, 1, [[TXT("a"), TXT("b"), WIDE("日"), PH(), TXT("c"), TXT("d")]]),
      };
      const sel = extendSelection(startSelection({ col: 2, row: 0 }), { col: 3, row: 0 })!;
      return serializeSelection(buf, emptyFrame(w, 1), sel);
    },
    out: "日\n",
  },
  {
    name: "trailing spaces trim",
    run: () => {
      const w = 12;
      const buf = {
        width: w,
        height: 1,
        cells: grid(w, 1, [
          [TXT("h"), TXT("e"), TXT("l"), TXT("l"), TXT("o"), BLANK(), BLANK(), BLANK(), BLANK(), BLANK()],
        ]),
      };
      const sel = extendSelection(startSelection({ col: 0, row: 0 }), { col: 10, row: 0 })!;
      return serializeSelection(buf, emptyFrame(w, 1), sel);
    },
    out: "hello\n",
  },
  {
    name: "unwritten mid-range",
    run: () => {
      const w = 8;
      const buf = { width: w, height: 1, cells: grid(w, 1, [[TXT("h"), TXT("i")]]) };
      const sel = extendSelection(startSelection({ col: 0, row: 0 }), { col: 7, row: 0 })!;
      return serializeSelection(buf, emptyFrame(w, 1), sel);
    },
    out: "hi\n",
  },
  {
    name: "empty sel",
    run: () => {
      const w = 5;
      const buf = {
        width: w,
        height: 3,
        cells: grid(w, 3, [
          [TXT("a"), TXT("b")],
          [TXT("c"), TXT("d")],
          [TXT("e"), TXT("f")],
        ]),
      };
      const sel = extendSelection(startSelection({ col: 0, row: 5 }), { col: 4, row: 7 })!;
      return serializeSelection(buf, emptyFrame(w, 3), sel);
    },
    out: "",
  },
  {
    name: "collapsed one char",
    run: () => {
      const w = 5;
      const buf = {
        width: w,
        height: 1,
        cells: grid(w, 1, [[TXT("a"), TXT("b"), TXT("c"), TXT("d"), TXT("e")]]),
      };
      return serializeSelection(buf, emptyFrame(w, 1), startSelection({ col: 2, row: 0 }));
    },
    out: "c\n",
  },
  {
    name: "stream copy",
    run: () => {
      const w = 8;
      const buf = { width: w, height: 3, cells: grid(w, 3, streamCells) };
      const sel = extendSelection(startSelection({ col: 2, row: 0 }), { col: 3, row: 2 })!;
      return serializeSelection(buf, emptyFrame(w, 3), sel);
    },
    out: "CDEFGH\n12345678\nxyzW\n",
  },
  {
    name: "rect copy",
    run: () => {
      const w = 8;
      const buf = { width: w, height: 3, cells: grid(w, 3, streamCells) };
      const sel = extendSelection(startSelection({ col: 2, row: 0 }, "rect"), {
        col: 3,
        row: 2,
      })!;
      return serializeSelection(buf, emptyFrame(w, 3), sel);
    },
    out: "CD\n34\nzW\n",
  },
  {
    name: "table compact markdown",
    run: () => {
      const { frame, buf } = painted(inventoryTable, 40, 10);
      const sel = extendSelection(startSelection({ col: 0, row: 0 }), { col: 24, row: 4 })!;
      return serializeSelection({ cells: buf.cells, width: buf.width, height: buf.height }, frame, sel);
    },
    out: "check | status | ms\n---|---|---\ncompile | ok | 812\n---|---|---\ntest | ok | 4021\n",
  },
  {
    name: "table leading pipe",
    run: () => {
      const { frame, buf } = painted(inventoryTable, 40, 10);
      const status = frame.byKey.get("t:0:1")!;
      const ms = frame.byKey.get("t:0:2")!;
      const sel = extendSelection(startSelection({ col: status.hitRect.x, row: status.hitRect.y }), {
        col: ms.hitRect.x + ms.hitRect.w - 1,
        row: ms.hitRect.y,
      })!;
      return serializeSelection({ cells: buf.cells, width: buf.width, height: buf.height }, frame, sel);
    },
    out: "| status | ms\n",
  },
  {
    name: "table half-cell",
    run: () => {
      const { frame, buf } = painted(inventoryTable, 40, 10);
      const cell = frame.byKey.get("t:1:0")!;
      const sel = extendSelection(startSelection({ col: cell.hitRect.x, row: cell.hitRect.y }), {
        col: cell.hitRect.x + 2,
        row: cell.hitRect.y,
      })!;
      return serializeSelection({ cells: buf.cells, width: buf.width, height: buf.height }, frame, sel);
    },
    out: "com\n",
  },
  {
    name: "table two body rows one sep",
    run: () => {
      const { frame, buf } = painted(inventoryTable, 40, 10);
      const c0 = frame.byKey.get("t:1:0")!;
      const c1 = frame.byKey.get("t:2:2")!;
      const sel = extendSelection(startSelection({ col: c0.hitRect.x, row: c0.hitRect.y }), {
        col: c1.hitRect.x + c1.hitRect.w - 1,
        row: c1.hitRect.y,
      })!;
      return serializeSelection({ cells: buf.cells, width: buf.width, height: buf.height }, frame, sel);
    },
    out: "compile | ok | 812\n---|---|---\ntest | ok | 4021\n",
  },
  {
    name: "draft copy no side bars/glyph",
    run: () => {
      const w = 40;
      const h = 8;
      const { frame, buf } = painted(
        { type: "chrome_frame", key: "composer", width: w, draft: "first line\nsecond line" },
        w,
        h,
      );
      const body = frame.byKey.get("composer")!;
      const sel = extendSelection(
        startSelection({ col: body.hitRect.x, row: body.hitRect.y }, "char", "composer", body.hitRect),
        {
          col: body.hitRect.x + body.hitRect.w - 1,
          row: body.hitRect.y + body.hitRect.h - 1,
        },
      )!;
      return serializeSelection({ cells: buf.cells, width: buf.width, height: buf.height }, frame, sel);
    },
    out: "first line\nsecond line\n",
  },
])("$name", ({ run, out }) => {
  expect(run()).toEqual(out);
});
