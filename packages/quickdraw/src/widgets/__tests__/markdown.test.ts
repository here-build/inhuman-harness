import { expect, test, vi } from "vitest";

import { INDICATION_CONTENT_INSET, type LayoutNode } from "../../layout/index.js";
import { Diff } from "../diff.js";
import { createMarkdownExpandStream, expandWidgetPriors } from "../expand.js";
import { createStreamingMarkdown, markdownToLayout, softWrapParts } from "../internals/markdown-expand.js";
import { guessLang, runsToStyle, warmHighlighter } from "../internals/syntax.js";
import { Markdown } from "../markdown.js";
import { Text } from "../text.js";

const warmRetry = vi.hoisted(() => {
  const state: {
    failNext: boolean;
    realCreate: ((...args: never[]) => Promise<unknown>) | null;
  } = { failNext: false, realCreate: null };
  return {
    state,
    armFailure() {
      state.failNext = true;
    },
    disarm() {
      state.failNext = false;
    },
  };
});

vi.mock("shiki", async (importOriginal) => {
  const actual = await importOriginal<typeof import("shiki")>();
  const realCreate =
    actual.createHighlighter ??
    (actual as { default?: { createHighlighter?: typeof actual.createHighlighter } }).default?.createHighlighter;
  warmRetry.state.realCreate = realCreate as typeof warmRetry.state.realCreate;
  return {
    ...actual,
    createHighlighter: async (...args: unknown[]) => {
      if (warmRetry.state.failNext) {
        warmRetry.state.failNext = false;
        throw new Error("boom (simulated WASM load failure)");
      }
      if (typeof warmRetry.state.realCreate !== "function") {
        throw new TypeError("shiki createHighlighter missing");
      }
      return warmRetry.state.realCreate(...(args as never[]));
    },
  };
});

test("expandWidgetPriors", () => {
  const diff = expandWidgetPriors(
    Diff({
      old: "a\nb\nc\n",
      new: "a\nB\nc\n",
      path: "sample.ts",
      width: 40,
      key: "d",
    }),
  );
  const md = expandWidgetPriors(Markdown("# Title", { key: "md" }), { width: 40 });
  const voiced = expandWidgetPriors(Markdown("para", { key: "md", style: { role: "muted", prominence: 0.42 } }), {
    width: 40,
  });
  const collapsed = expandWidgetPriors(
    {
      type: "disclosure",
      collapsed: true,
      summary: Text("sum"),
      children: [Markdown("# hidden")],
    },
    { width: 40 },
  );
  const open = expandWidgetPriors(
    {
      type: "disclosure",
      collapsed: false,
      summary: Text("sum"),
      children: [Markdown("# shown")],
    },
    { width: 40 },
  );
  expect({
    diff: {
      type: diff.type,
      kind: diff.type === "indentation_exception" ? diff.kind : undefined,
    },
    markdown: md.type,
    mutedPara: findText(voiced, (n) => n.content.includes("para") && n.style?.role === "muted") != null,
    collapsedChild: collapsed.type === "disclosure" ? collapsed.children?.[0]?.type : undefined,
    openChild: open.type === "disclosure" ? open.children?.[0]?.type : undefined,
  }).toEqual({
    diff: { type: "indentation_exception", kind: "diff" },
    markdown: "box",
    mutedPara: true,
    collapsedChild: "markdown",
    openChild: "box",
  });
});

test("markdown expand stream appends live and ends once on seal", () => {
  const stream = createMarkdownExpandStream();
  const live1 = stream.pull({
    content: "hello wor",
    live: true,
    width: 40,
    key: "md",
  });
  const live2 = stream.pull({
    content: "hello world",
    live: true,
    width: 40,
    key: "md",
  });
  const sealed = stream.pull({
    content: "hello world",
    live: false,
    width: 40,
    key: "md",
  });
  expect(collectText(live1)).toContain("hello wor");
  expect(collectText(live2)).toContain("hello world");
  expect(collectText(sealed)).toContain("hello world");

  const fence = createMarkdownExpandStream();
  const open = fence.pull({
    content: "```ts\nconst x = 1",
    live: true,
    width: 40,
    key: "md",
  });
  expect(collectText(open)).toContain("const x = 1");
});

