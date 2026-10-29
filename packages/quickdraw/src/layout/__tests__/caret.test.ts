import { expect, test } from "vitest";

import { displayWidth } from "../../measure/index.js";
import {
  composerDraftSelectionFromCells,
  composerOffsetAtCell,
  parkComposerCaret,
} from "../../widgets/composer-caret.js";
import { chromeFrameTextWidth } from "../chrome_frame.js";
import { layout } from "../engine.js";
import { wrapText } from "../text.js";
import { moveVisualDraft, visualCaretGeometry, visualDraftLines, visualLineIndex } from "../visual_draft.js";

test("visual draft wrap + composer caret", () => {
  const tiledDraft = "abcdefghijklmnopqrst";
  const tiledW = chromeFrameTextWidth(20);
  const tiled = visualDraftLines(tiledDraft, tiledW);
  expect({
    rows: tiled.length > 1,
    start: tiled[0]!.start,
    end: tiled[tiled.length - 1]!.end,
    contiguous: tiled.slice(1).every((line, i) => line.start === tiled[i]!.end),
  }).toEqual({
    rows: true,
    start: 0,
    end: tiledDraft.length,
    contiguous: true,
  });

  expect(visualDraftLines("ab\ncd", 40).map((l) => ({ text: l.text, start: l.start, end: l.end }))).toEqual([
    { text: "ab", start: 0, end: 2 },
    { text: "cd", start: 3, end: 5 },
  ]);

  const wrap5 = "0123456789";
  expect(visualDraftLines(wrap5, 5).map((l) => l.text)).toEqual(["01234", "56789"]);
  expect({
    down: moveVisualDraft(wrap5, 2, 5, "line_down"),
    up: moveVisualDraft(wrap5, 7, 5, "line_up"),
    home: moveVisualDraft(wrap5, 7, 5, "line_home"),
    end: moveVisualDraft(wrap5, 7, 5, "line_end"),
    first: moveVisualDraft("hi", 1, 40, "line_up"),
    last: moveVisualDraft("hi", 1, 40, "line_down"),
  }).toEqual({
    down: 7,
    up: 2,
    home: 5,
    end: 10,
    first: 1,
    last: 1,
  });

  const wrapLines = visualDraftLines(wrap5, 5);
  expect({
    boundary: visualLineIndex(wrapLines, 5),
    park: visualCaretGeometry(wrap5, 5, 5),
    upFromWrap: moveVisualDraft(wrap5, 5, 5, "line_up"),
  }).toEqual({
    boundary: 1,
    park: { line: 1, colInContent: 0, totalLines: 2 },
    upFromWrap: 0,
  });

  expect({
    virtual: visualCaretGeometry("01234", 5, 5),
    upFromVirtual: moveVisualDraft("01234", 5, 5, "line_up"),
    onNewline: visualCaretGeometry("ab\n", 2, 40),
    afterNewline: visualCaretGeometry("ab\n", 3, 40),
    betweenHard: visualCaretGeometry("ab\ncd", 2, 40),
    afterHard: visualCaretGeometry("ab\ncd", 3, 40),
    fullThenNewline: visualCaretGeometry("01234\n", 5, 5),
    afterFullNewline: visualCaretGeometry("01234\n", 6, 5),
  }).toEqual({
    virtual: { line: 1, colInContent: 0, totalLines: 2 },
    upFromVirtual: 0,
    onNewline: { line: 0, colInContent: 2, totalLines: 2 },
    afterNewline: { line: 1, colInContent: 0, totalLines: 2 },
    betweenHard: { line: 0, colInContent: 2, totalLines: 2 },
    afterHard: { line: 1, colInContent: 0, totalLines: 2 },
    fullThenNewline: { line: 0, colInContent: 4, totalLines: 2 },
    afterFullNewline: { line: 1, colInContent: 0, totalLines: 2 },
  });

  const draft = "hello world";
  const textW = 8;
  const lines = visualDraftLines(draft, textW);
  expect(lines.map((l) => l.text)).toEqual(wrapText(draft, { width: textW, whiteSpace: "pre-wrap" }));
  expect(lines.map((l) => l.text)).toEqual(["hello ", "world"]);

  const outerW = textW + 4;
  const frame = layout({ type: "chrome_frame", key: "composer:frame", width: outerW, draft }, { w: outerW, h: 8 });
  const body = frame.byKey.get("composer:frame")!;
  const origin = { col: body.hitRect.x, row: body.hitRect.y };
  expect(body.hitRect.w).toEqual(textW);

  expect({
    wrapStart: composerOffsetAtCell(draft, origin.col, origin.row + 1, origin, textW),
    pastBreak: composerOffsetAtCell(draft, origin.col + 10, origin.row, origin, textW),
    slice: draft.slice(composerOffsetAtCell(draft, origin.col, origin.row + 1, origin, textW)),
  }).toEqual({
    wrapStart: lines[1]!.start,
    pastBreak: lines[0]!.end,
    slice: "world",
  });

  const cjk = "a漢b";
  const aW = displayWidth("a");
  expect({
    wide: displayWidth("漢"),
    firstHalf: composerOffsetAtCell(cjk, aW, 0, { col: 0, row: 0 }, 8),
    secondHalf: composerOffsetAtCell(cjk, aW + 1, 0, { col: 0, row: 0 }, 8),
  }).toEqual({ wide: 2, firstHalf: 1, secondHalf: 1 });

  expect(composerOffsetAtCell(draft, 2, 1, { col: 5, row: 3 }, textW)).toEqual(0);

  const worldStart = lines[1]!.start;
  const geom = visualCaretGeometry(draft, worldStart, textW);
  expect(geom).toEqual({ line: 1, colInContent: 0, totalLines: 2 });
  expect(composerOffsetAtCell(draft, origin.col + geom.colInContent, origin.row + geom.line, origin, textW)).toEqual(
    worldStart,
  );

  const park = parkComposerCaret({
    draft,
    cursor: worldStart,
    frame,
    cols: outerW,
    rows: 8,
    termFocused: true,
  });
  expect(park).toEqual({
    show: true,
    row: origin.row + 1 + geom.line,
    col: origin.col + 1 + geom.colInContent,
  });
});

