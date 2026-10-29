import { expect, test } from "vitest";

import { displayWidth } from "../../measure/index.js";
import { cloneBuffer, createBuffer, dirtyRows, emitAnsiDetailed, guardContent, put, type Style } from "../index.js";

function ansiPieces(ansi: string) {
  return {
    forceFull: ansi.includes("\x1b[2J"),
    cups: [...ansi.matchAll(/\x1b\[(\d+);(\d+)H/g)].map((m) => `${m[1]};${m[2]}`),
    sgr: [...ansi.matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1]!),
    osc8: [...ansi.matchAll(/\x1b\]8;;([^\x1b]*)\x1b\\/g)].map((m) => m[1]!),
    text: ansi.replaceAll(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replaceAll(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""),
  };
}

function painted(buf: ReturnType<typeof createBuffer>): string {
  return buf.cells
    .map((c) => c.ch)
    .join("")
    .replace(/ +$/, "");
}

test.each([
  { name: "CSI clear-screen", raw: "hello\x1b[2Jworld", expected: "helloworld" },
  { name: "leave-alt CSI", raw: "x\x1b[?1049ly", expected: "xy" },
  {
    name: "OSC 8 hyperlink",
    raw: "click\x1b]8;;https://evil.com\x1b\\here",
    expected: "clickhere",
  },
  { name: "OSC 0 title BEL", raw: "a\x1b]0;title\x07b", expected: "ab" },
  { name: "OSC 11 ST", raw: "x\x1b]11;rgb:1/2/3\x1b\\y", expected: "xy" },
  { name: "DCS ST", raw: "a\x1bP1$q\x1b\\b", expected: "ab" },
  { name: "dangling OSC payload leftover", raw: "a\x1b]0;titleb", expected: "a0;titleb" },
  { name: "partial OSC intro", raw: "pre\x1b]partial", expected: "prepartial" },
  { name: "partial DCS P", raw: "a\x1bPpayload", expected: "apayload" },
  { name: "partial SOS X", raw: "a\x1bXpayload", expected: "apayload" },
  { name: "partial PM ^", raw: "a\x1b^payload", expected: "apayload" },
  { name: "partial APC _", raw: "a\x1b_payload", expected: "apayload" },
])("ContentGuard $name", ({ raw, expected }) => {
  const buf = createBuffer(24, 1);
  put(buf, 0, 0, raw);
  const text = painted(buf);
  expect({
    guarded: guardContent(raw),
    painted: text,
    width: displayWidth(text),
    esc: guardContent(raw).includes("\x1b"),
  }).toEqual({
    guarded: expected,
    painted: expected,
    width: displayWidth(expected),
    esc: false,
  });
});

