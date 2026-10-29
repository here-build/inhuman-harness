import { expect, test } from "vitest";

import { createBuffer } from "../../buffer/index.js";
import { elementAt, layout, paintFrame, type LayoutNode } from "../index.js";

test("viewport floors the last child; sticky-bottom stays in clip", () => {
  const short = layout(
    {
      type: "viewport",
      id: "vp",
      overflowAnchor: "none",
      children: [
        { type: "text", content: "TOP", key: "top" },
        { type: "text", content: "BOT", key: "bot" },
      ],
    },
    { w: 8, h: 6 },
  );
  const tall = layout(
    {
      type: "viewport",
      id: "vp",
      overflowAnchor: "none",
      scroll: 0,
      children: [
        {
          type: "box",
          key: "head",
          children: Array.from({ length: 10 }, (_, i) => ({
            type: "text" as const,
            content: `L${i}`,
            key: `l${i}`,
          })),
        },
        {
          type: "box",
          key: "tail",
          style: { sticky: "bottom" },
          children: [{ type: "text", content: "STICK", key: "stick" }],
        },
      ],
    },
    { w: 8, h: 5 },
  );
  expect({
    floor: {
      top: short.byKey.get("top")?.hitRect.y,
      bot: short.byKey.get("bot")?.hitRect.y,
    },
    stick: tall.byKey.get("stick")?.hitRect.y,
  }).toEqual({
    floor: { top: 0, bot: 5 },
    stick: 4,
  });
});

function scrollingColumn(scroll: number, children: LayoutNode[], h: number) {
  return layout(
    {
      type: "viewport",
      id: "vp",
      key: "vp",
      overflowAnchor: "none",
      scroll,
      children: [{ type: "box", key: "col", userSelect: "text", children }],
    },
    { w: 12, h },
  );
}

function row(key: string, content = key): LayoutNode {
  return { type: "text", key, content };
}

test("sticky top pins a prompt that scrolled above the tape and covers later rows", () => {
  const prompt: LayoutNode = {
    type: "box",
    key: "prompt",
    style: { sticky: "top" },
    children: [row("q", "PROMPT")],
  };
  const children: LayoutNode[] = [
    row("a0"),
    row("a1"),
    row("a2"),
    row("a3"),
    prompt,
    row("after", "AFTER"),
    row("b0"),
    row("b1"),
    row("b2"),
    row("b3"),
  ];
  const pinned = scrollingColumn(5, children, 5);
  const inFlow = scrollingColumn(2, children, 5);
  const buf = createBuffer(12, 5);
  paintFrame(pinned, buf);
  let top = "";
  for (let x = 0; x < 12; x++) top += buf.cells[x]?.ch ?? " ";
  expect({
    inFlow: elementAt(inFlow, 0, 0)?.key,
    pin: elementAt(pinned, 0, 0)?.key,
    promptY: pinned.byKey.get("q")?.hitRect.y,
    top: top.trimEnd(),
  }).toEqual({
    inFlow: "a2",
    pin: "q",
    promptY: 0,
    top: "PROMPT",
  });
});

function turnPrompt(key: string, lines: readonly string[]): LayoutNode {
  return {
    type: "box",
    key,
    style: { sticky: "top" },
    children: lines.map((content, i) => row(`${key}${i}`, content)),
  };
}

