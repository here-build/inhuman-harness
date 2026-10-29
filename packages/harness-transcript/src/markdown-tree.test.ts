import { describe, expect, it } from "vitest";

import { inlineText, markdownBlocks, parseMarkdown } from "./markdown-tree.js";

describe("parseMarkdown", () => {
  it("maps paragraphs with emphasis, strong, code and links", () => {
    const [p] = parseMarkdown("A *soft* and **hard** `x` [site](https://a.b) ~~gone~~");
    expect(p).toEqual({
      t: "p",
      c: [
        { t: "text", v: "A " },
        { t: "em", c: [{ t: "text", v: "soft" }] },
        { t: "text", v: " and " },
        { t: "strong", c: [{ t: "text", v: "hard" }] },
        { t: "text", v: " " },
        { t: "code", v: "x" },
        { t: "text", v: " " },
        { t: "link", url: "https://a.b", c: [{ t: "text", v: "site" }] },
        { t: "text", v: " " },
        { t: "del", c: [{ t: "text", v: "gone" }] },
      ],
    });
  });

  it("maps headings and fenced code with its language", () => {
    const blocks = parseMarkdown("## Title\n\n```ts\nconst a = 1;\n```\n");
    expect(blocks).toEqual([
      { t: "h", level: 2, c: [{ t: "text", v: "Title" }] },
      { t: "code", lang: "ts", v: "const a = 1;" },
    ]);
  });

  it("keeps list nesting, ordering, start and task state", () => {
    const [list] = parseMarkdown("3. one\n4. two\n   - [x] nested\n   - [ ] open\n");
    expect(list).toMatchObject({ t: "list", ordered: true, start: 3 });
    if (list?.t !== "list") throw new Error("not a list");
    const inner = list.items[1]?.c.find((item) => item.t === "list");
    expect(inner).toMatchObject({ t: "list", ordered: false });
    if (inner?.t !== "list") throw new Error("no nested list");
    expect(inner.items.map((item) => item.checked)).toEqual([true, false]);
  });

  it("maps blockquotes, rules and tables", () => {
    const blocks = parseMarkdown("> quoted\n\n---\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n");
    expect(blocks[0]).toMatchObject({ t: "quote" });
    expect(blocks[1]).toEqual({ t: "hr" });
    expect(blocks[2]).toEqual({
      t: "table",
      align: ["left", "right"],
      head: [[{ t: "text", v: "a" }], [{ t: "text", v: "b" }]],
      rows: [[[{ t: "text", v: "1" }], [{ t: "text", v: "2" }]]],
    });
  });

  it("completes an unfinished stream the way the web does", () => {
    const [p] = parseMarkdown("Half **bold");
    expect(p).toMatchObject({ t: "p", c: [{ t: "text", v: "Half " }, { t: "strong" }] });
  });

  it("memoizes by text", () => {
    expect(markdownBlocks("same")).toBe(markdownBlocks("same"));
  });

  it("reads plain text out of inline nodes", () => {
    const [p] = parseMarkdown("a **b** `c`");
    expect(p?.t === "p" ? inlineText(p.c) : "").toBe("a b c");
  });
});
