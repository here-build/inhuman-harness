import { expect, test } from "vitest";

import { createBuffer, clear, type Style } from "../../buffer/index.js";
import {
  layout,
  paintFrame,
  serializeSelection,
  forEachHighlightCell,
  extendSelection,
  startSelection,
  type LayoutNode,
} from "../../layout/index.js";
import { BgP, FgP } from "../../lexicon/index.js";
import { buildDiffLayout, parsePatchToLayout } from "../internals/diff-expand.js";
import { warmHighlighter } from "../internals/syntax.js";

test("diff expand structure + roles + line numbers", () => {
  const expanded = buildDiffLayout({
    old: "a\nb\nc\n",
    new: "a\nB\nc\n",
    path: "sample.ts",
    width: 40,
    mode: "auto",
  });
  const autoFits = buildDiffLayout({
    old: "export const a = 1;\n",
    new: "export const a = 2;\n",
    path: "a.ts",
    width: 80,
    mode: "auto",
    key: "d-fit",
  });
  const autoOverflow = buildDiffLayout({
    old: `${"x".repeat(60)}\n`,
    new: `${"y".repeat(60)}\n`,
    path: "w.ts",
    width: 80,
    mode: "auto",
    key: "d-wide-line",
  });
  const autoNarrowOverflow = buildDiffLayout({
    old: `${"x".repeat(40)}\n`,
    new: `${"y".repeat(40)}\n`,
    path: "w.ts",
    width: 40,
    mode: "auto",
    key: "d",
  });
  const autoPureAdd = buildDiffLayout({
    old: "keep\n",
    new: "keep\nadded\n",
    path: "a.ts",
    width: 80,
    mode: "auto",
    key: "pure-add",
  });
  const autoPureDel = buildDiffLayout({
    old: "keep\ngone\n",
    new: "keep\n",
    path: "a.ts",
    width: 80,
    mode: "auto",
    key: "pure-del",
  });
  const autoAddAndDel = buildDiffLayout({
    old: "keepA\ngone\nkeepB\n",
    new: "keepA\nkeepB\nadded\n",
    path: "a.ts",
    width: 80,
    mode: "auto",
    key: "add-and-del",
  });
  const split = buildDiffLayout({
    old: "a\nb\n",
    new: "a\nc\n",
    path: "s.ts",
    width: 100,
    mode: "split",
    key: "split",
  });
  const empty = buildDiffLayout({
    old: "",
    new: "",
    path: "empty.txt",
    width: 60,
  });
  const create = buildDiffLayout({
    old: "",
    new: 'export const greeting = "hello";\n',
    path: "hello.ts",
    width: 80,
    hideHeader: true,
    key: "create",
  });
  const createStyles = collectStyles(create);
  const header = buildDiffLayout({
    old: "x\n",
    new: "y\n",
    path: "src/app.ts",
    width: 80,
  });
  const crlf = buildDiffLayout({
    old: "old\r\n",
    new: "new\r\n",
    path: "crlf.txt",
    width: 60,
    mode: "unified",
  });
  const crlfJoined = collectText(crlf).join("");
  // 67-col old line overflows a 120-col half-pane (56). Painted width is
  // the source line — collapsing deleted entities would fake a split fit.
  const pairPing = buildDiffLayout({
    old: `    const pair = run("(list (tool/call 'ping) (tool/call 'ping))");`,
    new: `    const pair = run("(list (ping) (ping))");`,
    path: "eval.test.ts",
    width: 120,
    mode: "auto",
    noHighlight: true,
    hideHeader: true,
    key: "pair-ping",
  });
  const pairPingText = collectText(pairPing).join("");
  const eofOnly = buildDiffLayout({
    old: "hello",
    new: "hello\n",
    path: "eof.ts",
    width: 80,
    mode: "unified",
    noHighlight: true,
    hideHeader: true,
    key: "eof",
  });
  const eofReal = buildDiffLayout({
    old: "hello",
    new: "hello!\n",
    path: "eof.ts",
    width: 80,
    mode: "unified",
    noHighlight: true,
    hideHeader: true,
    key: "eof-real",
  });
  const eofJoined = collectText(eofReal).join("");
  expect({
    expand: {
      type: expanded.type,
      kind: expanded.type === "indentation_exception" ? expanded.kind : undefined,
    },
    halves: {
      autoFits: hasHalves(autoFits),
      autoOverflow: hasHalves(autoOverflow),
      autoNarrowOverflow: hasHalves(autoNarrowOverflow),
      autoPureAdd: hasHalves(autoPureAdd),
      autoPureDel: hasHalves(autoPureDel),
      autoAddAndDel: hasHalves(autoAddAndDel),
      split: hasHalves(split),
      pairPing: hasHalves(pairPing),
    },
    pairPingOld: {
      full: pairPingText.includes("(tool/call 'ping)"),
      ellipsis: pairPingText.includes("…"),
    },
    empty: {
      type: empty.type,
      kind: empty.type === "indentation_exception" ? empty.kind : undefined,
      texts: collectText(empty),
    },
    header: collectText(header).includes("src/app.ts · proposed"),
    crlf: {
      hasReturn: crlfJoined.includes("\r"),
      hasOld: crlfJoined.includes("old"),
      hasNew: crlfJoined.includes("new"),
    },
    eof: collectText(eofOnly),
    eofReal: { old: eofJoined.includes("hello"), next: eofJoined.includes("hello!") },
  }).toEqual({
    expand: { type: "indentation_exception", kind: "diff" },
    halves: {
      autoFits: true,
      autoOverflow: false,
      autoNarrowOverflow: false,
      autoPureAdd: false,
      autoPureDel: false,
      autoAddAndDel: false,
      split: true,
      pairPing: false,
    },
    pairPingOld: { full: true, ellipsis: false },
    empty: {
      type: "indentation_exception",
      kind: "diff",
      texts: ["empty.txt · proposed", "(empty)"],
    },
    header: true,
    crlf: { hasReturn: false, hasOld: true, hasNew: true },
    eof: ["no changes"],
    eofReal: { old: true, next: true },
  });
  expect({
    halves: hasHalves(create),
    texts: collectText(create).some((t) => t.includes("export const greeting")),
    addWash: createStyles.some((s) => s.bgRole === "diff_add"),
  }).toEqual({ halves: false, texts: true, addWash: true });

  const roles = collectStyles(
    buildDiffLayout({
      old: "const a = 1;\n",
      new: "const a = 2;\n",
      path: "t.ts",
      width: 60,
      mode: "unified",
      noHighlight: true,
    }),
  );
  const roleStyles = roles.filter((s) => s.role === "diff_add" || s.role === "diff_del");
  const bgRoleStyles = roles.filter((s) => s.bgRole === "diff_add" || s.bgRole === "diff_del");
  const word = collectStyles(
    buildDiffLayout({
      old: "const value = oldName;\n",
      new: "const value = newName;\n",
      path: "t.ts",
      width: 60,
      mode: "unified",
      noHighlight: true,
    }),
  );
  const washed = word.filter(
    (s) => (s.bgRole === "diff_add" || s.bgRole === "diff_del") && s.bgProminence !== undefined,
  );
  const chromeNode = buildDiffLayout({
    old: "a\nb\nc\n",
    new: "a\nB\nc\n",
    path: "chrome.ts",
    width: 60,
    mode: "unified",
  });
  const chromeStyles = collectStyles(chromeNode).filter((s) => s.role === "chrome");
  const headerStyle = chromeStyles.find((s) => s.bold === true);
  const receded = chromeStyles.filter((s) => s.bold !== true);
  expect({
    roles: {
      count: roleStyles.length > 0,
      fgRgb: roleStyles.some((s) => s.fgRgb !== undefined),
      bgCount: bgRoleStyles.length > 0,
      bgRgb: bgRoleStyles.some((s) => s.bgRgb !== undefined),
      bgProminence: bgRoleStyles.every((s) => typeof s.bgProminence === "number"),
    },
    wordAlt: {
      mist: washed.some((s) => s.bgProminence === BgP.mist),
      panel: washed.some((s) => s.bgProminence === BgP.panel),
    },
    chrome: {
      dim: chromeStyles.some((s) => s.dim === true),
      headerProminence: headerStyle?.prominence,
      ghost: receded.some((s) => s.prominence === FgP.ghost),
    },
  }).toEqual({
    roles: { count: true, fgRgb: false, bgCount: true, bgRgb: false, bgProminence: true },
    wordAlt: { mist: true, panel: true },
    chrome: { dim: false, headerProminence: undefined, ghost: true },
  });

  const patch = [
    "diff --git a/x.ts b/x.ts",
    "index 111..222 100644",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -10,3 +10,3 @@",
    " keep1",
    "-oldLine",
    "+newLine",
    " keep2",
    "",
  ].join("\n");
  const texts = collectText(parsePatchToLayout(patch, 80, { mode: "unified" }));
  const oldIdx = texts.indexOf("oldLine");
  expect({ gutter: texts[oldIdx - 1], oldIdx: oldIdx > 0 }).toEqual({
    gutter: "11 ",
    oldIdx: true,
  });
});

