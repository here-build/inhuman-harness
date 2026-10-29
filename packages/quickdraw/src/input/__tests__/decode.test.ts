import { expect, test } from "vitest";

import { parseOscColorPayload } from "../../capabilities/index.js";
import { consumeKeys, flushPendingEsc, MAX_OSC_BODY, type ConsumeKeysResult } from "../index.js";

function oscGround(payload: string): { type: "osc_ground"; rgb: { r: number; g: number; b: number } } {
  const rgb = parseOscColorPayload(payload);
  if (!rgb) throw new Error(`osc parse failed: ${payload}`);
  return { type: "osc_ground", rgb };
}

const OSC11_DARK = oscGround("rgb:158e/193a/1e75");
const OSC11_BLACK = oscGround("rgb:0000/0000/0000");

function chars(s: string): ConsumeKeysResult["events"] {
  return [...s].map((ch) => ({ type: "char" as const, ch }));
}

function play(chunks: string[], flush = false): ConsumeKeysResult {
  let pending = "";
  let result: ConsumeKeysResult = { events: [], pending: "" };
  for (const chunk of chunks) {
    result = consumeKeys(chunk, pending);
    pending = result.pending;
  }
  if (flush) result = flushPendingEsc(result.pending);
  return result;
}

const oscHalf = Math.floor(MAX_OSC_BODY / 2);
const oscBoundRest = `${"b".repeat(MAX_OSC_BODY - oscHalf + 10)}z`;

