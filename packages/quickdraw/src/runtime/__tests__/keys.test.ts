import { expect, test } from "vitest";

import { consumeKeys } from "../../input/index.js";
import { isRangeEditKey, keyEventToDraftOp, toKeyEvents } from "../keys.js";

test("Tab / Ctrl-X never insert", () => {
  expect({
    tab: {
      decoder: consumeKeys("\t").events,
      mapped: toKeyEvents({ type: "tab" }),
      draft: keyEventToDraftOp({ key: "Tab" }),
    },
    shiftTab: {
      csiZ: consumeKeys("\x1b[Z").events,
      csiu: consumeKeys("\x1b[9;2u").events,
      mok: consumeKeys("\x1b[27;2;9~").events,
      mapped: toKeyEvents({ type: "shift_tab" }),
      draft: keyEventToDraftOp({ key: "Tab", shift: true }),
    },
    ctrlX: {
      c0: consumeKeys("\x18").events,
      csiu: consumeKeys("\x1b[120;5u").events,
      mapped: toKeyEvents({ type: "ctrl_x" }),
      draft: keyEventToDraftOp({ key: "x", ctrl: true }),
    },
    ctrlO: {
      c0: consumeKeys("\x0f").events,
      csiu: consumeKeys("\x1b[111;5u").events,
      mapped: toKeyEvents({ type: "ctrl_o" }),
      draft: keyEventToDraftOp({ key: "o", ctrl: true }),
    },
    ctrlV: {
      c0: consumeKeys("\x16").events,
      csiu: consumeKeys("\x1b[118;5u").events,
      mok: consumeKeys("\x1b[27;5;118~").events,
      mapped: toKeyEvents({ type: "ctrl_v" }),
      draft: keyEventToDraftOp({ key: "v", ctrl: true }),
    },
    ctrlEnter: {
      csiu: consumeKeys("\x1b[13;5u").events,
      mok: consumeKeys("\x1b[27;5;13~").events,
      mapped: toKeyEvents({ type: "enter", ctrl: true }),
      draft: keyEventToDraftOp({ key: "Enter", ctrl: true }),
    },
    shiftA: {
      associated: consumeKeys("\x1b[97;2;65u").events,
      shifted: consumeKeys("\x1b[97:65;2u").events,
      identity: consumeKeys("\x1b[97;2u").events,
      mapped: toKeyEvents({ type: "char", ch: "A" }),
      draft: keyEventToDraftOp({ key: "A" }),
    },
    shiftEnter: {
      csiu: consumeKeys("\x1b[13;2u").events,
      mapped: toKeyEvents({ type: "enter", shift: true }),
      newline: keyEventToDraftOp({ key: "Enter", shift: true }),
      c0: consumeKeys("\n").events,
    },
    ctrlEsc: {
      csiu: consumeKeys("\x1b[27;5u").events,
      mapped: toKeyEvents({ type: "esc", ctrl: true }),
    },
    cmdA: {
      csiu: consumeKeys("\x1b[97;9u").events,
      mapped: toKeyEvents({ type: "select_all" }),
      draft: keyEventToDraftOp({ key: "SelectAll" }),
      ctrlA: consumeKeys("\x01").events,
    },
  }).toEqual({
    tab: {
      decoder: [{ type: "tab" }],
      mapped: [{ key: "Tab" }],
      draft: null,
    },
    shiftTab: {
      csiZ: [{ type: "shift_tab" }],
      csiu: [{ type: "shift_tab" }],
      mok: [{ type: "shift_tab" }],
      mapped: [{ key: "Tab", shift: true }],
      draft: null,
    },
    ctrlX: {
      c0: [{ type: "ctrl_x" }],
      csiu: [{ type: "ctrl_x" }],
      mapped: [{ key: "x", ctrl: true }],
      draft: null,
    },
    ctrlO: {
      c0: [{ type: "ctrl_o" }],
      csiu: [{ type: "ctrl_o" }],
      mapped: [{ key: "o", ctrl: true }],
      draft: null,
    },
    ctrlV: {
      c0: [{ type: "ctrl_v" }],
      csiu: [{ type: "ctrl_v" }],
      mok: [{ type: "ctrl_v" }],
      mapped: [],
      draft: null,
    },
    ctrlEnter: {
      csiu: [{ type: "enter", ctrl: true }],
      mok: [{ type: "enter", ctrl: true }],
      mapped: [{ key: "Enter", ctrl: true }],
      draft: null,
    },
    shiftA: {
      associated: [{ type: "char", ch: "A" }],
      shifted: [{ type: "char", ch: "A" }],
      identity: [{ type: "char", ch: "A" }],
      mapped: [{ key: "A" }],
      draft: { type: "insert", text: "A" },
    },
    shiftEnter: {
      csiu: [{ type: "enter", shift: true }],
      mapped: [{ key: "Enter", shift: true }],
      newline: { type: "insert", text: "\n" },
      c0: [{ type: "shift_enter" }],
    },
    ctrlEsc: {
      csiu: [{ type: "esc", ctrl: true }],
      mapped: [{ key: "Escape", ctrl: true }],
    },
    cmdA: {
      csiu: [{ type: "select_all" }],
      mapped: [{ key: "SelectAll" }],
      draft: { type: "selectAll" },
      ctrlA: [{ type: "home" }],
    },
  });
});

test("range-edit keys are insert/backspace/delete/kill, not motion", () => {
  expect({
    insert: isRangeEditKey({ key: "x" }),
    paste: isRangeEditKey({ key: 'Paste:"z"' }),
    backspace: isRangeEditKey({ key: "Backspace" }),
    del: isRangeEditKey({ key: "Delete" }),
    kill: isRangeEditKey({ key: "KillLineStart" }),
    arrow: isRangeEditKey({ key: "ArrowLeft" }),
    caret: isRangeEditKey({ key: "ComposerCaret:5:0" }),
    tab: isRangeEditKey({ key: "Tab" }),
    selectAll: isRangeEditKey({ key: "SelectAll" }),
  }).toEqual({
    insert: true,
    paste: true,
    backspace: true,
    del: true,
    kill: true,
    arrow: false,
    caret: false,
    tab: false,
    selectAll: false,
  });
});