test("composer cell selection is an exclusive draft range", () => {
  const origin = { col: 3, row: 1 };
  const textW = 36;
  const draft = "hello world";
  const cell = (col: number) => ({ col, row: 1 });
  expect({
    hello: composerDraftSelectionFromCells(draft, cell(3), cell(7), origin, textW),
    rtl: composerDraftSelectionFromCells(draft, cell(7), cell(3), origin, textW),
    one: composerDraftSelectionFromCells(draft, cell(3), cell(3), origin, textW),
    pad: composerDraftSelectionFromCells(draft, cell(20), cell(22), origin, textW),
    throughPad: composerDraftSelectionFromCells(draft, cell(3), cell(20), origin, textW),
  }).toEqual({
    hello: { mark: 0, cursor: 5 },
    rtl: { mark: 5, cursor: 0 },
    one: { mark: 0, cursor: 1 },
    pad: null,
    throughPad: { mark: 0, cursor: 11 },
  });

  const cjk = "a漢b";
  expect(composerDraftSelectionFromCells(cjk, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 0, row: 0 }, 8)).toEqual({
    mark: 1,
    cursor: 2,
  });
});

test("parkComposerCaret hides when the frame has no composer hit", () => {
  const frame = layout({ type: "text", key: "demo", content: "hi", paintReady: true }, { w: 20, h: 8 });
  expect(
    parkComposerCaret({
      draft: "walk",
      cursor: 4,
      frame,
      cols: 20,
      rows: 8,
      termFocused: true,
    }),
  ).toEqual({ row: 1, col: 1, show: false });
});
