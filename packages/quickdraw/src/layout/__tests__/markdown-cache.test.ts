import { expect, test } from "vitest";

import { markdownToNodes } from "../markdown.js";
import { measureNode } from "../measure.js";

test("markdownToNodes reuses the same tree for identical input", () => {
  const a = markdownToNodes("## title\n\nhello **world**", { key: "md" });
  const b = markdownToNodes("## title\n\nhello **world**", { key: "md" });
  expect(a).toBe(b);
});

test("cached markdown nodes skip wrap on the second measure", () => {
  let wide = 0;
  const measure = (text: string): number => {
    if (text.length > 20) wide += 1;
    return text.length;
  };
  const src = Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
  const node = {
    type: "markdown" as const,
    key: "body",
    content: src,
  };
  measureNode(node, 24, 10_000, measure);
  const afterFirst = wide;
  measureNode(node, 24, 10_000, measure);
  expect(afterFirst).toBeGreaterThan(0);
  expect(wide).toBe(afterFirst);
});