test("wide-glyph lifecycle", () => {
  const occupy = createBuffer(4, 1);
  put(occupy, 0, 0, "漢");
  expect(occupy.cells.map((c) => ({ ch: c.ch, ph: !!c.placeholder }))).toEqual([
    { ch: "漢", ph: false },
    { ch: "", ph: true },
    { ch: " ", ph: false },
    { ch: " ", ph: false },
  ]);

  const ret = createBuffer(4, 1);
  put(ret, 0, 0, "⏎:");
  expect({
    cells: ret.cells.map((c) => ({ ch: c.ch, ph: !!c.placeholder })),
    emit: ansiPieces(emitAnsiDetailed(null, ret).ansi).text,
  }).toEqual({
    cells: [
      { ch: "⏎", ph: false },
      { ch: " ", ph: false },
      { ch: ":", ph: false },
      { ch: " ", ph: false },
    ],
    emit: "⏎ : ",
  });

  put(occupy, 2, 0, "a");
  const occupyAnsi = emitAnsiDetailed(null, occupy).ansi;
  expect({
    pair: occupy.cells.slice(0, 3).map((c) => ({ ch: c.ch, ph: !!c.placeholder })),
    emit: ansiPieces(occupyAnsi),
    han: occupyAnsi.split("漢").length - 1,
  }).toEqual({
    pair: [
      { ch: "漢", ph: false },
      { ch: "", ph: true },
      { ch: "a", ph: false },
    ],
    emit: {
      forceFull: true,
      cups: ["1;1"],
      sgr: ["0", "0", "0"],
      osc8: [],
      text: "漢a ",
    },
    han: 1,
  });

  const combining = createBuffer(4, 1);
  put(combining, 0, 0, "\u0301x");
  expect(combining.cells[0]!.ch).toBe("x");

  const edge = createBuffer(3, 1);
  put(edge, 2, 0, "漢");
  expect({ ch: edge.cells[2]!.ch, ph: !!edge.cells[2]!.placeholder }).toEqual({
    ch: " ",
    ph: false,
  });

  const ascii = createBuffer(3, 1);
  put(ascii, 0, 0, "ab");
  expect(ascii.cells.map((c) => c.ch)).toEqual(["a", "b", " "]);

  const orphan = createBuffer(6, 1);
  put(orphan, 0, 0, "漢abc");
  put(orphan, 0, 0, "X");
  expect({
    cells: orphan.cells.map((c) => ({ ch: c.ch, ph: !!c.placeholder })),
    emit: ansiPieces(emitAnsiDetailed(null, orphan).ansi).text,
  }).toEqual({
    cells: [
      { ch: "X", ph: false },
      { ch: " ", ph: false },
      { ch: "a", ph: false },
      { ch: "b", ph: false },
      { ch: "c", ph: false },
      { ch: " ", ph: false },
    ],
    emit: "X abc ",
  });

  const c6 = createBuffer(6, 1);
  put(c6, 0, 0, "a漢");
  put(c6, 0, 0, "漢");
  expect(c6.cells.map((c) => ({ ch: c.ch, ph: !!c.placeholder }))).toEqual([
    { ch: "漢", ph: false },
    { ch: "", ph: true },
    { ch: " ", ph: false },
    { ch: " ", ph: false },
    { ch: " ", ph: false },
    { ch: " ", ph: false },
  ]);

  const wow = createBuffer(4, 1);
  put(wow, 0, 0, "漢");
  put(wow, 0, 0, "字");
  expect({
    origin: { ch: wow.cells[0]!.ch, ph: !!wow.cells[0]!.placeholder },
    mate: { ch: wow.cells[1]!.ch, ph: !!wow.cells[1]!.placeholder },
    placeholders: wow.cells.filter((c) => c.placeholder).length,
  }).toEqual({
    origin: { ch: "字", ph: false },
    mate: { ch: "", ph: true },
    placeholders: 1,
  });
});

test("dirty rows: keyframe, delta, dual-dirty fields", () => {
  expect(dirtyRows(null, createBuffer(4, 2))).toEqual([0, 1]);

  const prev = createBuffer(4, 3);
  put(prev, 0, 0, "aaaa");
  put(prev, 0, 1, "bbbb");
  put(prev, 0, 2, "cccc");
  const next = cloneBuffer(prev);
  put(next, 0, 1, "xxxx");
  expect(dirtyRows(prev, next)).toEqual([1]);

  expect(dirtyRows(createBuffer(2, 2), createBuffer(3, 2))).toEqual([0, 1]);

  const dual = [
    { field: "role", init: { role: "error" } satisfies Style, next: "muted" },
    { field: "prominence", init: { prominence: 0.9 } satisfies Style, next: 0.1 },
    {
      field: "regionProminence",
      init: { regionProminence: 0.5 } satisfies Style,
      next: 0.2,
    },
    { field: "bgFxOpacity", init: { bgFxOpacity: 0.3 } satisfies Style, next: 0.7 },
    { field: "bgRole", init: { bgRole: "surface" } satisfies Style, next: "panel" },
    { field: "bgProminence", init: { bgProminence: 0.6 } satisfies Style, next: 0.2 },
    { field: "cast", init: { cast: "transparent" } satisfies Style, next: undefined },
  ] as const;
  expect(
    dual.map((row) => {
      const a = createBuffer(1, 1);
      put(a, 0, 0, "x", row.init);
      const b = cloneBuffer(a);
      (b.cells[0]!.style as Record<string, unknown>)[row.field] = row.next;
      return { field: row.field, dirty: dirtyRows(a, b) };
    }),
  ).toEqual(dual.map((row) => ({ field: row.field, dirty: [0] })));

  const clean = createBuffer(2, 1);
  put(clean, 0, 0, "ab", { role: "muted", prominence: 0.5 });
  expect(dirtyRows(clean, cloneBuffer(clean))).toEqual([]);
});