test("diff highlighter maps mjs/mts/scm paths onto warm languages", async () => {
  await warmHighlighter();
  const colored = (path: string, code: string) =>
    collectStyles(
      buildDiffLayout({
        old: "",
        new: code,
        path,
        width: 80,
        hideHeader: true,
      }),
    ).some((s) => s.fgRgb !== undefined);
  expect({
    mjs: colored("mod.mjs", 'export const x = "hi";\n'),
    cjs: colored("mod.cjs", "module.exports = 1;\n"),
    mts: colored("mod.mts", 'export const x: string = "hi";\n'),
    cts: colored("mod.cts", 'export const x: string = "hi";\n'),
    scm: colored("hook.scm", '{:key "hi" :n 1}\n'),
    unknown: colored("notes.txt", 'export const x = "hi";\n'),
  }).toEqual({ mjs: true, cjs: true, mts: true, cts: true, scm: true, unknown: false });
}, 60_000);

test("add/del wash fills the pane past the last glyph", () => {
  const w = 80;
  const tree = buildDiffLayout({
    old: "a\n",
    new: "b\n",
    path: "a.ts",
    width: w,
    mode: "split",
    hideHeader: true,
    noHighlight: true,
  });
  const frame = layout(tree, { w, h: 6 });
  const buf = createBuffer(w, 6);
  clear(buf);
  paintFrame(frame, buf);
  const washed = (ch: string) => {
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < w; x++) {
        const cell = buf.cells[y * w + x]!;
        if (cell.ch !== ch) continue;
        const tail = buf.cells[y * w + Math.min(w - 1, x + 12)]!;
        return {
          glyphBg: cell.style.bgRgb !== undefined || cell.style.bgRole !== undefined,
          tailCh: tail.ch,
          tailBg: tail.style.bgRgb !== undefined || tail.style.bgRole !== undefined,
        };
      }
    }
    return { glyphBg: false, tailCh: "", tailBg: false };
  };
  expect({ a: washed("a"), b: washed("b") }).toEqual({
    a: { glyphBg: true, tailCh: " ", tailBg: true },
    b: { glyphBg: true, tailCh: " ", tailBg: true },
  });
});