test.each([
  {
    name: "OSC 11 BEL swallow then chars",
    chunks: ["\x1b]11;rgb:158e/193a/1e75\x07hello"],
    want: { events: [OSC11_DARK, ...chars("hello")], pending: "" },
  },
  {
    name: "OSC 11 ST swallow",
    chunks: ["\x1b]11;rgb:0000/0000/0000\x1b\\"],
    want: { events: [OSC11_BLACK], pending: "" },
  },
  {
    name: "incomplete OSC held",
    chunks: ["\x1b]11;rgb:158e"],
    want: { events: [], pending: "\x1b]11;rgb:158e" },
  },
  {
    name: "incomplete OSC completes across chunks",
    chunks: ["\x1b]11;rgb:158e", "/193a/1e75\x07"],
    want: { events: [OSC11_DARK], pending: "" },
  },
  {
    name: "MAX_OSC_BODY abandon (C8)",
    chunks: [`\x1b]${"x".repeat(MAX_OSC_BODY)}hello`],
    want: { events: chars("hello"), pending: "" },
  },
  {
    name: "MAX_OSC_BODY bound across chunks",
    chunks: [`\x1b]${"a".repeat(oscHalf)}`, oscBoundRest],
    want: { events: chars(`${"b".repeat(10)}z`), pending: "" },
  },
  {
    name: "paste CSI 200~ body",
    chunks: ["\x1b[200~hello\nworld\x1b[201~"],
    want: { events: [{ type: "paste", text: "hello\nworld" }], pending: "" },
  },
  {
    name: "paste CRLF dedent",
    chunks: ["\x1b[200~  a\r\n  b\r\n\x1b[201~"],
    want: { events: [{ type: "paste", text: "a\nb" }], pending: "" },
  },
  {
    name: "incomplete paste held",
    chunks: ["\x1b[200~partial"],
    want: { events: [], pending: "\x1b[200~partial" },
  },
  {
    name: "incomplete paste completes across chunks",
    chunks: ["\x1b[200~partial", " more\x1b[201~x"],
    want: {
      events: [
        { type: "paste", text: "partial more" },
        { type: "char", ch: "x" },
      ],
      pending: "",
    },
  },
  {
    name: "stray paste-end swallowed",
    chunks: ["\x1b[201~hi"],
    want: { events: chars("hi"), pending: "" },
  },
  {
    name: "normalizePaste leading blanks",
    chunks: ["\x1b[200~\r\n\r\n  x\r\n\x1b[201~"],
    want: { events: [{ type: "paste", text: "x" }], pending: "" },
  },
  {
    name: "lone ESC held",
    chunks: ["\x1b"],
    want: { events: [], pending: "\x1b" },
  },
  {
    name: "incomplete CSI held",
    chunks: ["\x1b["],
    want: { events: [], pending: "\x1b[" },
  },
  {
    name: "incomplete CSI params held",
    chunks: ["\x1b[1"],
    want: { events: [], pending: "\x1b[1" },
  },
  {
    name: "incomplete SS3 held",
    chunks: ["\x1bO"],
    want: { events: [], pending: "\x1bO" },
  },
  {
    name: "split ESC then [C",
    chunks: ["\x1b", "[C"],
    want: { events: [{ type: "right" }], pending: "" },
  },
  {
    name: "split ESC[ then C",
    chunks: ["\x1b[", "C"],
    want: { events: [{ type: "right" }], pending: "" },
  },
  {
    name: "split ctrl-right",
    chunks: ["\x1b", "[1;5C"],
    want: { events: [{ type: "end" }], pending: "" },
  },
  {
    name: "flushPendingEsc lone ESC",
    chunks: ["\x1b"],
    flush: true,
    want: { events: [{ type: "esc" }], pending: "" },
  },
  {
    name: "flushPendingEsc incomplete CSI",
    chunks: ["\x1b["],
    flush: true,
    want: { events: [], pending: "\x1b[" },
  },
  {
    name: "flushPendingEsc empty",
    chunks: [],
    flush: true,
    want: { events: [], pending: "" },
  },
  {
    name: "raw Ctrl+Z",
    chunks: ["\x1a"],
    want: { events: [{ type: "undo" }], pending: "" },
  },
  {
    name: "raw Ctrl+Y",
    chunks: ["\x19"],
    want: { events: [{ type: "redo" }], pending: "" },
  },
  {
    name: "CSI-u Ctrl+Z",
    chunks: ["\x1b[122;5u"],
    want: { events: [{ type: "undo" }], pending: "" },
  },
  {
    name: "CSI-u Ctrl+Shift+Z",
    chunks: ["\x1b[122;6u"],
    want: { events: [{ type: "redo" }], pending: "" },
  },
  {
    name: "CSI-u Ctrl+Y",
    chunks: ["\x1b[121;5u"],
    want: { events: [{ type: "redo" }], pending: "" },
  },
  {
    name: "CSI-u Cmd+Z",
    chunks: ["\x1b[122;9u"],
    want: { events: [{ type: "undo" }], pending: "" },
  },
  {
    name: "CSI-u Cmd+Shift+Z",
    chunks: ["\x1b[122;10u"],
    want: { events: [{ type: "redo" }], pending: "" },
  },
  {
    name: "CSI-u Cmd+Y",
    chunks: ["\x1b[121;9u"],
    want: { events: [{ type: "redo" }], pending: "" },
  },
  {
    name: "CSI-u Cmd+A select all",
    chunks: ["\x1b[97;9u"],
    want: { events: [{ type: "select_all" }], pending: "" },
  },
  {
    name: "CSI-u Cmd+C not ctrl_c",
    chunks: ["\x1b[99;9u"],
    want: { events: [], pending: "" },
  },
  {
    name: "CSI-u Cmd+Backspace kill-to-start",
    chunks: ["\x1b[127;9u"],
    want: { events: [{ type: "kill_to_start" }], pending: "" },
  },
  {
    name: "CSI-u Alt+Backspace word",
    chunks: ["\x1b[127;3u"],
    want: { events: [{ type: "word_backspace" }], pending: "" },
  },
  {
    name: "CSI-u Backspace",
    chunks: ["\x1b[127u"],
    want: { events: [{ type: "backspace" }], pending: "" },
  },
  {
    name: "report-all-keys CSI-u a",
    chunks: ["\x1b[97u"],
    want: { events: [{ type: "char", ch: "a" }], pending: "" },
  },
  {
    name: "report-all-keys CSI-u Shift+A",
    chunks: ["\x1b[65;2u"],
    want: { events: [{ type: "char", ch: "A" }], pending: "" },
  },
  {
    name: "CSI-u LEFT_ALT not printable",
    chunks: ["\x1b[57443u"],
    want: { events: [], pending: "" },
  },
  {
    name: "CSI-u LEFT_ALT+alt not printable",
    chunks: ["\x1b[57443;3u"],
    want: { events: [], pending: "" },
  },
  {
    name: "CSI-u LEFT_SHIFT not printable",
    chunks: ["\x1b[57441u"],
    want: { events: [], pending: "" },
  },
  {
    name: "CSI-u LEFT_CONTROL persist mod down",
    chunks: ["\x1b[57442u"],
    want: { events: [{ type: "mod", persist: true, down: true }], pending: "" },
  },
  {
    name: "CSI-u LEFT_SUPER persist mod down",
    chunks: ["\x1b[57444u"],
    want: { events: [{ type: "mod", persist: true, down: true }], pending: "" },
  },
  {
    name: "CSI-u LEFT_SUPER press with super bit (spec)",
    chunks: ["\x1b[57444;9u"],
    want: { events: [{ type: "mod", persist: true, down: true }], pending: "" },
  },
  {
    name: "CSI-u LEFT_SUPER press event-typed with super bit",
    chunks: ["\x1b[57444;9:1u"],
    want: { events: [{ type: "mod", persist: true, down: true }], pending: "" },
  },
  {
    name: "CSI-u LEFT_SUPER release with super bit",
    chunks: ["\x1b[57444;9:3u"],
    want: { events: [{ type: "mod", persist: true, down: false }], pending: "" },
  },
  {
    name: "CSI-u LEFT_CONTROL persist mod up",
    chunks: ["\x1b[57442;1:3u"],
    want: { events: [{ type: "mod", persist: true, down: false }], pending: "" },
  },
  {
    name: "CSI-u Ctrl+Enter keeps ctrl",
    chunks: ["\x1b[13;5u"],
    want: { events: [{ type: "enter", ctrl: true }], pending: "" },
  },
  {
    name: "CSI-u Shift+Enter keeps shift",
    chunks: ["\x1b[13;2u"],
    want: { events: [{ type: "enter", shift: true }], pending: "" },
  },
  {
    name: "CSI-u Cmd+Enter keeps meta",
    chunks: ["\x1b[13;9u"],
    want: { events: [{ type: "enter", meta: true }], pending: "" },
  },
  {
    name: "CSI-u Ctrl+Esc keeps ctrl",
    chunks: ["\x1b[27;5u"],
    want: { events: [{ type: "esc", ctrl: true }], pending: "" },
  },
  {
    name: "modifyOtherKeys Ctrl+Enter keeps ctrl",
    chunks: ["\x1b[27;5;13~"],
    want: { events: [{ type: "enter", ctrl: true }], pending: "" },
  },
  {
    name: "C0 LF stays newline",
    chunks: ["\n"],
    want: { events: [{ type: "shift_enter" }], pending: "" },
  },
  {
    name: "CSI-u Shift+a associated text is A",
    chunks: ["\x1b[97;2;65u"],
    want: { events: [{ type: "char", ch: "A" }], pending: "" },
  },
  {
    name: "CSI-u Shift+a shifted subfield is A",
    chunks: ["\x1b[97:65;2u"],
    want: { events: [{ type: "char", ch: "A" }], pending: "" },
  },
  {
    name: "CSI-u Shift+a identity-only case-folds A",
    chunks: ["\x1b[97;2u"],
    want: { events: [{ type: "char", ch: "A" }], pending: "" },
  },
  {
    name: "CSI-u Caps+a is A",
    chunks: ["\x1b[97;65u"],
    want: { events: [{ type: "char", ch: "A" }], pending: "" },
  },
  {
    name: "CSI-u Caps+Shift+a is a",
    chunks: ["\x1b[97;66u"],
    want: { events: [{ type: "char", ch: "a" }], pending: "" },
  },
  {
    name: "CSI-u Shift+1 associated text is !",
    chunks: ["\x1b[49;2;33u"],
    want: { events: [{ type: "char", ch: "!" }], pending: "" },
  },
  {
    name: "CSI-u Shift+1 shifted subfield is !",
    chunks: ["\x1b[49:33;2u"],
    want: { events: [{ type: "char", ch: "!" }], pending: "" },
  },
  {
    name: "CSI-u Shift+1 identity-only stays 1",
    chunks: ["\x1b[49;2u"],
    want: { events: [{ type: "char", ch: "1" }], pending: "" },
  },
  {
    name: "CSI-u key 0 associated text is å",
    chunks: ["\x1b[0;;229u"],
    want: { events: [{ type: "char", ch: "å" }], pending: "" },
  },
  {
    name: "CSI-u Ctrl+c is still ctrl_c",
    chunks: ["\x1b[99;5u"],
    want: { events: [{ type: "ctrl_c" }], pending: "" },
  },
  {
    name: "CSI-u Ctrl+Shift+c is still ctrl_c not glyph",
    chunks: ["\x1b[99;6u"],
    want: { events: [{ type: "ctrl_c" }], pending: "" },
  },
  {
    name: "modifyOtherKeys Shift+a case-folds A",
    chunks: ["\x1b[27;2;97~"],
    want: { events: [{ type: "char", ch: "A" }], pending: "" },
  },
  {
    name: "CSI-u Caps Lock key is not a glyph",
    chunks: ["\x1b[57358u"],
    want: { events: [], pending: "" },
  },
  {
    name: "plain j",
    chunks: ["j"],
    want: { events: [{ type: "char", ch: "j" }], pending: "" },
  },
  {
    name: "plain k",
    chunks: ["k"],
    want: { events: [{ type: "char", ch: "k" }], pending: "" },
  },
  {
    name: "CSI-u letter j",
    chunks: ["\x1b[106u"],
    want: { events: [{ type: "char", ch: "j" }], pending: "" },
  },
  {
    name: "arrow CSI down",
    chunks: ["\x1b[B"],
    want: { events: [{ type: "down" }], pending: "" },
  },
  {
    name: "arrow CSI up",
    chunks: ["\x1b[A"],
    want: { events: [{ type: "up" }], pending: "" },
  },
  {
    name: "SS3 application down",
    chunks: ["\x1bOB"],
    want: { events: [{ type: "down" }], pending: "" },
  },
  {
    name: "SGR mouse release",
    chunks: ["\x1b[<0;5;10m"],
    want: {
      events: [{ type: "mouse", button: 0, col: 5, row: 10, release: true }],
      pending: "",
    },
  },
  {
    name: "raw Ctrl+V",
    chunks: ["\x16"],
    want: { events: [{ type: "ctrl_v" }], pending: "" },
  },
  {
    name: "CSI-u Ctrl+V",
    chunks: ["\x1b[118;5u"],
    want: { events: [{ type: "ctrl_v" }], pending: "" },
  },
  {
    name: "modifyOtherKeys Ctrl+V",
    chunks: ["\x1b[27;5;118~"],
    want: { events: [{ type: "ctrl_v" }], pending: "" },
  },
  {
    name: "CSI-u Cmd+V is not paste",
    chunks: ["\x1b[118;9u"],
    want: { events: [], pending: "" },
  },
] as const)("$name", ({ chunks, want, ...rest }) => {
  const flush = "flush" in rest && rest.flush === true;
  expect(play([...chunks], flush)).toEqual(want);
});
test("theme reports survive every chunk boundary without becoming input", () => {
  for (const mode of [1, 2]) {
    const report = `\x1b[?997;${mode}n`;
    for (let split = 1; split < report.length; split += 1) {
      expect(play([report.slice(0, split), report.slice(split)])).toEqual({
        events: [{ type: "theme_changed" }],
        pending: "",
      });
    }
  }
});
