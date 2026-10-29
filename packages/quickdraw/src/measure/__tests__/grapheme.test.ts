import { expect, test } from "vitest";

import { wrapText } from "../../layout/text.js";
import {
  displayWidth,
  graphemeWidth,
  isTwoColumnSymbol,
  isUnitWidthRun,
  splitAtWidth,
  takeGrapheme,
} from "../index.js";

test.each([
  { name: "ASCII columns", got: () => displayWidth("abc"), expected: 3 },
  { name: "CJK columns", got: () => displayWidth("漢字"), expected: 4 },
  { name: "combining cluster is 1", got: () => displayWidth("e\u0301"), expected: 1 },
  { name: "ambiguous narrow default", got: () => displayWidth("\u00A1"), expected: 1 },
  {
    name: "ambiguous wide",
    got: () => displayWidth("\u00A1", { ambiguousIsNarrow: false }),
    expected: 2,
  },
  { name: "grapheme CJK", got: () => graphemeWidth("漢"), expected: 2 },
  { name: "grapheme ASCII", got: () => graphemeWidth("a"), expected: 1 },
  { name: "grapheme combining", got: () => graphemeWidth("e\u0301"), expected: 1 },
  { name: "grapheme return symbol", got: () => graphemeWidth("⏎"), expected: 2 },
  { name: "hint ⏎ is two columns", got: () => displayWidth("⏎: Confirm"), expected: displayWidth(": Confirm") + 2 },
  { name: "⏎ is two-column pad", got: () => isTwoColumnSymbol("⏎"), expected: true },
  { name: "CJK is not two-column pad", got: () => isTwoColumnSymbol("漢"), expected: false },
  { name: "unit ASCII", got: () => isUnitWidthRun("abc"), expected: true },
  { name: "unit box", got: () => isUnitWidthRun("─┌│"), expected: true },
  { name: "unit CJK", got: () => isUnitWidthRun("漢"), expected: false },
  { name: "unit ⏎", got: () => isUnitWidthRun("⏎"), expected: false },
  { name: "take ASCII", got: () => takeGrapheme("ab"), expected: ["a", "b"] },
  { name: "take CJK whole", got: () => takeGrapheme("漢字"), expected: ["漢", "字"] },
  { name: "take ⏎ whole", got: () => takeGrapheme("⏎:"), expected: ["⏎", ":"] },
  { name: "split ⏎ at 1 empty", got: () => splitAtWidth("⏎:", 1), expected: ["", "⏎:"] },
  { name: "split ⏎ at 2", got: () => splitAtWidth("⏎:", 2), expected: ["⏎", ":"] },
  { name: "split box", got: () => splitAtWidth("────", 2), expected: ["──", "──"] },
  { name: "split ASCII", got: () => splitAtWidth("abc", 2), expected: ["ab", "c"] },
  { name: "split CJK on full char", got: () => splitAtWidth("漢字", 2), expected: ["漢", "字"] },
  { name: "never half CJK at 3", got: () => splitAtWidth("漢字", 3), expected: ["漢", "字"] },
  { name: "never half CJK at 1", got: () => splitAtWidth("漢字", 1), expected: ["", "漢字"] },
  { name: "empty head at 0", got: () => splitAtWidth("abc", 0), expected: ["", "abc"] },
  { name: "empty head at -1", got: () => splitAtWidth("abc", -1), expected: ["", "abc"] },
  { name: "fits ASCII", got: () => splitAtWidth("abc", 10), expected: ["abc", ""] },
  { name: "fits CJK", got: () => splitAtWidth("漢字", 4), expected: ["漢字", ""] },
  {
    name: "combining cluster not split",
    got: () => splitAtWidth("e\u0301x", 1),
    expected: ["e\u0301", "x"],
  },
  {
    name: "wrap width 4 fits 漢字",
    got: () => wrapText("漢字", { width: 4 }),
    expected: ["漢字"],
  },
  {
    name: "wrap width 2 hard-breaks 漢字",
    got: () => {
      const lines = wrapText("漢字", { width: 2 });
      return { lines, widths: lines.map((line) => displayWidth(line)) };
    },
    expected: { lines: ["漢", "字"], widths: [2, 2] },
  },
])("$name", ({ got, expected }) => {
  expect(got()).toEqual(expected);
});

test("splitAtWidth never splits mid-CJK", () => {
  const samples = ["漢字", "日本語", "漢字abc漢", "測試あいう", "e\u0301漢字"];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const text of samples) {
    const total = displayWidth(text);
    const segs = [...segmenter.segment(text)].map((s) => s.segment);
    for (let w = -1; w <= total + 2; w++) {
      const [head, tail] = splitAtWidth(text, w);
      let rebuilt = "";
      let used = 0;
      for (const g of segs) {
        const gw = displayWidth(g);
        if (w <= 0 || used + gw > w) break;
        rebuilt += g;
        used += gw;
      }
      expect({ head, tail, concat: head + tail, width: displayWidth(head) }).toEqual({
        head: rebuilt,
        tail: text.slice(rebuilt.length),
        concat: text,
        width: used,
      });
    }
  }
});