test("lineStart shifts displayed numbers off the span origin", () => {
  const texts = collectText(
    buildDiffLayout({
      old: "two\n",
      new: "TWO\n",
      path: "a.ts",
      width: 40,
      mode: "unified",
      hideHeader: true,
      noHighlight: true,
      lineStart: 10,
    }),
  );
  expect({ ten: texts.includes("10 "), one: texts.includes("1 ") }).toEqual({
    ten: true,
    one: false,
  });
});

test("split mid-file hunk keeps two-digit file numbers", () => {
  const prefix = Array.from({ length: 45 }, (_, i) => `pre-${i}`).join("\n");
  const suffix = Array.from({ length: 20 }, (_, i) => `post-${i}`).join("\n");
  const old = `${prefix}\nconst resetInSec = raw.resetInSec ?? remaining.resetAt;\nconst exhausted = raw.status === "exhausted";\n${suffix}\n`;
  const next = `${prefix}\nconst resetInSec = raw.resetInSec ?? raw.resetsAt;\nconst exhausted = raw.status === "exhausted";\n${suffix}\n`;
  const texts = collectText(
    buildDiffLayout({
      old,
      new: next,
      path: "opencode-go.ts",
      width: 160,
      mode: "split",
      hideHeader: true,
      noHighlight: true,
    }),
  );
  expect({
    file: texts.includes("46 "),
    span: texts.includes("1 ") && !texts.includes("46 "),
    change: texts.some((t) => t.includes("resetsAt")),
  }).toEqual({
    file: true,
    span: false,
    change: true,
  });
});

