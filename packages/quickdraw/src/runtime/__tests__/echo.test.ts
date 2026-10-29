import { expect, test } from "vitest";

import { applyDraftOp } from "../../input/index.js";
import { applyBoxBusBatch, emptyMailbox } from "../box_bus.js";
import { emptyEcho, predict, reconcile, withComposerBox } from "../echo.js";
import { renderFrame } from "../frame.js";
import { KEY_REDO, KEY_UNDO, pasteKeyEvent } from "../keys.js";
import { paintSnapshotFromMailbox } from "../paint_snapshot.js";
import { COMPOSER_BOX, bufferRows, composer, structure } from "./_helpers.js";

const GEOMETRY = { cols: 40, rows: 6 };

function draftState(draft: string, cursor = draft.length) {
  return { draft, cursor, mark: null as number | null };
}

function paintedRows(mailbox: ReturnType<typeof emptyMailbox>, echo: ReturnType<typeof emptyEcho>): string[] {
  return bufferRows(
    renderFrame({
      snapshot: paintSnapshotFromMailbox(mailbox),
      geometry: GEOMETRY,
      state: { nowMs: 0, echo },
    }).buffer,
  );
}

function seeded(draft: string): ReturnType<typeof emptyMailbox> {
  return applyBoxBusBatch(emptyMailbox(), [
    { kind: "box_set", boxId: COMPOSER_BOX, value: composer(draft) },
    structure(1, []),
  ]);
}

test("echo predict → retire → converge", () => {
  const base = withComposerBox(emptyEcho(), COMPOSER_BOX);
  expect({
    printable: predict(base, draftState(""), { key: "a" }).predicted,
    chained: predict(predict(base, draftState(""), { key: "a" }), draftState(""), { key: "b" }).predicted,
    backspace: predict(base, draftState("hi"), { key: "Backspace" }).predicted,
    enter: predict(base, draftState("hi"), { key: "Enter" }).predicted,
    tabDropsStanding: predict(predict(base, draftState(""), { key: "a" }), draftState("a"), {
      key: "Tab",
    }).predicted,
    enterDropsStanding: predict(predict(base, draftState(""), { key: "a" }), draftState("a"), {
      key: "Enter",
    }).predicted,
    escape: predict(base, draftState("hi"), { key: "Escape" }).predicted,
    ctrl: predict(base, draftState("hi"), { key: "c", ctrl: true }).predicted,
    undo: predict(base, draftState("hi"), { key: KEY_UNDO }).predicted,
    redo: predict(base, draftState("hi"), { key: KEY_REDO }).predicted,
    paste: predict(base, draftState(""), pasteKeyEvent("ab\nc")).predicted,
    emptyBackspace: predict(base, draftState(""), { key: "Backspace" }).predicted,
    overwrite: predict(base, { draft: "hello", cursor: 5, mark: 0 }, { key: "x" }).predicted,
    killSel: predict(base, { draft: "hello", cursor: 5, mark: 0 }, { key: "Backspace" }).predicted,
    killSelDel: predict(base, { draft: "hello", cursor: 5, mark: 0 }, { key: "Delete" }).predicted,
    pasteOver: predict(base, { draft: "hello", cursor: 5, mark: 0 }, pasteKeyEvent("z")).predicted,
    arrows: predict(base, draftState("ab"), { key: "ArrowLeft" }).predicted,
    collapseLeft: predict(base, { draft: "hello", cursor: 5, mark: 0 }, { key: "ArrowLeft" }).predicted,
    collapseRight: predict(base, { draft: "hello", cursor: 5, mark: 0 }, { key: "ArrowRight" }).predicted,
    selectAll: predict(base, draftState("hello"), { key: "SelectAll" }).predicted,
  }).toEqual({
    printable: draftState("a"),
    chained: draftState("ab"),
    backspace: draftState("h"),
    enter: null,
    tabDropsStanding: null,
    enterDropsStanding: null,
    escape: null,
    ctrl: null,
    undo: null,
    redo: null,
    paste: draftState("ab\nc"),
    emptyBackspace: null,
    overwrite: draftState("x"),
    killSel: draftState(""),
    killSelDel: draftState(""),
    pasteOver: draftState("z"),
    arrows: { draft: "ab", cursor: 1, mark: null },
    collapseLeft: draftState("hello", 0),
    collapseRight: draftState("hello", 5),
    selectAll: { draft: "hello", cursor: 5, mark: 0 },
  });

  const agreeing = predict(base, draftState(""), { key: "a" });
  const conflicting = predict(base, draftState(""), { key: "z" });
  expect({
    agree: reconcile(agreeing, COMPOSER_BOX).predicted,
    conflict: reconcile(conflicting, COMPOSER_BOX).predicted,
  }).toEqual({ agree: null, conflict: null });

  const speculating = predict(base, draftState(""), { key: "z" });
  expect({
    disagree: reconcile(speculating, COMPOSER_BOX, draftState("a")),
    match: reconcile(speculating, COMPOSER_BOX, draftState("z")),
    otherBox: reconcile(speculating, COMPOSER_BOX + 7).predicted,
    moved: withComposerBox(speculating, COMPOSER_BOX + 1).predicted,
  }).toEqual({
    disagree: { boxId: COMPOSER_BOX, predicted: null, misaligned: true },
    match: { boxId: COMPOSER_BOX, predicted: null, misaligned: false },
    otherBox: draftState("z"),
    moved: null,
  });

  const echoH = predict(base, draftState(""), { key: "h" });
  const speculative = paintedRows(seeded(""), echoH);
  const authoritative = paintedRows(seeded("h"), reconcile(echoH, COMPOSER_BOX));
  expect(speculative.some((row) => row.includes("h"))).toEqual(true);
  expect(speculative).toEqual(authoritative);
});

test("wrapped ArrowUp stays on the long line", () => {
  const text = `short\n${"x".repeat(80)}`;
  const draft = draftState(text);
  const visual = predict(
    withComposerBox(emptyEcho(), COMPOSER_BOX),
    draft,
    { key: "ArrowUp" },
    {
      composerOuterWidth: 40,
    },
  ).predicted;
  const hard = applyDraftOp(draft, { type: "move", to: "line_up" });
  expect({
    visualOnXs: (visual?.cursor ?? 0) > "short\n".length,
    hardOnXs: hard.cursor > "short\n".length,
  }).toEqual({ visualOnXs: true, hardOnXs: false });
});