test("softWrapParts uses wrapText last-space breaks", () => {
  const join = (rows: { text: string }[][]) => rows.map((row) => row.map((p) => p.text).join(""));

  expect(join(softWrapParts([{ text: "hello world", style: {} }], 8))).toEqual(["hello ", "world"]);

  const mixed = softWrapParts(
    [
      { text: "hello ", style: {} },
      { text: "world", style: { bold: true } },
    ],
    8,
  );
  expect(join(mixed)).toEqual(["hello ", "world"]);
  expect(mixed[1]?.[0]?.style.bold).toBe(true);

  const prose = "so the extra lines describe the actual package.";
  const cut = "so the extra lines describe the a".length;
  expect(join(softWrapParts([{ text: prose, style: {} }], cut))).toEqual([
    "so the extra lines describe the ",
    "actual package.",
  ]);

  const mdLines = collectText(markdownToLayout(prose, { width: cut })).split("\n");
  expect(mdLines.some((line) => line.includes("actual package."))).toBe(true);
  expect(mdLines.some((line) => line.trimStart().startsWith("ctual"))).toBe(false);
});

test("markdownToLayout", async () => {
  const glued = collectText(markdownToLayout("before\x1b[2Jafter")).replaceAll("\n", "");
  const spaced = collectText(markdownToLayout("before \x1b[2J after")).replaceAll("\n", "");
  const sgr = collectText(markdownToLayout("hello \x1b[1;31m world")).replaceAll("\n", "");
  const bold = collectText(markdownToLayout("**bold\x1b[0mreset** still")).replaceAll("\n", "");
  expect({
    glued,
    spaced: spaced.replaceAll(/\s+/g, " "),
    sgr: sgr.replaceAll(/\s+/g, " "),
    bold,
  }).toEqual({
    glued: "beforeafter",
    spaced: "before after",
    sgr: "hello world",
    bold: expect.stringMatching(/boldreset.*still/),
  });
  expect(glued).not.toContain("2J");
  expect(glued).not.toContain("[");
  expect(bold).not.toContain("0m");
  expect(bold).not.toContain("**");

  const wrapped = markdownToLayout(
    "hello from **markdown** and more words that definitely exceed a narrow column budget for ordinary chat text rendering",
    { width: 28 },
  );
  const wrapRows = walk(wrapped).filter((n) => typeof n.key === "string" && /:w\d+$/.test(n.key));
  const spacedInline = collectText(markdownToLayout("hello from **markdown** and `code`")).replaceAll("\n", "");
  expect({
    wrapKeys: wrapRows.length > 0,
    wrapJoined: collectText(wrapped).replaceAll(/\s+/g, ""),
    spacedInline: {
      from: /from\s+markdown/.test(spacedInline),
      and: /markdown\s+and/.test(spacedInline),
      code: /and\s+code/.test(spacedInline),
      glued: spacedInline.includes("frommarkdown") || spacedInline.includes("markdownand"),
    },
  }).toEqual({
    wrapKeys: true,
    wrapJoined: expect.stringContaining("rendering"),
    spacedInline: { from: true, and: true, code: true, glued: false },
  });

  const texts = collectStyled(
    markdownToLayout("# Title\n\n### Sub\n\nhello **bold** and `code` and [link](https://x)\n"),
  );
  const title = texts.find((t) => t.content.includes("Title"));
  const sub = texts.find((t) => t.content.includes("Sub"));
  const hello = texts.find((t) => t.content.includes("hello"));
  const code = texts.find((t) => t.content === "code");
  const link = texts.find((t) => t.content === "link");
  const inherited = collectStyled(markdownToLayout("# Hi\n\npara", { style: { role: "muted", prominence: 0.42 } }));
  expect({
    title,
    sub,
    hello: { role: hello?.role, primary: hello?.prominence === 1 },
    code: { role: code?.role, prominence: code?.prominence },
    link: { role: link?.role, prominence: link?.prominence },
    inheritTitle: inherited.find((t) => t.content.includes("Hi")),
    inheritPara: inherited.find((t) => t.content.includes("para")),
  }).toMatchObject({
    title: { role: "foreground", prominence: 1 },
    sub: { role: "foreground", prominence: 1 },
    hello: { role: "foreground", primary: false },
    code: { role: "code", prominence: hello?.prominence },
    link: { role: "accent", prominence: hello?.prominence },
    inheritTitle: { role: "muted", prominence: 1 },
    inheritPara: { role: "muted", prominence: 0.42 },
  });

  const fence = findKind(markdownToLayout("```ts\nconst x = 1\n```\n"), "code_pad");
  const strikes: Array<{ content: string; strike?: boolean; dim?: boolean }> = [];
  walkCollect(markdownToLayout("keep ~~remove~~ keep"), (n) => {
    if (n.type === "text" && n.style?.strike) {
      strikes.push({ content: n.content, strike: n.style.strike, dim: n.style.dim });
    }
  });
  expect({
    fence: {
      type: fence?.type,
      kind: fence && fence.type === "indentation_exception" ? fence.kind : undefined,
      body: fence ? collectText(fence) : "",
    },
    strike: strikes,
  }).toEqual({
    fence: {
      type: "indentation_exception",
      kind: "code_pad",
      body: expect.stringContaining("const x = 1"),
    },
    strike: [{ content: "remove", strike: true, dim: undefined }],
  });

  const hrefTree = markdownToLayout("[x](http://a\x1b[2Jb)");
  const hrefVisible = collectText(hrefTree);
  const hrefs = collectHrefs(hrefTree);
  const src = collectText(markdownToLayout("![a](http://a\x1b[2Jb)"));
  const lang = collectText(markdownToLayout("```ts\x1b[2J\nconst x = 1\n```\n"));
  expect({
    href: {
      visible: hrefVisible.includes("http://"),
      url: hrefs.includes("http://ab"),
      csi: hrefs.some((h) => /\[2J|\x1b|2J/.test(h)),
    },
    src: { url: src.includes("http://ab"), csi: /\[2J|\x1b|2J/.test(src) },
    lang: {
      body: lang.includes("const x = 1"),
      csi: /\[2J|\x1b/.test(lang),
    },
  }).toEqual({
    href: { visible: false, url: true, csi: false },
    src: { url: true, csi: false },
    lang: { body: true, csi: false },
  });

  const quote = markdownToLayout("> quoted **line** with `code`\n");
  const bar = findIndication(quote);
  const body = findText(quote, (n) => n.content.includes("quoted") && n.style?.role === "foreground");
  const gapQuote = findIndication(markdownToLayout("> first\n>\n> second\n"));
  const gapKids = gapQuote?.type === "indication" ? (gapQuote.children ?? []) : [];
  expect({
    bar: {
      type: bar?.type,
      gutter: bar?.type === "indication" ? bar.gutter.kind : undefined,
      role: bar?.type === "indication" ? bar.style?.role : undefined,
      quieter: (bar?.type === "indication" ? (bar.style?.prominence ?? 1) : 1) < (body?.style?.prominence ?? 0),
    },
    gap: {
      length: gapKids.length,
      mid: gapKids[1],
      body: gapKids.map(collectText).join("|"),
    },
  }).toMatchObject({
    bar: { type: "indication", gutter: "rule", role: "border", quieter: true },
    gap: {
      length: 3,
      mid: { type: "text", content: " " },
      body: expect.stringMatching(/first[\s\S]*second/),
    },
  });

  const tableSrc = `| check | status | ms |
|---|---|---|
| compile | ok | 812 |
| test | ok | 4021 |
| lint | warn | 233 |
`;
  const grid = findGrid(markdownToLayout(tableSrc, { key: "tbl" }));
  expect({
    type: grid?.type,
    texts: (grid?.children ?? []).map((c) => (c.type === "text" ? c.content.trim() : collectText(c).trim())),
  }).toEqual({
    type: "grid",
    texts: ["check", "status", "ms", "compile", "ok", "812", "test", "ok", "4021", "lint", "warn", "233"],
  });

  const flow = (markdown: string) => {
    const root = markdownToLayout(markdown, { key: "m" });
    if (root.type !== "box") return [];
    return (root.children ?? []).map((c) =>
      c.type === "indication"
        ? "quote"
        : c.type === "grid"
          ? "table"
          : c.type === "text" && c.content === " "
            ? "gap"
            : "block",
    );
  };
  expect({
    quoteMid: flow("before\n\n> quoted\n\nafter\n"),
    quoteLead: flow("> quoted\n\nafter\n"),
    quoteTrail: flow("before\n\n> quoted\n"),
    quoteOnly: flow("> quoted\n"),
    tableMid: flow("before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n"),
    tableLead: flow("| a | b |\n|---|---|\n| 1 | 2 |\n\nafter\n"),
    tableTrail: flow("before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"),
    paraMid: flow("first\n\nsecond\n"),
    paraOnly: flow("only\n"),
    headingPara: flow("# Title\n\npara\n"),
    listTight: flow("- a\n- b\n"),
  }).toEqual({
    quoteMid: ["block", "gap", "quote", "gap", "block"],
    quoteLead: ["quote", "gap", "block"],
    quoteTrail: ["block", "gap", "quote"],
    quoteOnly: ["quote"],
    tableMid: ["block", "gap", "table", "gap", "block"],
    tableLead: ["table", "gap", "block"],
    tableTrail: ["block", "gap", "table"],
    paraMid: ["block", "gap", "block"],
    paraOnly: ["block"],
    headingPara: ["block", "gap", "block"],
    listTight: ["block", "block"],
  });

  const cold = fenceOf(markdownToLayout("```ts\nconst x = 1;\n```\n", { key: "m", width: 60 }));
  const coldChild = cold.children![0];
  expect({
    type: coldChild?.type,
    role: coldChild?.type === "text" ? coldChild.style?.role : undefined,
  }).toEqual({ type: "text", role: "code" });

  await warmHighlighter();
  const warm = fenceOf(markdownToLayout("```ts\nconst x: number = 1;\n```\n", { key: "m", width: 60 }));
  const guessed = fenceOf(markdownToLayout("```\ndef greet(name):\n    return name\n```\n", { key: "m", width: 60 }));
  const plain = fenceOf(markdownToLayout("```\nsome plain prose without code at all\n```\n", { key: "m", width: 60 }));
  const warmRow = warm.children![0]!;
  expect({
    warmType: warmRow.type,
    guessedType: guessed.children![0]!.type,
    plain: plain.children![0],
  }).toMatchObject({
    warmType: "flex",
    guessedType: "flex",
    plain: { type: "text", style: { role: "code" } },
  });
}, 60_000);

test.each([
  {
    name: "bold+italic never dim",
    got: () => runsToStyle({ text: "a", bold: true, italic: true }),
    out: { bold: true, italic: true },
  },
  {
    name: "invalid color",
    got: () => runsToStyle({ text: "a", color: "not-hex" }),
    out: {},
  },
  { name: "shebang bash", got: () => guessLang("#!/bin/bash\necho hi"), out: "bash" },
  {
    name: "shebang python",
    got: () => guessLang("#!/usr/bin/env python3\nprint(1)"),
    out: "python",
  },
  {
    name: "shebang node",
    got: () => guessLang("#!/usr/bin/env node\nconsole.log(1)"),
    out: "javascript",
  },
  { name: "json", got: () => guessLang('{"a": 1, "b": [2, 3]}'), out: "json" },
  {
    name: "python keywords",
    got: () => guessLang("def greet(name):\n    return name"),
    out: "python",
  },
  {
    name: "typescript keywords",
    got: () => guessLang("const x: number = 1;\ntype T = { a: string };"),
    out: "typescript",
  },
  {
    name: "rust keywords",
    got: () => guessLang("fn main() {\n    let mut x = 1;\n}"),
    out: "rust",
  },
  {
    name: "sql keywords",
    got: () => guessLang("SELECT id FROM users WHERE age > 21;"),
    out: "sql",
  },
  {
    name: "undetectable prose",
    got: () => guessLang("some plain prose without code at all"),
    out: undefined,
  },
  { name: "empty", got: () => guessLang(""), out: undefined },
])("runsToStyle + guessLang $name", ({ got, out }) => {
  expect(got()).toEqual(out);
});

test.each([
  { name: "paragraph", src: "hello world", needle: "hello world" },
  { name: "heading", src: "# My Title", needle: "My Title" },
  { name: "blockquote", src: "> quoted text", needle: "quoted text" },
])("PIN C1 $name keeps last char before end()", ({ src, needle }) => {
  const s = createStreamingMarkdown({ key: "m" });
  s.write(src);
  expect(collectText({ type: "box", key: "root", children: s.nodes() })).toContain(needle);
});

test("live unclosed inline stays on the same line as preceding prose", () => {
  const stream = createMarkdownExpandStream();
  const lines = (content: string) =>
    collectText(stream.pull({ content, live: true, width: 80, key: "md" }))
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => l.trimEnd());
  expect(lines("hello `")).toEqual(["hello `"]);
  expect(lines("hello `string")).toEqual(["hello string"]);
  expect(lines("hello `string`")).toEqual(["hello string"]);
  expect(lines("hello `string` world")).toEqual(["hello string world"]);
});

test("table cells wrap to column tracks, not document width", () => {
  const width = 48;
  const long = "The content of one fetch is stored or retrieved under another request URL plus TAILWORD";
  const mixed = "A test record enters production. [example.com](http://example.com) is a mistake TAILMIX";
  const src = [
    "| Mechanism | How it would produce this result |",
    "|---|---|",
    `| Cache-key bug | ${long} |`,
    `| Fixture leakage | ${mixed} |`,
  ].join("\n");

  const sealed = markdownToLayout(src, { width, key: "tbl" });
  const live = createStreamingMarkdown({ key: "tbl", width });
  live.write(src);
  const liveRoot: LayoutNode = { type: "box", key: "r", children: live.nodes() };

  const read = (root: LayoutNode) => {
    const cells = findGrid(root)?.children ?? [];
    const plain = cellLines(cells[3]!);
    const linked = cellLines(cells[5]!);
    const cap = 36;
    return {
      plain: {
        wraps: plain.length > 1,
        fitsColumn: plain.every((l) => l.length <= cap),
        tail: collectText(cells[3]!).includes("TAILWORD"),
      },
      mixed: {
        wraps: linked.length > 1,
        fitsColumn: linked.every((l) => l.length <= cap),
        tail: collectText(cells[5]!).includes("TAILMIX"),
        link: collectStyled(cells[5]!).some((s) => s.content.includes("example.com") && s.role === "accent"),
      },
    };
  };

  const fit = {
    plain: { wraps: true, fitsColumn: true, tail: true },
    mixed: { wraps: true, fitsColumn: true, tail: true, link: true },
  };
  expect({ sealed: read(sealed), live: read(liveRoot) }).toEqual({ sealed: fit, live: fit });
});

test("wide table overflow wraps the long column instead of a 1-wide spine", () => {
  const width = 80;
  const src = [
    "| | Pi | OpenCode | Codex | this harness |",
    "|---|---|---|---|---|",
    "| Chat reasoning-content | yes, plus empty-inject for DeepSeek | yes if interleaved.field | n/a (Responses) | yes, omit when empty (Grok miss if cached) |",
  ].join("\n");
  const root = markdownToLayout(src, { width, key: "tbl" });
  const cells = findGrid(root)?.children ?? [];
  const plain = (n: LayoutNode) => collectText(n).replaceAll("\n", "");
  const lastBody = cells.find((c) => plain(c).includes("cached"));
  const bodyLines = lastBody ? cellLines(lastBody) : [];
  const lineMax = (lines: string[]) => Math.max(0, ...lines.map((l) => l.trimEnd().length));
  const spines = cells.filter((c) => {
    const lines = cellLines(c);
    return lines.length > 2 && lines.every((l) => l.trim().length <= 1);
  });
  expect({
    cols: cells.length,
    split: cells.map(plain).includes("yes if interleaved.field"),
    spines: spines.length,
    wordFloor: lineMax(bodyLines) >= "harness".length,
    tail: Boolean(lastBody),
  }).toEqual({
    cols: 10,
    split: true,
    spines: 0,
    wordFloor: true,
    tail: true,
  });
});

test("nested markdown containers wrap to remaining budget, not document width", () => {
  const width = 40;
  const quoteInner = width - INDICATION_CONTENT_INSET;
  const nestedInner = quoteInner - INDICATION_CONTENT_INSET;
  const long =
    "Use period, establish or retrieve a baseline, check for newly added comments on each execution, and end the schedule when the requested notification condition is met";

  const snap = (src: string, live = false): LayoutNode => {
    if (!live) return markdownToLayout(src, { width, key: "md" });
    const s = createStreamingMarkdown({ key: "md", width });
    s.write(src);
    return { type: "box", key: "r", children: s.nodes() };
  };

  const quoteFit = (src: string, cap: number, tail: string, live = false) => {
    const root = snap(src, live);
    const bq = findIndication(root);
    const rows = bq ? wrapRowTexts(bq) : [];
    return {
      wraps: rows.length > 1,
      fits: rows.every((row) => row.length <= cap),
      tail: collectText(root).includes(tail),
    };
  };

  const ok = { wraps: true, fits: true, tail: true };
  const nested = snap(`> > ${long} TAILNEST`);
  const inner = findDeepIndication(nested);
  const nestedRows = inner ? wrapRowTexts(inner) : [];
  const prior = expandWidgetPriors(
    {
      type: "indication",
      key: "s",
      gutter: { kind: "top", glyph: " " },
      children: [Markdown(`${long} TAILSPEECH`, { key: "md" })],
    },
    { width },
  );
  const speechRows = wrapRowTexts(prior);
  const speechQuote = expandWidgetPriors(
    {
      type: "indication",
      key: "s",
      gutter: { kind: "top", glyph: " " },
      children: [Markdown(`> **Recurring:** ${long} TAILINSET`, { key: "md" })],
    },
    { width },
  );
  const quoted = findDeepIndication(speechQuote);
  const quotedRows = quoted ? wrapRowTexts(quoted) : [];

  expect({
    sealed: quoteFit(`> **Recurring:** ${long} TAILQUOTE`, quoteInner, "TAILQUOTE"),
    live: quoteFit(`> **Recurring:** ${long} TAILQUOTE`, quoteInner, "TAILQUOTE", true),
    nested: {
      wraps: nestedRows.length > 1,
      fits: nestedRows.every((row) => row.length <= nestedInner),
      tail: collectText(nested).includes("TAILNEST"),
    },
    list: quoteFit(`> - ${long} TAILLIST`, quoteInner, "TAILLIST"),
    speechPrior: {
      wraps: speechRows.length > 1,
      fits: speechRows.every((row) => row.length <= quoteInner),
      tail: collectText(prior).includes("TAILSPEECH"),
    },
    speechQuote: {
      wraps: quotedRows.length > 1,
      fits: quotedRows.every((row) => row.length <= nestedInner),
      tail: collectText(speechQuote).includes("TAILINSET"),
    },
  }).toEqual({
    sealed: ok,
    live: ok,
    nested: ok,
    list: ok,
    speechPrior: ok,
    speechQuote: ok,
  });
});

test("live table snapshot is a grid of cells we can paint", () => {
  const header = "| check | status | ms |";
  const sep = `${header}\n|---|---|---|`;
  const snap = (src: string) => {
    const s = createStreamingMarkdown({ key: "m" });
    s.write(src);
    const root: LayoutNode = { type: "box", key: "r", children: s.nodes() };
    const grid = findGrid(root);
    return {
      top: root.children?.map((c) => c.type) ?? [],
      cols: grid?.style.columns.length,
      cells: (grid?.children ?? []).map((c) => collectText(c).trim()),
      sep: collectText(root).includes("|---"),
    };
  };
  expect({
    midHeader: snap("| check | status"),
    headerDone: snap(`${header}\n`),
    separator: snap(sep),
    midBody: snap(`${sep}\n| compile | ok`),
    bodyRow: snap(`${sep}\n| compile | ok | 812 |\n`),
  }).toEqual({
    midHeader: { top: ["grid"], cols: 2, cells: ["check", "status"], sep: false },
    headerDone: { top: ["grid"], cols: 3, cells: ["check", "status", "ms"], sep: false },
    separator: { top: ["grid"], cols: 3, cells: ["check", "status", "ms"], sep: false },
    midBody: {
      top: ["grid"],
      cols: 3,
      cells: ["check", "status", "ms", "compile", "ok"],
      sep: false,
    },
    bodyRow: {
      top: ["grid"],
      cols: 3,
      cells: ["check", "status", "ms", "compile", "ok", "812"],
      sep: false,
    },
  });
});

test("PIN C4 warmHighlighter retries after a failure", async () => {
  warmRetry.armFailure();
  try {
    vi.resetModules();
    const mod = await import("../internals/syntax.js");
    await expect(mod.warmHighlighter()).rejects.toThrow("boom");
    expect(mod.isHighlighterReady()).toBe(false);
    await mod.warmHighlighter();
    expect(mod.isHighlighterReady()).toBe(true);
  } finally {
    warmRetry.disarm();
  }
}, 60_000);

function cellLines(node: LayoutNode): string[] {
  if (node.type === "box") return (node.children ?? []).map((c) => collectText(c));
  return [collectText(node)];
}

/** Frozen wrap rows (nowrap text/flex). Indication children only — not the gutter. */
function wrapRowTexts(node: LayoutNode): string[] {
  if (node.type === "text" || node.type === "flex") return [collectText(node)];
  if (
    node.type === "box" ||
    node.type === "indication" ||
    node.type === "indentation_exception" ||
    node.type === "viewport"
  ) {
    return (node.children ?? []).flatMap(wrapRowTexts);
  }
  return [collectText(node)];
}

function findDeepIndication(node: LayoutNode): LayoutNode | undefined {
  if (node.type === "indication") {
    const nested = (node.children ?? []).map(findDeepIndication).find((n) => n !== undefined);
    return nested ?? node;
  }
  const kids = "children" in node && Array.isArray(node.children) ? node.children : [];
  for (const c of kids) {
    const hit = findDeepIndication(c);
    if (hit) return hit;
  }
  return undefined;
}

function collectText(node: LayoutNode): string {
  switch (node.type) {
    case "text":
      return node.content;
    case "flex":
      return (node.children ?? []).map(collectText).join("");
    case "grid": {
      const cols = Math.max(1, node.style.columns.length);
      const cells = (node.children ?? []).map(collectText);
      const rows: string[] = [];
      for (let i = 0; i < cells.length; i += cols) {
        rows.push(cells.slice(i, i + cols).join(" "));
      }
      return rows.join("\n");
    }
    case "box":
    case "viewport":
    case "indication":
    case "indentation_exception":
    case "overlay":
      return (node.children ?? []).map(collectText).join("\n");
    case "markdown":
      return node.content;
    default:
      return "";
  }
}

function walk(node: LayoutNode, acc: LayoutNode[] = []): LayoutNode[] {
  acc.push(node);
  const kids = "children" in node && Array.isArray(node.children) ? node.children : [];
  for (const c of kids) walk(c, acc);
  return acc;
}

function walkCollect(node: LayoutNode, visit: (n: LayoutNode) => void): void {
  visit(node);
  const kids = "children" in node && Array.isArray(node.children) ? node.children : [];
  for (const c of kids) walkCollect(c, visit);
}

function collectHrefs(node: LayoutNode, acc: string[] = []): string[] {
  if (node.type === "text" && node.style?.href) acc.push(node.style.href);
  const kids = "children" in node && Array.isArray(node.children) ? node.children : [];
  for (const c of kids) collectHrefs(c, acc);
  return acc;
}

function collectStyled(
  node: LayoutNode,
  acc: Array<{ content: string; role?: string; prominence?: number }> = [],
): Array<{ content: string; role?: string; prominence?: number }> {
  if (node.type === "text") {
    acc.push({
      content: node.content,
      role: node.style?.role,
      prominence: node.style?.prominence,
    });
  }
  const kids = "children" in node && Array.isArray(node.children) ? node.children : [];
  for (const c of kids) collectStyled(c, acc);
  return acc;
}

function findKind(node: LayoutNode, kind: string): LayoutNode | undefined {
  if (node.type === "indentation_exception" && node.kind === kind) return node;
  const kids = "children" in node && Array.isArray(node.children) ? node.children : [];
  for (const c of kids) {
    const hit = findKind(c, kind);
    if (hit) return hit;
  }
  return undefined;
}

function findIndication(node: LayoutNode): LayoutNode | undefined {
  if (node.type === "indication") return node;
  const kids = "children" in node && Array.isArray(node.children) ? node.children : [];
  for (const c of kids) {
    const hit = findIndication(c);
    if (hit) return hit;
  }
  return undefined;
}

function findGrid(node: LayoutNode): Extract<LayoutNode, { type: "grid" }> | undefined {
  if (node.type === "grid") return node;
  const kids = "children" in node && Array.isArray(node.children) ? node.children : [];
  for (const c of kids) {
    const hit = findGrid(c);
    if (hit) return hit;
  }
  return undefined;
}

function findText(
  node: LayoutNode,
  pred: (n: Extract<LayoutNode, { type: "text" }>) => boolean,
): Extract<LayoutNode, { type: "text" }> | undefined {
  if (node.type === "text" && pred(node)) return node;
  const kids = "children" in node && Array.isArray(node.children) ? node.children : [];
  for (const c of kids) {
    const hit = findText(c, pred);
    if (hit) return hit;
  }
  return undefined;
}

function fenceOf(root: LayoutNode) {
  const fence = findKind(root, "code_pad");
  if (fence?.type !== "indentation_exception") {
    throw new Error("expected code_pad");
  }
  return fence;
}
