import { expect, test } from "vitest";

import {
  decodeDisplayString,
  formatSchemeResult,
  highlightSchemePart,
  highlightSugarcoat,
  schemePaintReceipt,
  sugarcoatProgram,
  sugarcoatSource,
} from "../sugarcoat-paint.js";

test("scheme tape source is sugarcoat; results decode JSON string payloads", () => {
  const define = sugarcoatSource("(define (double n) (* n 2))");
  const runs = highlightSugarcoat('(define x "hi") :path 3 #t').flat();
  const color = (text: string) => runs.find((run) => run.text === text)?.color;
  const mixed = { ok: true as const, value: ["hello\nworld", true, [1, 2]] };
  expect({
    infix: sugarcoatSource("(+ 1 2)"),
    unwrapped: sugarcoatProgram("(begin (+ 1 2) (+ 3 4))"),
    define,
    quoted: decodeDisplayString('"a\\nb"'),
    path: decodeDisplayString("C:\\new"),
    values: formatSchemeResult(mixed),
    door: formatSchemeResult({ ok: false, text: "boom\\nline" }),
    keyword: color("define"),
    string: color('"hi"'),
    kw: color(":path"),
    number: color("3"),
    bool: color("#t"),
    markdown: schemePaintReceipt({ ok: true, value: ["# Harness\n**bold**"] }),
    fileMd: schemePaintReceipt({
      ok: true,
      value: [{ text: "# Harness\n**bold**", face: { kind: "file", path: "README.md" } }],
    }),
    fileTs: schemePaintReceipt({
      ok: true,
      value: [{ text: "export const Tea", face: { kind: "file", path: "src/tea.ts" } }],
    }),
    hinted: schemePaintReceipt({ ok: true, value: ["# Harness\n**bold**"] }, [
      { path: "README.md", text: "# Harness\n**bold**" },
    ]),
    atom: schemePaintReceipt({ ok: true, value: ["#t"] }),
    typedBool: schemePaintReceipt({ ok: true, value: [true] }),
    typedNum: schemePaintReceipt({ ok: true, value: [3] }),
    struct: schemePaintReceipt({ ok: true, value: [[1, 2]] }),
    dict: schemePaintReceipt({ ok: true, value: [{ k: 1 }] }),
    stored: schemePaintReceipt({ ok: true, value: ["{:k 1}"] }),
    prose: schemePaintReceipt({ ok: true, value: ["hello"] }),
    cut: schemePaintReceipt({
      ok: true,
      value: ['{:k "ab\n#| … output hard-truncated at 40 chars |#'],
    }),
    mixed: schemePaintReceipt(mixed),
    twoNums: schemePaintReceipt({ ok: true, value: ["3", "7"] }),
    numberTint: highlightSchemePart({ kind: "number", text: "3" }).flat()[0]?.color,
    boolTint: highlightSchemePart({ kind: "boolean", text: "#t" }).flat()[0]?.color,
  }).toEqual({
    infix: "{1 + 2}",
    unwrapped: "{1 + 2}\n\n{3 + 4}",
    define: "define (double n)\n  {n * 2}",
    quoted: "a\nb",
    path: "C:\\new",
    values: "hello\nworld\n#t\n[1 2]",
    door: "boom\\nline",
    keyword: "#bb6b25",
    string: "#728e60",
    kw: "#9673a7",
    number: "#5b89ad",
    bool: "#bb6b25",
    markdown: { kind: "text", text: "# Harness\n**bold**" },
    fileMd: { kind: "markdown", text: "# Harness\n**bold**" },
    fileTs: { kind: "text", text: "export const Tea" },
    hinted: { kind: "markdown", text: "# Harness\n**bold**" },
    atom: { kind: "boolean", text: "#t" },
    typedBool: { kind: "boolean", text: "#t" },
    typedNum: { kind: "number", text: "3" },
    struct: { kind: "syntax", text: "[1 2]" },
    dict: { kind: "syntax", text: "{:k 1}" },
    stored: { kind: "syntax", text: "{:k 1}" },
    prose: { kind: "text", text: "hello" },
    cut: {
      kind: "syntax",
      text: '{:k "ab\n#| … output hard-truncated at 40 chars |#',
    },
    mixed: {
      kind: "parts",
      parts: [
        { kind: "text", text: "hello\nworld" },
        { kind: "boolean", text: "#t" },
        { kind: "syntax", text: "[1 2]" },
      ],
    },
    twoNums: {
      kind: "parts",
      parts: [
        { kind: "number", text: "3" },
        { kind: "number", text: "7" },
      ],
    },
    numberTint: "#5b89ad",
    boolTint: "#bb6b25",
  });
});
