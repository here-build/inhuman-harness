import { expect, test } from "vitest";

import { highlightLines } from "../highlight.js";

test("arrival grammar colors a dict, a null, and a vector without changing the text", async () => {
  const source = '{:key "hi" :n 1}\n(define x #null)\n[a b]';
  const lines = await highlightLines(source, "scm", "dark");
  if (lines === null) throw new Error("expected arrival colors");
  const text = lines.map((line) => line.map((run) => run.text).join("")).join("\n");
  expect(text).toBe(source);
  const colors = new Set(lines.flatMap((line) => line.map((run) => run.color)).filter((color) => color !== undefined));
  expect(colors.size).toBeGreaterThanOrEqual(3);
}, 60_000);

test("a shell command keeps its text and colors an embedded python snippet", async () => {
  const source = 'python -c "print(1)"';
  const lines = await highlightLines(source, "bash", "light");
  if (lines === null) throw new Error("expected bash colors");
  expect(lines.map((line) => line.map((run) => run.text).join("")).join("\n")).toBe(source);
  const flat = lines.flat();
  const printRun = flat.find((run) => run.text.includes("print"));
  const quoteRun = flat.find((run) => run.text.includes('"'));
  expect(printRun?.color).toBeDefined();
  expect(quoteRun?.color).toBeDefined();
  expect(printRun?.color).not.toBe(quoteRun?.color);
}, 60_000);