test("paint elides distant context and keeps file line numbers", () => {
  const prefix = Array.from({ length: 20 }, (_, i) => `p${String(i).padStart(2, "0")}`).join("\n");
  const suffix = Array.from({ length: 20 }, (_, i) => `s${String(i).padStart(2, "0")}`).join("\n");
  const old = `${prefix}\nTARGET\n${suffix}\n`;
  const next = `${prefix}\nCHANGED\n${suffix}\n`;
  const elided = collectText(
    buildDiffLayout({
      old,
      new: next,
      path: "a.ts",
      width: 40,
      mode: "unified",
      hideHeader: true,
      noHighlight: true,
    }),
  );
  const shown = buildDiffLayout({
    old,
    new: next,
    path: "a.ts",
    width: 40,
    mode: "unified",
    hideHeader: true,
    noHighlight: true,
    context: "all",
  });
  const all = collectText(shown);
  expect({
    elided: {
      change: elided.includes("CHANGED"),
      near: elided.includes("p17"),
      far: elided.includes("p00"),
      omit: elided.some((t) => t.includes("unchanged")),
      line: elided.includes("21 "),
    },
    all: {
      far: all.includes("p00"),
      omit: all.some((t) => t.includes("unchanged")),
    },
  }).toEqual({
    elided: { change: true, near: true, far: false, omit: true, line: true },
    all: { far: true, omit: false },
  });
});

