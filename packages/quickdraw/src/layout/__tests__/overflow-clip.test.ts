import { expect, test } from "vitest";

import { createBuffer } from "../../buffer/index.js";
import { elementAt, layout, measureNode, paintFrame, type Frame } from "../index.js";
import { visualCaretGeometry } from "../visual_draft.js";

function textLines(frame: Frame): string[] {
  return frame.paintOrder.flatMap((p) => p.paint.flatMap((op) => (op.kind === "text" ? op.lines : [])));
}

function cellCh(buf: ReturnType<typeof createBuffer>, x: number, y: number): string {
  return buf.cells[y * buf.width + x]!.ch;
}

test("overflow clip: viewport slice, tightness, hits, newline caret", () => {
  const topClip = textLines(
    layout(
      {
        type: "viewport",
        id: "vp",
        overflowAnchor: "none",
        scroll: 1,
        children: [{ type: "text", content: "aaaa bbbb cccc dddd eeee", key: "tall" }],
      },
      { w: 4, h: 2 },
    ),
  );
  expect(topClip).toEqual(["bbbb", "cccc"]);

  const padLeak = layout(
    {
      type: "box",
      style: { height: 3, padding: { t: 2 }, overflow: "hidden" },
      children: [{ type: "text", content: "SECRET", key: "s" }],
    },
    { w: 10, h: 1 },
  );
  expect(textLines(padLeak).join("")).not.toContain("SECRET");

  const yHidden = layout(
    {
      type: "box",
      key: "tight",
      style: { height: 1, overflowY: "hidden" },
      children: [{ type: "text", content: "AAAA\nBBBB", key: "t" }],
    },
    { w: 8, h: 1 },
  );
  const yBuf = createBuffer(8, 1);
  paintFrame(yHidden, yBuf);
  expect(cellCh(yBuf, 0, 0)).toEqual("A");

  const autoBox = layout(
    {
      type: "box",
      style: { height: 1, overflow: "auto" },
      children: [{ type: "text", content: "XXXX\nYYYY", key: "a" }],
    },
    { w: 8, h: 1 },
  );
  const autoBuf = createBuffer(8, 1);
  paintFrame(autoBox, autoBuf);
  expect(cellCh(autoBuf, 0, 0)).toEqual("X");

  const bordered = layout(
    {
      type: "viewport",
      id: "vp",
      overflowAnchor: "none",
      scroll: 0,
      children: [
        {
          type: "box",
          key: "b",
          style: { border: true, height: 5, width: 6 },
        },
      ],
    },
    { w: 8, h: 2 },
  );
  const bBuf = createBuffer(8, 2);
  paintFrame(bordered, bBuf);
  expect(cellCh(bBuf, 0, 0)).toEqual("┌");
  expect(cellCh(bBuf, 0, 1)).toEqual("│");

  const hit = elementAt(yHidden, 0, 5);
  expect(hit?.meta.element?.kind === "text").toEqual(false);

  expect(visualCaretGeometry("ab\n", 2, 40)).toEqual({
    line: 0,
    colInContent: 2,
    totalLines: 2,
  });
  expect(visualCaretGeometry("ab\ncd", 2, 40)).toEqual({
    line: 0,
    colInContent: 2,
    totalLines: 2,
  });
  expect(visualCaretGeometry("ab\n", 3, 40)).toEqual({
    line: 1,
    colInContent: 0,
    totalLines: 2,
  });
});

test("measured stamp and clipped box children skip wrap", () => {
  let offscreen = 0;
  const measure = (text: string): number => {
    if (text.includes("BBBB") || text.includes("CCCC")) offscreen += 1;
    return text.length;
  };
  const unit = (key: string, mark: string) => ({
    type: "box" as const,
    key,
    paintReady: true as const,
    measured: { w: 8, h: 20, atW: 8 },
    children: [{ type: "text" as const, key: `${key}:t`, content: `${mark}\n`.repeat(20) }],
  });
  const frame = layout(
    {
      type: "viewport",
      id: "vp",
      overflowAnchor: "none",
      scroll: 0,
      children: [
        {
          type: "box",
          key: "tape",
          children: [unit("a", "AAAA"), unit("b", "BBBB"), unit("c", "CCCC")],
        },
      ],
    },
    { w: 8, h: 4 },
    { measure },
  );
  expect({
    visible: textLines(frame).some((l) => l.includes("AAAA")),
    b: frame.byKey.has("b"),
    offscreen,
  }).toEqual({ visible: true, b: false, offscreen: 0 });
});

test("measured stamp is width-tagged", () => {
  const node = {
    type: "text" as const,
    content: "hello world hello world",
    measured: { w: 20, h: 1, atW: 20 },
  };
  expect({
    hit: measureNode(node, 20, 100),
    miss: measureNode(node, 8, 100).h > 1,
  }).toEqual({ hit: { w: 20, h: 1 }, miss: true });
});
