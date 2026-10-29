import { expect, test } from "vitest";

import { intakePaste } from "../rich-intake.js";

test("an image paste is one chip of bytes and drops text", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  expect(intakePaste({ text: "ignored.png", image: { id: "1", mime: "image/png", bytes }, index: 1 })).toEqual([
    { kind: "image", id: "clip", clipboard: "", submit: "image:image/png:3" },
  ]);
});

test("text of any length stays a string run", () => {
  const text = "x".repeat(10_000);
  expect(intakePaste({ text })).toEqual([text]);
});

test("a path ending in .png is still text", () => {
  expect(intakePaste({ text: "/tmp/shot.png" })).toEqual(["/tmp/shot.png"]);
});

test("absent text and image, or empty text, is one empty string", () => {
  expect(intakePaste({})).toEqual([""]);
  expect(intakePaste({ text: "" })).toEqual([""]);
});
