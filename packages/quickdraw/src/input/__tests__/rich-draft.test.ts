import { expect, test } from "vitest";

import {
  backspaceRich,
  copyRich,
  deleteRich,
  insertRich,
  killRich,
  moveRich,
  pasteRich,
  selectAllRich,
  type RichState,
} from "../rich-draft.js";

const shot = { kind: "image" as const, id: "1", clipboard: "[Image #1]", submit: "image:1" };
const file = { kind: "mention" as const, id: "a", clipboard: "@src/a.ts", submit: "file:src/a.ts" };

function state(runs: RichState["runs"], cursor: RichState["cursor"], mark: RichState["mark"] = null): RichState {
  return { runs, cursor, mark };
}

const mixed = () => state(["see ", shot, " and ", file], { run: 0, offset: 0 });

test("a caret inside a chip does not exist", () => {
  const atChip = moveRich(state(["see ", shot], { run: 0, offset: 4 }), "right");
  expect(atChip.cursor).toEqual({ run: 2, offset: 0 });
  expect(moveRich(atChip, "left").cursor).toEqual({ run: 0, offset: 4 });
});

test("backspace and delete on a chip boundary remove the whole chip", () => {
  const before = state(["see ", shot, " tail"], { run: 2, offset: 0 });
  const after = state(["see ", shot, " tail"], { run: 0, offset: 4 });
  expect(backspaceRich(before).runs).toEqual(["see  tail"]);
  expect(deleteRich(after).runs).toEqual(["see  tail"]);
});

test("shift-right entering a chip takes the chip whole", () => {
  const next = moveRich(state(["see ", shot, "!"], { run: 0, offset: 4 }), "right", true);
  expect(next.cursor).toEqual({ run: 2, offset: 0 });
  expect(copyRich(next).clipboard).toEqual([shot]);
});

test("a text-chip-text slice round-trips through copy and paste", () => {
  const selected = state(["see ", shot, " end"], { run: 2, offset: 4 }, { run: 0, offset: 0 });
  const copied = copyRich(selected);
  expect(copied.clipboard).toEqual(["see ", shot, " end"]);
  expect(copied.submit).toEqual(["see ", "image:1", " end"]);
  const pasted = pasteRich(state([""], { run: 0, offset: 0 }), copied.clipboard);
  expect(pasted.runs).toEqual(["see ", shot, " end"]);
});

test("pasting a string over a selection replaces it with one text run", () => {
  const selected = state(["see ", shot, " end"], { run: 2, offset: 4 }, { run: 0, offset: 0 });
  expect(pasteRich(selected, "no").runs).toEqual(["no"]);
});

test("adjacent text runs merge after an edit", () => {
  const edited = insertRich(state(["ab", "cd"], { run: 0, offset: 2 }), "X");
  expect(edited.runs).toEqual(["abXcd"]);
});

test("a word motion does not enter a chip", () => {
  const before = state(["see ", shot, " tail"], { run: 2, offset: 0 });
  expect(moveRich(before, "word_left").cursor).toEqual({ run: 0, offset: 0 });
  expect(moveRich(state(["see ", shot], { run: 0, offset: 0 }), "word_right").cursor).toEqual({ run: 0, offset: 4 });
});

test("empty selection copies nothing", () => {
  expect(copyRich(mixed())).toEqual({ clipboard: [], submit: [] });
});

test("copy is refused when the composer is not focused", () => {
  const selected = state(["see ", shot], { run: 2, offset: 0 }, { run: 0, offset: 0 });
  expect(copyRich(selected, { focused: false })).toEqual({ clipboard: [], submit: [] });
});

test("select all marks the start and parks past the last run", () => {
  expect(selectAllRich(state(["ab\ncd"], { run: 0, offset: 1 }))).toEqual(
    state(["ab\ncd"], { run: 0, offset: 5 }, { run: 0, offset: 0 }),
  );
  expect(selectAllRich(state(["ab\n", shot, "x"], { run: 2, offset: 0 }))).toEqual(
    state(["ab\n", shot, "x"], { run: 2, offset: 1 }, { run: 0, offset: 0 }),
  );
  const trailing = state(["ab\n", shot], { run: 0, offset: 1 });
  expect(selectAllRich(trailing).cursor).toEqual({ run: 2, offset: 0 });
  expect(selectAllRich(trailing).mark).toEqual({ run: 0, offset: 0 });
  expect(selectAllRich(state([""], { run: 0, offset: 0 }))).toEqual(state([""], { run: 0, offset: 0 }));
});

test("home and end stay on the hard line and snap off a chip", () => {
  expect(moveRich(state(["ab\ncd"], { run: 0, offset: 4 }), "home").cursor).toEqual({ run: 0, offset: 3 });
  expect(moveRich(state(["ab\ncd"], { run: 0, offset: 4 }), "end").cursor).toEqual({ run: 0, offset: 5 });
  const lined = state(["ab\n", shot, "x"], { run: 2, offset: 0 });
  expect(moveRich(lined, "home").cursor).toEqual({ run: 0, offset: 3 });
  expect(moveRich(lined, "end").cursor).toEqual({ run: 2, offset: 1 });
});

test("line up and line down keep the column across a newline", () => {
  const text = state(["hello\nworld"], { run: 0, offset: 8 });
  expect(moveRich(text, "line_up").cursor).toEqual({ run: 0, offset: 2 });
  expect(moveRich(state(["hello\nworld"], { run: 0, offset: 2 }), "line_down").cursor).toEqual({
    run: 0,
    offset: 8,
  });
});

test("kill word stays inside the current text run", () => {
  expect(killRich(state(["hello world"], { run: 0, offset: 11 }), "word").runs).toEqual(["hello "]);
  const tailed = state(["see ", shot, " tail"], { run: 2, offset: 5 });
  expect(killRich(tailed, "word").runs).toEqual(["see ", shot, " "]);
});

test("kill to a hard-line edge does not take a chip outside that text", () => {
  const lined = state(["ab\n", shot, "x"], { run: 2, offset: 1 });
  expect(killRich(lined, "to_start").runs).toEqual(["ab\n", shot]);
  expect(killRich(state(["ab\n", shot, "xy"], { run: 2, offset: 0 }), "to_end").runs).toEqual(["ab\n", shot]);
  const selected = state(["see ", shot, " tail"], { run: 2, offset: 5 }, { run: 0, offset: 0 });
  expect(killRich(selected, "word").runs).toEqual([""]);
});
