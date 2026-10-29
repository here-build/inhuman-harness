import { expect, test } from "vitest";

import { clear, createBuffer, put } from "../../buffer/index.js";
import { assemblePaintFrame } from "../paint_source.js";
import { rasterLayout, rasterPng, SCREENSHOT_NOW_MS } from "../raster.js";
import { bufferToPng, bufferToSvg } from "../screenshot.js";

test("rasterLayout is deterministic at the frozen clock", () => {
  const node = assemblePaintFrame({
    tape: { type: "text", content: "hello" },
    composer: { type: "text", content: "draft" },
    cols: 40,
    rows: 8,
  });
  const a = rasterLayout(node, 40, 8);
  const b = rasterLayout(node, 40, 8, { nowMs: SCREENSHOT_NOW_MS });
  expect(a).toEqual(b);
  expect(a).toHaveLength(8);
  expect(a.join("\n")).toContain("hello");
  expect(a.join("\n")).toContain("draft");
});

test("braille spinner is in the SVG, not a missing-glyph box", () => {
  const ink = { fgRgb: { r: 200, g: 200, b: 200 } };
  const a = createBuffer(4, 1);
  const b = createBuffer(4, 1);
  clear(a);
  clear(b);
  put(a, 0, 0, "⠋", ink);
  put(b, 0, 0, "⠏", ink);
  expect(bufferToSvg(a, "#111111")).toContain("⠋");
  // Same .notdef tofu for both codepoints would byte-match. Distinct dots must not.
  expect(bufferToPng(a, "#111111")).not.toEqual(bufferToPng(b, "#111111"));
});

test("rasterPng is a deterministic truecolor PNG", () => {
  const node = assemblePaintFrame({
    tape: { type: "text", content: "hello" },
    composer: { type: "text", content: "draft" },
    cols: 40,
    rows: 8,
  });
  const png = rasterPng(node, 40, 8);
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(rasterPng(node, 40, 8, { nowMs: SCREENSHOT_NOW_MS })).toEqual(png);
});
