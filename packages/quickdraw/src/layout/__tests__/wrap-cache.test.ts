import { expect, test } from "vitest";

import { layout, type Frame } from "../index.js";

function textLines(frame: Frame): string[] {
  return frame.paintOrder.flatMap((p) => p.paint.flatMap((op) => (op.kind === "text" ? op.lines : [])));
}

test("a later layout reuses the wrap of an unchanged text node", () => {
  let wide = 0;
  const measure = (text: string): number => {
    if (text.length > 40) wide += 1;
    return text.length;
  };
  const blob = Array.from({ length: 500 }, (_, i) => `L${String(i)} ${"x".repeat(50)}`).join("\n");
  const text = { type: "text" as const, key: "big", content: blob, whiteSpace: "pre-wrap" as const };
  const root = (scroll: number, w = 40) => ({
    type: "viewport" as const,
    id: "vp",
    key: "vp",
    overflowAnchor: "none" as const,
    scroll,
    style: { width: w, height: 8 },
    children: [text],
  });

  const first = layout(root(80), { w: 40, h: 8 }, { measure });
  const afterFirst = wide;
  const second = layout(root(160), { w: 40, h: 8 }, { measure });

  expect(afterFirst).toBeGreaterThan(0);
  expect(wide).toBe(afterFirst);
  expect(textLines(first).join("\n")).not.toEqual(textLines(second).join("\n"));

  const narrow = layout(root(0, 20), { w: 20, h: 8 }, { measure });
  expect(wide).toBeGreaterThan(afterFirst);
  expect(textLines(narrow).every((line) => line.length <= 20)).toBe(true);
  const afterNarrow = wide;
  layout(root(12, 20), { w: 20, h: 8 }, { measure });
  expect(wide).toBe(afterNarrow);

  text.content = `${blob}\nTAIL ${"y".repeat(50)}`;
  layout(root(0), { w: 40, h: 8 }, { measure });
  expect(wide).toBeGreaterThan(afterNarrow);
});

test("viewport totalH uses a stamped tape child without wrapping inner text", () => {
  let wraps = 0;
  const measure = (text: string): number => {
    if (text.includes("INNER")) wraps += 1;
    return text.length;
  };
  const blob = `INNER ${"x".repeat(80)}`;
  const frame = layout(
    {
      type: "viewport",
      id: "vp",
      key: "vp",
      overflowAnchor: "none",
      scroll: 0,
      style: { width: 40, height: 8 },
      children: [
        {
          type: "box",
          key: "tape",
          paintReady: true,
          measured: { w: 40, h: 200, atW: 40 },
          children: [{ type: "text", key: "t", content: blob, whiteSpace: "pre-wrap" }],
        },
      ],
    },
    { w: 40, h: 8 },
    { measure },
  );
  expect({
    maxScroll: frame.byKey.get("vp")?.element?.maxScroll,
    wraps: wraps > 0,
  }).toEqual({ maxScroll: 192, wraps: true });
});

test("a clipped column with sticky-top prompts does not wrap rows below the clip", () => {
  let below = 0;
  const measure = (text: string): number => {
    if (text.includes("BELOW_CLIP")) below += 1;
    return text.length;
  };
  const blob = Array.from({ length: 80 }, (_, i) => `BELOW_CLIP ${i} ${"x".repeat(40)}`).join("\n");
  const prompt = (key: string, label: string) => ({
    type: "box" as const,
    key,
    style: { sticky: "top" as const },
    children: [{ type: "text" as const, key: `${key}:t`, content: label }],
  });
  const frame = layout(
    {
      type: "box",
      key: "col",
      style: { width: 40, height: 6, overflow: "hidden" },
      children: [
        prompt("p1", "PROMPT"),
        { type: "text", key: "vis", content: "VISIBLE LINE" },
        ...Array.from({ length: 12 }, (_, i) => ({
          type: "text" as const,
          key: `fill${i}`,
          content: `row ${i}`,
        })),
        prompt("p2", "LATER"),
        { type: "text", key: "low", content: blob, whiteSpace: "pre-wrap" },
      ],
    },
    { w: 40, h: 6 },
    { measure },
  );
  expect({
    below,
    visible: textLines(frame).join("\n").includes("VISIBLE"),
    later: textLines(frame).join("\n").includes("LATER"),
    dumped: textLines(frame).join("\n").includes("BELOW_CLIP"),
  }).toEqual({ below: 0, visible: true, later: false, dumped: false });
});
