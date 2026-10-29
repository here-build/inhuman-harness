import { expect, test } from "vitest";

import { richPointAtCell } from "../rich-hit.js";

const shot = { kind: "image" as const, id: "1", clipboard: "[Image #1]", submit: "image:1" };

test("first cell of a chip label lands before the chip", () => {
  expect(richPointAtCell(["see ", shot], 80, 0, 4)).toEqual({ run: 0, offset: 4 });
});

test("last cell of a chip label lands after the chip", () => {
  const labelWidth = "[Image #1]".length;
  expect(richPointAtCell(["see ", shot], 80, 0, 4 + labelWidth - 1)).toEqual({ run: 2, offset: 0 });
});

test("first character of ordinary text lands at the start of that run", () => {
  expect(richPointAtCell(["see ", shot], 80, 0, 0)).toEqual({ run: 0, offset: 0 });
});

test("either half of a wide grapheme lands before it", () => {
  expect(richPointAtCell(["見"], 80, 0, 0)).toEqual({ run: 0, offset: 0 });
  expect(richPointAtCell(["見"], 80, 0, 1)).toEqual({ run: 0, offset: 0 });
});

test("a wrapped second line starts at the display offset of that line", () => {
  const text = "abcdefghij";
  expect(richPointAtCell([text], 4, 1, 0)).toEqual({ run: 0, offset: 4 });
});
