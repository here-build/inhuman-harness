import { expect, test } from "vitest";

import { consumeKeys } from "../index.js";

test.each([
  {
    name: "Ctrl+с (CSI 1089;5u) → ctrl_c",
    wire: "\x1b[1089;5u",
    want: [{ type: "ctrl_c" }],
  },
  {
    name: "Ctrl+м (CSI 1084;5u) → ctrl_v",
    wire: "\x1b[1084;5u",
    want: [{ type: "ctrl_v" }],
  },
  {
    name: "bare с is text",
    wire: "с",
    want: [{ type: "char", ch: "с" }],
  },
  {
    name: "QD_NO_LAYOUT_TABLE disables table",
    wire: "\x1b[1089;5u",
    noTable: true,
    want: [],
  },
  {
    name: "Cyrillic main + Latin base subfield → Latin shortcut",
    wire: "\x1b[1089:1057:99;5u",
    want: [{ type: "ctrl_c" }],
  },
  {
    name: "base subfield ABSENT → static table (iTerm2)",
    wire: "\x1b[1089;5u",
    want: [{ type: "ctrl_c" }],
  },
  {
    name: "main==shifted nonconformant → ignore bogus base",
    wire: "\x1b[1089:1089:113;5u",
    want: [{ type: "ctrl_c" }],
  },
  {
    name: "bare non-Latin typing no mods → text",
    wire: "\x1b[1089:1057:99u",
    want: [{ type: "char", ch: "с" }],
  },
  {
    name: "QD_NO_LAYOUT_TABLE disables flag-4",
    wire: "\x1b[1089:1057:99;5u",
    noTable: true,
    want: [],
  },
  {
    name: "mintty flag-1 lookalike is not flag 4",
    wire: "\x1b[1089;5u",
    want: [{ type: "ctrl_c" }],
  },
  {
    name: "mod-field event-type colon does not collide with key-field colons",
    wire: "\x1b[1089:1057:99;5:1u",
    want: [{ type: "ctrl_c" }],
  },
] as const)("$name", ({ wire, want, ...rest }) => {
  const prior = process.env.QD_NO_LAYOUT_TABLE;
  try {
    if ("noTable" in rest && rest.noTable) process.env.QD_NO_LAYOUT_TABLE = "1";
    else delete process.env.QD_NO_LAYOUT_TABLE;
    expect(consumeKeys(wire)).toEqual({ events: want, pending: "" });
  } finally {
    if (prior === undefined) delete process.env.QD_NO_LAYOUT_TABLE;
    else process.env.QD_NO_LAYOUT_TABLE = prior;
  }
});