test("the pin starts when the prompt's top edge meets the clip", () => {
  const body = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => row(`${prefix}${i}`));
  const children: LayoutNode[] = [
    turnPrompt("A", ["A0", "A1", "A2"]),
    ...body("a", 8),
    turnPrompt("B", ["B0", "B1"]),
    ...body("b", 6),
  ];
  // A is 3 rows starting at y=0. One row of scroll puts its top above the
  // clip while the rest is still in view — it must already be pinned, not
  // riding until the last row leaves.
  const just = scrollingColumn(1, children, 5);
  const riding = scrollingColumn(2, children, 5);
  // B starts at natural y=11. Its top meets the clip at scroll 11; until
  // then A stays pinned and only slides up as far as B pushes it.
  const arriving = scrollingColumn(8, children, 5);
  const taken = scrollingColumn(9, children, 5);
  expect({
    just: elementAt(just, 0, 0)?.key,
    justY: just.byKey.get("A0")?.hitRect.y,
    riding: elementAt(riding, 0, 0)?.key,
    ridingAnswer: elementAt(riding, 0, 3)?.key,
    arriving: elementAt(arriving, 0, 0)?.key,
    taken: elementAt(taken, 0, 0)?.key,
  }).toEqual({
    just: "A0",
    justY: 0,
    riding: "A0",
    ridingAnswer: "a2",
    arriving: "A0",
    // A is squeezed to one row once it has left, so B pushes that row out
    // a turn earlier than a full-height pin would.
    taken: "a6",
  });
});

/**
 * A turn taller than the screen still pins, squeezed to its first row.
 * Full height would cover every row and bury its own answer; scrolling away
 * would drop the prompt the visible lines belong to.
 */
test("a sticky turn taller than the viewport squeezes to its first row", () => {
  const tall: LayoutNode[] = [
    turnPrompt("A", ["A0", "A1", "A2", "A3", "A4", "A5", "A6"]),
    ...Array.from({ length: 10 }, (_, i) => row(`a${i}`)),
    turnPrompt("B", ["B0"]),
  ];
  // A's last row sits on clip.y, so A is fully above the clip. It pins as
  // one row; the answer owns the rest.
  const pastEnd = scrollingColumn(8, tall, 5);
  // The clip still cuts A → the first row is already the pin, not a partial
  // later row riding in flow.
  const midTurn = scrollingColumn(4, tall, 5);
  expect({
    pastEndTop: elementAt(pastEnd, 0, 0)?.key,
    pastEndAnswer: pastEnd.byKey.get("a1")?.hitRect.y,
    pastEndA1: elementAt(pastEnd, 0, 1)?.key,
    midTurnTop: elementAt(midTurn, 0, 0)?.key,
    midTurnAnswer: elementAt(midTurn, 0, 1)?.key,
  }).toEqual({
    pastEndTop: "A0",
    pastEndAnswer: 0,
    pastEndA1: "a2",
    midTurnTop: "A4",
    midTurnAnswer: "A5",
  });
});

/** The pin still lands for a turn that fits — with room for its answer below. */
test("a sticky turn that fits keeps pinning and leaves the answer visible", () => {
  const fits: LayoutNode[] = [
    turnPrompt("A", ["A0", "A1"]),
    ...Array.from({ length: 10 }, (_, i) => row(`a${i}`)),
    turnPrompt("B", ["B0"]),
  ];
  const pinned = scrollingColumn(4, fits, 5);
  expect({
    pin: elementAt(pinned, 0, 0)?.key,
    answer: pinned.byKey.get("a3")?.hitRect.y,
  }).toEqual({ pin: "A0", answer: 1 });
});

/** Exactly the clip height is the same squeeze one row earlier. */
test("a sticky turn exactly as tall as the viewport squeezes to its first row", () => {
  const exact: LayoutNode[] = [
    turnPrompt("A", ["A0", "A1", "A2", "A3", "A4"]),
    ...Array.from({ length: 6 }, (_, i) => row(`a${i}`)),
  ];
  const pastEnd = scrollingColumn(5, exact, 5);
  const buf = createBuffer(12, 5);
  paintFrame(pastEnd, buf);
  let top = "";
  for (let x = 0; x < 12; x++) top += buf.cells[x]?.ch ?? " ";
  expect({
    top: elementAt(pastEnd, 0, 0)?.key,
    next: elementAt(pastEnd, 0, 1)?.key,
    answer: pastEnd.byKey.get("a0")?.hitRect.y,
    painted: top.trimEnd(),
  }).toEqual({ top: "A0", next: "a1", answer: 0, painted: "A0" });
});