test("diff copy + highlight", () => {
  const unified = paintDiff("unified", 60);
  const stamps = codeHits(unified.frame, () => true);
  const chrome = [...unified.frame.byKey.values()].filter((m) => m.key.includes(":g") || m.key.includes(":n"));
  expect({
    count: stamps.length > 0,
    copy: { glyph: stamps.some((m) => m.diffLine!.text.includes("▌")) },
    lit: [],
    dark: { chrome: chrome.map((m) => m.userSelect) },
  }).toEqual({
    count: true,
    copy: { glyph: false },
    lit: [],
    dark: { chrome: chrome.map(() => "none") },
  });

  const w = 60;
  const fullSel = extendSelection(
    startSelection({ col: 0, row: Math.min(...stamps.map((m) => m.hitRect.y)) }, "line"),
    { col: w - 1, row: Math.max(...stamps.map((m) => m.hitRect.y + m.hitRect.h - 1)) },
  )!;
  const fullCopy = serializeSelection(
    { cells: unified.buf.cells, width: unified.buf.width, height: unified.buf.height },
    unified.frame,
    fullSel,
  );
  const gone = codeHits(unified.frame, (m) => m.diffLine!.kind === "del" && m.diffLine!.text === "gone")[0]!;
  const partial = serializeSelection(
    { cells: unified.buf.cells, width: unified.buf.width, height: unified.buf.height },
    unified.frame,
    extendSelection(startSelection({ col: gone.hitRect.x + 2, row: gone.hitRect.y }, "char"), {
      col: gone.hitRect.x + 3,
      row: gone.hitRect.y,
    })!,
  );
  expect({
    copy: {
      glyph: fullCopy.includes("▌"),
      del: fullCopy.includes("-gone"),
      add: fullCopy.includes("+here"),
      ctx: fullCopy.split("\n").some((l) => l.startsWith(" ") && l.includes("same")),
      ellipsis: fullCopy.includes("..."),
      partial: partial.trim(),
    },
    lit: [],
    dark: {},
  }).toEqual({
    copy: {
      glyph: false,
      del: true,
      add: true,
      ctx: true,
      ellipsis: false,
      partial: "-...ne",
    },
    lit: [],
    dark: {},
  });

  const split = paintDiff("split", 100, 20);
  const splitStamps = codeHits(split.frame, () => true);
  const splitCopy = serializeSelection(
    { cells: split.buf.cells, width: split.buf.width, height: split.buf.height },
    split.frame,
    extendSelection(startSelection({ col: 0, row: Math.min(...splitStamps.map((m) => m.hitRect.y)) }, "line"), {
      col: 99,
      row: Math.max(...splitStamps.map((m) => m.hitRect.y + m.hitRect.h - 1)),
    })!,
  );
  expect({
    copy: {
      same: splitCopy.split("\n").filter((l) => l.includes("same line")).length,
      del: splitCopy.includes("-gone"),
      add: splitCopy.includes("+here"),
    },
    lit: [],
    dark: {},
  }).toEqual({
    copy: { same: 1, del: true, add: true },
    lit: [],
    dark: {},
  });

  const left = codeHits(
    split.frame,
    (m) => m.diffLine!.kind === "ctx" && m.diffLine!.side === "L" && m.diffLine!.text.includes("same"),
  )[0]!;
  const right = codeHits(
    split.frame,
    (m) => m.diffLine!.kind === "ctx" && m.diffLine!.side === "R" && m.diffLine!.lineIndex === left.diffLine!.lineIndex,
  )[0]!;
  const midHits = highlightHits(
    extendSelection(startSelection({ col: left.hitRect.x + 2, row: left.hitRect.y }, "char"), {
      col: left.hitRect.x + 5,
      row: left.hitRect.y,
    })!,
    split,
  );
  const rowChrome = [...split.frame.byKey.values()].filter(
    (m) => (m.key.includes(":g") || m.key.includes(":n")) && m.hitRect.y === left.hitRect.y,
  );
  expect({
    copy: {},
    lit: {
      left: colsOn(midHits, left),
      right: colsOn(midHits, right),
    },
    dark: {
      chrome: rowChrome.some((g) => cellIn(midHits, g.hitRect)),
      gap: gapLit(midHits, left, right),
    },
  }).toEqual({
    copy: {},
    lit: {
      left: [left.hitRect.x + 2, left.hitRect.x + 3, left.hitRect.x + 4, left.hitRect.x + 5],
      right: [right.hitRect.x + 2, right.hitRect.x + 3, right.hitRect.x + 4, right.hitRect.x + 5],
    },
    dark: { chrome: false, gap: false },
  });

  const eolHits = highlightHits(
    extendSelection(startSelection({ col: left.hitRect.x, row: left.hitRect.y }, "char"), {
      col: 99,
      row: left.hitRect.y,
    })!,
    split,
  );
  const streamHits = highlightHits(
    extendSelection(startSelection({ col: left.hitRect.x + 2, row: left.hitRect.y }, "char"), {
      col: 99,
      row: left.hitRect.y,
    })!,
    split,
  );
  const staged = paintStagedSplit();
  const stageLeft = codeHits(
    staged.frame,
    (m) => m.diffLine!.kind === "ctx" && m.diffLine!.side === "L" && m.diffLine!.text.includes("same"),
  )[0]!;
  const stageRight = codeHits(
    staged.frame,
    (m) =>
      m.diffLine!.kind === "ctx" && m.diffLine!.side === "R" && m.diffLine!.lineIndex === stageLeft.diffLine!.lineIndex,
  )[0]!;
  const stageHits = highlightHits(
    extendSelection(startSelection({ col: stageLeft.hitRect.x, row: stageLeft.hitRect.y }, "char"), {
      col: 99,
      row: stageLeft.hitRect.y,
    })!,
    staged,
  );
  const leftCols = colsOn(streamHits, left);
  const rightCols = colsOn(streamHits, right);
  expect({
    copy: {},
    lit: {
      pad: {
        left: eolHits.some((h) => h.col === left.hitRect.x && h.row === left.hitRect.y),
        right: eolHits.some((h) => h.col === right.hitRect.x && h.row === right.hitRect.y),
      },
      stream: {
        leftStart: leftCols[0],
        leftEnd: leftCols[leftCols.length - 1],
        rightStart: rightCols[0],
        rightEnd: rightCols[rightCols.length - 1],
      },
      stage: {
        left: stageHits.some((h) => h.col === stageLeft.hitRect.x && h.row === stageLeft.hitRect.y),
        right: stageHits.some((h) => h.col === stageRight.hitRect.x && h.row === stageRight.hitRect.y),
      },
    },
    dark: {
      padGap: gapLit(eolHits, left, right),
      streamLeftOrigin: leftCols.includes(left.hitRect.x),
      streamRightOrigin: rightCols.includes(right.hitRect.x),
      stageGap: gapLit(stageHits, stageLeft, stageRight),
    },
  }).toEqual({
    copy: {},
    lit: {
      pad: { left: true, right: true },
      stream: {
        leftStart: left.hitRect.x + 2,
        leftEnd: left.hitRect.x + left.hitRect.w - 1,
        rightStart: right.hitRect.x + 2,
        rightEnd: right.hitRect.x + right.hitRect.w - 1,
      },
      stage: { left: true, right: true },
    },
    dark: {
      padGap: false,
      streamLeftOrigin: false,
      streamRightOrigin: false,
      stageGap: false,
    },
  });
});

