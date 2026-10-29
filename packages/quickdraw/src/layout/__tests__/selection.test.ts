import { expect, test } from "vitest";

import { containRegionAt, layout } from "../engine.js";
import {
  clearSelection,
  expandToLineAt,
  expandToWordAt,
  extendSelection,
  hasCopyableExtent,
  isCollapsed,
  rowRange,
  selectionRect,
  startSelection,
  streamEndpoints,
  wordBoundsOnRow,
} from "../selection.js";
import { createGestureMachine, type GestureEvent } from "../selection_gesture.js";

function press(col: number, row: number, mods: Partial<GestureEvent> = {}): GestureEvent {
  return { kind: "press", col, row, tMs: mods.tMs ?? 0, ...mods };
}
function release(col: number, row: number, tMs = 0): GestureEvent {
  return { kind: "release", col, row, tMs };
}
function drag(col: number, row: number, tMs = 0): GestureEvent {
  return { kind: "drag", col, row, tMs };
}

test("selection gesture walk", () => {
  const click = createGestureMachine();
  const tap = createGestureMachine();
  tap.handle(press(5, 3));
  const zero = createGestureMachine();
  zero.handle(press(2, 1));
  expect({
    press: click.handle(press(5, 3)).selection,
    sameCell: tap.handle(release(5, 3)),
    held: tap.selection(),
    zeroMove: zero.handle(drag(2, 1)).selection,
  }).toEqual({
    press: null,
    sameCell: { selection: null, copyReady: false },
    held: null,
    zeroMove: null,
  });

  const dismiss = createGestureMachine();
  dismiss.handle(press(2, 1));
  dismiss.handle(drag(8, 4));
  const dragged = dismiss.handle(release(8, 4));
  expect({
    afterDrag: dragged.selection && {
      anchor: dragged.selection.anchor,
      active: dragged.selection.active,
    },
    copyReady: dragged.copyReady,
    clickAway: dismiss.handle(press(15, 7)).selection,
    afterRelease: dismiss.handle(release(15, 7)).selection,
  }).toEqual({
    afterDrag: { anchor: { col: 2, row: 1 }, active: { col: 8, row: 4 } },
    copyReady: true,
    clickAway: null,
    afterRelease: null,
  });

  const fresh = createGestureMachine();
  fresh.handle(press(2, 1));
  fresh.handle(drag(8, 4));
  fresh.handle(release(8, 4));
  expect({
    clearOnPress: fresh.handle(press(20, 10, { tMs: 1000 })).selection,
    drag: fresh.handle(drag(25, 12, 1001)).selection,
  }).toMatchObject({
    clearOnPress: null,
    drag: {
      anchor: { col: 20, row: 10 },
      active: { col: 25, row: 12 },
    },
  });

  const origin = createGestureMachine();
  origin.handle(press(2, 1));
  expect(origin.handle(drag(8, 4)).selection).toMatchObject({
    anchor: { col: 2, row: 1 },
    active: { col: 8, row: 4 },
    granularity: "char",
  });

  const back = createGestureMachine();
  back.handle(press(8, 4));
  expect(back.handle(drag(2, 1)).selection).toMatchObject({
    anchor: { col: 8, row: 4 },
    active: { col: 2, row: 1 },
  });
  expect(back.handle(release(2, 1))).toMatchObject({
    copyReady: true,
    selection: { active: { col: 2, row: 1 } },
  });

  const wordRow = ["a", " ", "h", "e", "l", "l", "o", " ", "z"];
  const word = createGestureMachine({
    getRowCells: (r) => (r === 3 ? wordRow : null),
  });
  word.handle(press(5, 3));
  expect(word.selection()).toEqual(null);
  expect(word.handle(press(5, 3)).selection).toMatchObject({
    granularity: "word",
    anchor: { col: 2, row: 3 },
    active: { col: 6, row: 3 },
  });
  expect(word.handle(release(5, 3)).copyReady).toEqual(true);

  const noCells = createGestureMachine();
  noCells.handle(press(5, 3));
  expect(noCells.handle(press(5, 3)).selection).toEqual(null);

  const triple = createGestureMachine({ viewportW: 20 });
  triple.handle(press(5, 3));
  triple.handle(press(5, 3));
  expect(triple.handle(press(5, 3)).selection).toMatchObject({
    granularity: "line",
    anchor: { col: 0, row: 3 },
    active: { col: 19, row: 3 },
  });

  const windowed = createGestureMachine({
    getRowCells: () => ["h", "e", "l", "l", "o"],
  });
  windowed.handle(press(2, 0));
  windowed.handle(press(2, 0));
  expect(windowed.selection()?.granularity).toEqual("word");
  expect(windowed.handle({ kind: "press", col: 2, row: 0, tMs: 1000 }).selection).toEqual(null);

  const tolerate = createGestureMachine({
    getRowCells: () => [
      "h",
      "e",
      "l",
      "l",
      "o",
      " ",
      "x",
      "x",
      "x",
      "x",
      "x",
      "x",
      "x",
      "x",
      "x",
      "x",
      "x",
      "x",
      "x",
      "x",
      "x",
    ],
  });
  tolerate.handle(press(2, 0));
  tolerate.handle(press(2, 0));
  expect(tolerate.handle(drag(20, 0)).selection).toMatchObject({
    granularity: "char",
    anchor: { col: 2, row: 0 },
    active: { col: 20, row: 0 },
  });

  const alt = createGestureMachine();
  alt.handle(press(2, 1, { alt: true }));
  expect(alt.selection()).toEqual(null);
  expect(alt.handle(drag(8, 4)).selection).toMatchObject({
    granularity: "rect",
    anchor: { col: 2, row: 1 },
    active: { col: 8, row: 4 },
  });

  const shift = createGestureMachine();
  shift.handle(press(2, 1));
  shift.handle(drag(5, 3));
  shift.handle(release(5, 3));
  expect(shift.handle(press(10, 6, { shift: true })).selection).toMatchObject({
    anchor: { col: 2, row: 1 },
    active: { col: 10, row: 6 },
  });

  const edge = createGestureMachine({ viewportH: 10 });
  edge.handle(press(5, 8));
  expect({
    down: edge.handle(drag(5, 12)).scroll,
    up: (() => {
      const m = createGestureMachine({ viewportH: 10 });
      m.handle(press(5, 2));
      return m.handle(drag(5, -2)).scroll;
    })(),
    inside: (() => {
      const m = createGestureMachine({ viewportH: 10 });
      m.handle(press(5, 3));
      return m.handle(drag(5, 7)).scroll;
    })(),
  }).toEqual({ down: "down", up: "up", inside: undefined });

  const frame = layout({ type: "chrome_frame", key: "composer", width: 30, draft: "aaa\nbbb\nccc" }, { w: 40, h: 10 });
  const body = frame.byKey.get("composer")!;
  const confined = createGestureMachine({
    containAt: (cell) => containRegionAt(frame, cell.col, cell.row),
  });
  confined.handle(press(body.hitRect.x + 2, body.hitRect.y));
  expect(confined.handle(drag(50, 20)).selection).toMatchObject({
    contain: body.hitRect,
    anchor: { col: body.hitRect.x + 2, row: body.hitRect.y },
    active: {
      col: body.hitRect.x + body.hitRect.w - 1,
      row: body.hitRect.y + body.hitRect.h - 1,
    },
  });

  const outside = createGestureMachine({
    containAt: (cell) => containRegionAt(frame, cell.col, cell.row),
  });
  outside.handle(press(0, 0));
  const free = outside.handle(drag(40, 8));
  expect({ contain: free.selection?.contain, active: free.selection?.active }).toEqual({
    contain: undefined,
    active: { col: 40, row: 8 },
  });

  const cleared = createGestureMachine();
  cleared.handle(press(5, 3));
  cleared.handle(drag(8, 4));
  expect(cleared.clear()).toEqual(null);

  const collapsed = startSelection({ col: 5, row: 3 });
  expect({
    anchor: collapsed.anchor,
    active: collapsed.active,
    granularity: collapsed.granularity,
    collapsed: isCollapsed(collapsed),
    copyable: hasCopyableExtent(collapsed),
    extendNull: extendSelection(null, { col: 1, row: 1 }),
    clear: clearSelection(),
  }).toEqual({
    anchor: { col: 5, row: 3 },
    active: { col: 5, row: 3 },
    granularity: "char",
    collapsed: true,
    copyable: false,
    extendNull: null,
    clear: null,
  });

  const extended = extendSelection(collapsed, { col: 10, row: 7 })!;
  expect({
    anchor: extended.anchor,
    active: extended.active,
    collapsed: isCollapsed(extended),
    copyable: hasCopyableExtent(extended),
  }).toEqual({
    anchor: { col: 5, row: 3 },
    active: { col: 10, row: 7 },
    collapsed: false,
    copyable: true,
  });

  const lineSel = startSelection({ col: 5, row: 3 }, "line");
  expect({ collapsed: isCollapsed(lineSel), copyable: hasCopyableExtent(lineSel) }).toEqual({
    collapsed: true,
    copyable: true,
  });

  const stream = extendSelection(startSelection({ col: 2, row: 0 }), { col: 5, row: 2 })!;
  const backward = extendSelection(startSelection({ col: 5, row: 2 }), { col: 2, row: 0 })!;
  const rect = extendSelection(startSelection({ col: 2, row: 0 }, "rect"), {
    col: 5,
    row: 2,
  })!;
  const lineSpan = extendSelection(startSelection({ col: 2, row: 1 }, "line"), {
    col: 8,
    row: 4,
  })!;
  const single = extendSelection(startSelection({ col: 2, row: 1 }), { col: 8, row: 1 })!;
  expect({
    stream: [0, 1, 2, 3].map((r) => rowRange(stream, r, 10)),
    backward: [0, 1, 2].map((r) => rowRange(backward, r, 10)),
    endpoints: streamEndpoints(stream),
    streamEnvelope: selectionRect(stream, 10),
    single: { range: rowRange(single, 1, 20), miss: rowRange(single, 0, 20), rect: selectionRect(single, 20) },
    rect: [0, 1, 2].map((r) => rowRange(rect, r, 10)),
    line: [0, 2, 4].map((r) => rowRange(lineSpan, r, 20)),
  }).toEqual({
    stream: [[2, 9], [0, 9], [0, 5], null],
    backward: [
      [2, 9],
      [0, 9],
      [0, 5],
    ],
    endpoints: { start: { col: 2, row: 0 }, end: { col: 5, row: 2 } },
    streamEnvelope: { x: 0, y: 0, w: 10, h: 3 },
    single: { range: [2, 8], miss: null, rect: { x: 2, y: 1, w: 7, h: 1 } },
    rect: [
      [2, 5],
      [2, 5],
      [2, 5],
    ],
    line: [null, [0, 19], [0, 19]],
  });

  const letters = ["a", "b", " ", "h", "e", "l", "l", "o", "_", "1", " ", "c", "d"];
  const foo = ["x", " ", "f", "o", "o", " ", "y"];
  const wordSel = expandToWordAt({ col: 3, row: 2 }, (r) => (r === 2 ? foo : null));
  const lineAt = expandToLineAt({ col: 5, row: 3 }, 20);
  expect({
    inside: wordBoundsOnRow(letters, 5),
    start: wordBoundsOnRow(letters, 3),
    end: wordBoundsOnRow(letters, 9),
    sep: wordBoundsOnRow(["a", " ", "b"], 1),
    word: {
      granularity: wordSel.granularity,
      anchor: wordSel.anchor,
      active: wordSel.active,
      copyable: hasCopyableExtent(wordSel),
    },
    line: {
      granularity: lineAt.granularity,
      anchor: lineAt.anchor,
      active: lineAt.active,
      cols: rowRange(lineAt, 3, 20),
    },
  }).toEqual({
    inside: [3, 9],
    start: [3, 9],
    end: [3, 9],
    sep: [1, 1],
    word: {
      granularity: "word",
      anchor: { col: 2, row: 2 },
      active: { col: 4, row: 2 },
      copyable: true,
    },
    line: {
      granularity: "line",
      anchor: { col: 0, row: 3 },
      active: { col: 19, row: 3 },
      cols: [0, 19],
    },
  });
});

