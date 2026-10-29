import { expect, test } from "vitest";

import { imageLabel, intakePaste, PASTE_TEXT_MIN, textLabel } from "../prompt-blocks.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test("a short paste stays a string", () => {
  expect(intakePaste({ text: "see" })).toEqual(["see"]);
});

test("a paste at the threshold becomes a text block, and the label is not stored", () => {
  const body = "x".repeat(PASTE_TEXT_MIN);
  const [block] = intakePaste({ text: body });
  expect(block).toEqual({ kind: "text", body });
  expect(textLabel(block as { kind: "text"; body: string })).toBe("[Pasted text +0 lines]");
});

test("a path ending in png stays a string", () => {
  expect(intakePaste({ text: "/tmp/shot.png" })).toEqual(["/tmp/shot.png"]);
});

test("an image is a block of bytes, and the label is derived", () => {
  const [block] = intakePaste({ text: "ignored", image: { id: "1", mime: "image/png", bytes: png } });
  expect(block).toEqual({ kind: "image", mime: "image/png", bytes: png });
  if (typeof block === "string" || block.kind !== "image") throw new Error("expected an image block");
  expect(imageLabel(block, 1)).toBe("[Image #1]");
  expect(imageLabel(block)).toBe("[Image]");
});

test("nothing pasted is one empty string", () => {
  expect(intakePaste({})).toEqual([""]);
  expect(intakePaste({ text: "" })).toEqual([""]);
});
