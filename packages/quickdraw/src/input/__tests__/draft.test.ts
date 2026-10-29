import { expect, test } from "vitest";

import {
  applyDraftOp,
  backspaceDraft,
  deleteDraft,
  insertDraft,
  moveDraft,
  selectionRange,
  type DraftOp,
} from "../draft.js";

test("draft ops lifecycle", () => {
  expect(insertDraft({ draft: "hello", cursor: 5, mark: 0 }, "x")).toEqual({
    draft: "x",
    cursor: 1,
    mark: null,
  });

  const selected = { draft: "hello", cursor: 5, mark: 2 };
  expect({
    backspace: backspaceDraft(selected),
    delete: deleteDraft(selected),
  }).toEqual({
    backspace: { draft: "he", cursor: 2, mark: null },
    delete: { draft: "he", cursor: 2, mark: null },
  });

  const extended = moveDraft({ draft: "ab", cursor: 2, mark: null }, "left", true);
  expect({
    extended,
    range: selectionRange(extended),
    collapsed: moveDraft(extended, "left", false),
  }).toEqual({
    extended: { draft: "ab", cursor: 1, mark: 2 },
    range: { a: 1, b: 2 },
    collapsed: { draft: "ab", cursor: 1, mark: null },
  });

  expect({
    lineUp: moveDraft({ draft: "hello\nworld", cursor: 8, mark: null }, "line_up"),
    lineDown: moveDraft({ draft: "hello\nworld", cursor: 2, mark: null }, "line_down"),
    home: moveDraft({ draft: "ab\ncd", cursor: 4, mark: null }, "home"),
    end: moveDraft({ draft: "ab\ncd", cursor: 4, mark: null }, "end"),
  }).toEqual({
    lineUp: { draft: "hello\nworld", cursor: 2, mark: null },
    lineDown: { draft: "hello\nworld", cursor: 8, mark: null },
    home: { draft: "ab\ncd", cursor: 3, mark: null },
    end: { draft: "ab\ncd", cursor: 5, mark: null },
  });

  const base = { draft: "hello", cursor: 5, mark: null as number | null };
  expect({
    insert: applyDraftOp(base, { type: "insert", text: "!" }),
    backspace: applyDraftOp(base, { type: "backspace" }),
    delete: applyDraftOp({ draft: "ab", cursor: 0, mark: null }, { type: "delete" }),
    killWord: applyDraftOp({ draft: "foo bar", cursor: 7, mark: null }, { type: "kill", mode: "word" }),
    killStart: applyDraftOp(base, { type: "kill", mode: "to_start" }),
    killEnd: applyDraftOp(base, { type: "kill", mode: "to_end" }),
    move: applyDraftOp(base, { type: "move", to: "left", select: true }),
    setCaret: applyDraftOp(base, { type: "setCaret", cursor: 2, mark: 4 }),
    clamp: applyDraftOp(base, { type: "setCaret", cursor: 99, mark: -1 }),
    collapse: applyDraftOp(base, { type: "setCaret", cursor: 3, mark: 3 }),
  }).toEqual({
    insert: { draft: "hello!", cursor: 6, mark: null },
    backspace: { draft: "hell", cursor: 4, mark: null },
    delete: { draft: "b", cursor: 0, mark: null },
    killWord: { draft: "foo ", cursor: 4, mark: null },
    killStart: { draft: "", cursor: 0, mark: null },
    killEnd: { draft: "hello", cursor: 5, mark: null },
    move: { draft: "hello", cursor: 4, mark: 5 },
    setCaret: { draft: "hello", cursor: 2, mark: 4 },
    clamp: { draft: "hello", cursor: 5, mark: 0 },
    collapse: { draft: "hello", cursor: 3, mark: null },
  });
});

test("DraftOp Record is exhaustive", () => {
  const base = { draft: "hello", cursor: 5, mark: null as number | null };
  const ops: Record<DraftOp["type"], DraftOp> = {
    insert: { type: "insert", text: "x" },
    backspace: { type: "backspace" },
    delete: { type: "delete" },
    kill: { type: "kill", mode: "word" },
    move: { type: "move", to: "home" },
    setCaret: { type: "setCaret", cursor: 0, mark: null },
    selectAll: { type: "selectAll" },
  };
  expect(Object.fromEntries(Object.entries(ops).map(([key, op]) => [key, applyDraftOp(base, op)]))).toEqual({
    insert: { draft: "hellox", cursor: 6, mark: null },
    backspace: { draft: "hell", cursor: 4, mark: null },
    delete: { draft: "hello", cursor: 5, mark: null },
    kill: { draft: "", cursor: 0, mark: null },
    move: { draft: "hello", cursor: 0, mark: null },
    setCaret: { draft: "hello", cursor: 0, mark: null },
    selectAll: { draft: "hello", cursor: 5, mark: 0 },
  });
});

test("non-shift motion collapses onto the previous range", () => {
  const selected = { draft: "hello world", cursor: 5, mark: 0 };
  expect({
    left: moveDraft(selected, "left"),
    right: moveDraft(selected, "right"),
    wordLeft: moveDraft(selected, "word_left"),
    wordRight: moveDraft(selected, "word_right"),
    home: moveDraft({ draft: "hello", cursor: 4, mark: 1 }, "home"),
    end: moveDraft({ draft: "hello", cursor: 4, mark: 1 }, "end"),
    selectAll: applyDraftOp({ draft: "hi", cursor: 1, mark: null }, { type: "selectAll" }),
    empty: applyDraftOp({ draft: "", cursor: 0, mark: null }, { type: "selectAll" }),
  }).toEqual({
    left: { draft: "hello world", cursor: 0, mark: null },
    right: { draft: "hello world", cursor: 5, mark: null },
    wordLeft: { draft: "hello world", cursor: 0, mark: null },
    wordRight: { draft: "hello world", cursor: 5, mark: null },
    home: { draft: "hello", cursor: 0, mark: null },
    end: { draft: "hello", cursor: 5, mark: null },
    selectAll: { draft: "hi", cursor: 2, mark: 0 },
    empty: { draft: "", cursor: 0, mark: null },
  });
});