test("mergeStyle: transparent bg inherits; explicit bg replaces; cast occupies", () => {
  const blank = createBuffer(2, 1);
  const inherit = createBuffer(3, 1);
  put(inherit, 0, 0, "   ", { bg: 235 });
  put(inherit, 0, 0, "┌─┐", { fg: 240 });
  const replace = createBuffer(1, 1);
  put(replace, 0, 0, "a", { bg: 235 });
  put(replace, 0, 0, "b", { bg: 196, fg: 15 });
  const cast = createBuffer(1, 1);
  put(cast, 0, 0, "X", { bg: 196 });
  put(cast, 0, 0, " ", { cast: "transparent" });
  expect({
    blank: { bg: blank.cells[0]!.style.bg, fg: blank.cells[0]!.style.fg },
    inherit: inherit.cells.map((c) => ({ ch: c.ch, bg: c.style.bg, fg: c.style.fg })),
    replace: {
      ch: replace.cells[0]!.ch,
      bg: replace.cells[0]!.style.bg,
      fg: replace.cells[0]!.style.fg,
    },
    cast: {
      ch: cast.cells[0]!.ch,
      bg: cast.cells[0]!.style.bg,
      cast: cast.cells[0]!.style.cast,
    },
  }).toEqual({
    blank: { bg: undefined, fg: undefined },
    inherit: [
      { ch: "┌", bg: 235, fg: 240 },
      { ch: "─", bg: 235, fg: 240 },
      { ch: "┐", bg: 235, fg: 240 },
    ],
    replace: { ch: "b", bg: 196, fg: 15 },
    cast: { ch: " ", bg: undefined, cast: "transparent" },
  });
});

test("emitAnsi: empty when clean; characterize CUP/SGR/OSC/forceFull", () => {
  const buf = createBuffer(3, 1);
  put(buf, 0, 0, "ab", {
    fgRgb: { r: 189, g: 65, b: 63 },
    bgRgb: { r: 10, g: 20, b: 30 },
    strike: true,
    underline: true,
    href: "https://example",
  });
  const prev = cloneBuffer(buf);
  expect(emitAnsiDetailed(prev, buf)).toEqual({ ansi: "", dirtyRows: 0, bytes: 0 });

  const dump = emitAnsiDetailed(prev, buf, { forceFull: true });
  expect({
    ...ansiPieces(dump.ansi),
    dirtyRows: dump.dirtyRows,
    bytes: dump.bytes,
  }).toEqual({
    forceFull: true,
    cups: ["1;1"],
    sgr: ["0", "0;4;9;38;2;189;65;63;48;2;10;20;30", "0", "0", "0"],
    osc8: ["https://example", ""],
    text: "ab ",
    dirtyRows: 1,
    bytes: 99,
  });
});

test.each([
  {
    name: "NaN RGB → 0",
    style: { fgRgb: { r: Number.NaN, g: 65, b: 63 } } satisfies Style,
    expected: {
      sgr: ["0", "0;38;2;0;65;63", "0"],
      text: "x",
      nan: false,
      inf: false,
      raw999: false,
      indexed: false,
    },
  },
  {
    name: "RGB range",
    style: { fgRgb: { r: -5, g: 999, b: 0.5 } } satisfies Style,
    expected: {
      sgr: ["0", "0;38;2;0;255;1", "0"],
      text: "x",
      nan: false,
      inf: false,
      raw999: false,
      indexed: false,
    },
  },
  {
    name: "fg index clamp",
    style: { fg: 999 } satisfies Style,
    expected: {
      sgr: ["0", "0;38;5;255", "0"],
      text: "x",
      nan: false,
      inf: false,
      raw999: false,
      indexed: true,
    },
  },
  {
    name: "nonfinite omits index",
    style: { fg: Number.POSITIVE_INFINITY } satisfies Style,
    expected: {
      sgr: ["0", "0", "0"],
      text: "x",
      nan: false,
      inf: false,
      raw999: false,
      indexed: false,
    },
  },
  {
    name: "bgRgb clamp",
    style: { bgRgb: { r: Number.NaN, g: 999, b: -1 } } satisfies Style,
    expected: {
      sgr: ["0", "0;48;2;0;255;0", "0"],
      text: "x",
      nan: false,
      inf: false,
      raw999: false,
      indexed: false,
    },
  },
])("SGR clamp $name", ({ style, expected }) => {
  const buf = createBuffer(1, 1);
  put(buf, 0, 0, "x", style);
  const { ansi } = emitAnsiDetailed(null, buf);
  const pieces = ansiPieces(ansi);
  expect({
    sgr: pieces.sgr,
    text: pieces.text,
    nan: ansi.includes("NaN"),
    inf: ansi.includes("Infinity"),
    raw999: ansi.includes("999"),
    indexed: /38;5;/.test(ansi),
  }).toEqual(expected);
});
