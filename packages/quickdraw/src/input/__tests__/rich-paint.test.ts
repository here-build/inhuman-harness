import { expect, test } from "vitest";

import type { RichChip, RichRun } from "../rich-draft.js";
import { richPaint } from "../rich-paint.js";

const shot: RichChip = { kind: "image", id: "1", clipboard: "[Image #1]", submit: "image:1" };
const file: RichChip = { kind: "mention", id: "a", clipboard: "@src/a.ts", submit: "file:src/a.ts" };
const empty: RichChip = { kind: "mention", id: "z", clipboard: "", submit: "" };

function cover(text: string, label: string, id: string) {
  const start = text.indexOf(label);
  return { start, end: start + label.length, id };
}

test("text runs stay verbatim and chips paint as their clipboard labels", () => {
  const runs: RichRun[] = ["see ", shot, " and ", file];
  const painted = richPaint(runs);
  const text = "see " + "[Image #1]" + " and " + "@src/a.ts";
  expect(painted.text).toBe(text);
  expect(painted.spans).toEqual([cover(text, "[Image #1]", "1"), cover(text, "@src/a.ts", "a")]);
});

test("a chip with an empty clipboard emits no characters and no span", () => {
  expect(richPaint(["ab", empty, "cd"])).toEqual({ text: "abcd", spans: [] });
});

test("a text run containing a newline stays one run and the newline remains", () => {
  const runs: RichRun[] = ["line\nstill"];
  expect(richPaint(runs)).toEqual({ text: "line\nstill", spans: [] });
  expect(runs).toEqual(["line\nstill"]);
});