const OLD = `${["alpha", "same line", "beta", "gone"].join("\n")}\n`;
const NEW = `${["alpha", "same line", "beta", "here"].join("\n")}\n`;

function paintDiff(mode: "unified" | "split", width: number, height = 24) {
  const tree = buildDiffLayout({
    old: OLD,
    new: NEW,
    path: "f.ts",
    width,
    mode,
    key: "diff",
    context: "all",
    lineDiffType: "none",
    noHighlight: true,
    hideHeader: true,
  });
  const frame = layout(tree, { w: width, h: height });
  const buf = createBuffer(width, height);
  clear(buf);
  paintFrame(frame, buf);
  return { frame, buf, tree };
}

function paintStagedSplit() {
  const w = 100;
  const h = 20;
  const diff = buildDiffLayout({
    old: OLD,
    new: NEW,
    path: "f.ts",
    width: w,
    mode: "split",
    key: "diff",
    context: "all",
    lineDiffType: "none",
    noHighlight: true,
    hideHeader: true,
  });
  const tree = {
    type: "box" as const,
    key: "stage",
    userSelect: "text" as const,
    style: { width: w, height: h },
    children: [diff],
  };
  const frame = layout(tree, { w, h });
  const buf = createBuffer(w, h);
  clear(buf);
  paintFrame(frame, buf);
  return { frame, buf, tree };
}

function codeHits(
  frame: ReturnType<typeof layout>,
  pred: (m: {
    diffLine?: { kind: string; side?: string; text: string; lineIndex: number };
    userSelect: string;
    element?: { kind: string };
    hitRect: { x: number; y: number; w: number; h: number };
    key: string;
  }) => boolean,
) {
  return [...frame.byKey.values()].filter(
    (m) => m.diffLine && m.userSelect === "text" && m.element?.kind === "text" && pred(m),
  );
}

function highlightHits(
  sel: NonNullable<ReturnType<typeof extendSelection>>,
  painted: { frame: ReturnType<typeof layout>; buf: ReturnType<typeof createBuffer> },
) {
  const hits: Array<{ col: number; row: number }> = [];
  forEachHighlightCell(
    sel,
    { cells: painted.buf.cells, width: painted.buf.width, height: painted.buf.height },
    painted.frame,
    (col, row) => {
      hits.push({ col, row });
    },
  );
  return hits;
}

function colsOn(
  hits: Array<{ col: number; row: number }>,
  meta: { hitRect: { x: number; y: number; w: number; h: number } },
) {
  return hits
    .filter((c) => c.row === meta.hitRect.y && c.col >= meta.hitRect.x && c.col < meta.hitRect.x + meta.hitRect.w)
    .map((c) => c.col)
    .sort((a, b) => a - b);
}

function gapLit(
  hits: Array<{ col: number; row: number }>,
  left: { hitRect: { x: number; y: number; w: number } },
  right: { hitRect: { x: number } },
) {
  const leftEnd = left.hitRect.x + left.hitRect.w - 1;
  const rightStart = right.hitRect.x;
  return hits.some((h) => h.row === left.hitRect.y && h.col > leftEnd && h.col < rightStart);
}

function cellIn(hits: Array<{ col: number; row: number }>, rect: { x: number; y: number; w: number; h: number }) {
  return hits.some((c) => c.col >= rect.x && c.col < rect.x + rect.w && c.row === rect.y);
}

function collectText(node: LayoutNode, out: string[] = []): string[] {
  if (node.type === "text") out.push(node.content);
  if ("children" in node && Array.isArray(node.children)) {
    for (const c of node.children) collectText(c, out);
  }
  return out;
}

function collectStyles(node: LayoutNode, out: Style[] = []): Style[] {
  if (node.type === "text" && node.style) out.push(node.style);
  if (node.type === "box" && node.style?.background) out.push(node.style.background);
  if ("children" in node && Array.isArray(node.children)) {
    for (const c of node.children) collectStyles(c, out);
  }
  return out;
}

function hasHalves(node: LayoutNode): boolean {
  const json = JSON.stringify(node);
  return json.includes(":L") && json.includes(":R");
}