test("confined drag keeps its range when the pointer leaves the input", () => {
  // Single-row composer body at row 1, cols 3..10; press at col 5, drag to col 8.
  const frame = layout({ type: "chrome_frame", key: "composer", width: 12, draft: "abcdefgh" }, { w: 20, h: 6 });
  const machine = () => createGestureMachine({ containAt: (cell) => containRegionAt(frame, cell.col, cell.row) });

  // Pointer drifts off the input in the anchor's column, then button-up.
  const anchorCol = machine();
  anchorCol.handle(press(5, 1));
  anchorCol.handle(drag(8, 1));
  const offAnchor = anchorCol.handle(drag(5, 4));
  const released = anchorCol.handle(release(5, 4));
  expect({
    offAnchorActive: offAnchor.selection?.active,
    released: released.selection && { anchor: released.selection.anchor, active: released.selection.active },
  }).toEqual({
    offAnchorActive: { col: 8, row: 1 },
    released: { anchor: { col: 5, row: 1 }, active: { col: 8, row: 1 } },
  });

  // Off-box elsewhere still clamps onto the input (drag past the right edge).
  const pastEdge = machine();
  pastEdge.handle(press(5, 1));
  pastEdge.handle(drag(8, 1));
  const far = pastEdge.handle(drag(40, 4));
  expect(far.selection && { anchor: far.selection.anchor, active: far.selection.active }).toEqual({
    anchor: { col: 5, row: 1 },
    active: { col: 10, row: 1 },
  });
});
