/**
 * Story list selection must be visible and scrollable into view.
 * Regression: Wave 5 accent+primary inverted selection; later selected:true;
 * list only painted stories.slice(0, bodyH-3) so j/k past the window looked dead.
 */
import { expect, test } from "vitest";

import { CATALOG, getStory } from "../catalog.js";
import { paintNode } from "../render.js";
import { buildShell, buildSideItems } from "../shell.js";
import type { Story } from "../types.js";

function stories(n: number): Story[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    name: `Story ${String(i).padStart(2, "0")}`,
    category: "widgets",
    description: "synthetic catalog row",
    build: () => ({ type: "text" as const, content: "demo", key: "d" }),
  }));
}

function paintSynthetic(selected: number, rows = 24, cols = 80) {
  return paintNode(
    buildShell({
      cols,
      rows,
      filter: "",
      selected,
      focus: "list",
      tick: 0,
      sample: 0,
      stories: stories(40),
    }),
    cols,
    rows,
    { depth: "truecolor" },
  );
}

function paintList(selected: number, rows = 24, cols = 80) {
  const buf = paintSynthetic(selected, rows, cols);
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    let line = "";
    for (let x = 0; x < Math.min(40, cols); x++) {
      const c = buf.cells[y * cols + x];
      line += c?.ch ?? " ";
    }
    lines.push(line.replace(/\s+$/u, ""));
  }
  return lines;
}

function rowWith(needle: string, selected: number, rows = 24, cols = 80) {
  const buf = paintSynthetic(selected, rows, cols);
  for (let y = 0; y < rows; y++) {
    let line = "";
    let sum = 0;
    let n = 0;
    let selectedCells = 0;
    for (let x = 0; x < cols; x++) {
      const c = buf.cells[y * cols + x];
      line += c?.ch ?? " ";
      const rgb = c?.style?.fgRgb as { r: number; g: number; b: number } | undefined;
      if (rgb && typeof rgb.r === "number") {
        sum += 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
        n++;
      }
      if (c?.style?.selected) selectedCells++;
    }
    if (line.includes(needle)) {
      return { line, avgLum: n ? sum / n : -1, selectedCells };
    }
  }
  return null;
}

function bufferLines(cols: number, rows: number, tree: ReturnType<typeof buildShell>): string[] {
  const buf = paintNode(tree, cols, rows, { depth: "truecolor" });
  const lines: string[] = [];
  for (let y = 0; y < rows; y++) {
    let row = "";
    for (let x = 0; x < cols; x++) row += buf.cells[y * cols + x]!.ch;
    lines.push(row);
  }
  return lines;
}

function paintCatalogShell(cols: number, rows: number, selected: number) {
  return bufferLines(
    cols,
    rows,
    buildShell({
      cols,
      rows,
      filter: "",
      selected,
      focus: "list",
      tick: 0,
      sample: 0,
      stories: CATALOG,
    }),
  );
}

function paintDemoStory(cols: number, rows: number, storyId: string) {
  const story = getStory(storyId);
  expect(story).toBeDefined();
  return bufferLines(
    cols,
    rows,
    buildShell({
      cols,
      rows,
      filter: "",
      selected: 0,
      focus: "demo",
      tick: 0,
      sample: 0,
      stories: [story!],
    }),
  ).join("\n");
}

test("shell chrome: selection, chapters, filter, demo path, strike budget", () => {
  const selected = rowWith("Story 00", 0);
  const neighbor = rowWith("Story 01", 0);
  expect(selected).not.toBeNull();
  expect(neighbor).not.toBeNull();
  expect({
    selectedLum: selected!.avgLum,
    neighborLum: neighbor!.avgLum,
    selectedCells: selected!.selectedCells,
    neighborCells: neighbor!.selectedCells,
    marker: /›/.test(selected!.line),
  }).toMatchObject({
    neighborCells: 0,
    marker: true,
  });
  expect(selected!.avgLum).toBeGreaterThan(0);
  expect(neighbor!.avgLum).toBeGreaterThan(0);
  // Selected must read brighter (or carry selected cells); never darker.
  expect(selected!.avgLum).toBeGreaterThanOrEqual(neighbor!.avgLum);
  expect(selected!.selectedCells).toBeGreaterThan(0);

  // bodyH ≈ 22, list window ≈ 19 — selected=30 must appear after scroll window.
  const scrolled = paintList(30).join("\n");
  expect({
    selectedName: scrolled.includes("Story 30"),
    marker: /›Story 30/.test(scrolled),
    earlyVisible: scrolled.includes("Story 00"),
  }).toEqual({
    selectedName: true,
    marker: true,
    earlyVisible: false,
  });

  expect(
    buildSideItems(CATALOG)
      .filter((i) => i.kind === "chapter")
      .map((i) => i.chapter),
  ).toEqual(["theme", "layout", "widgets", "expand", "buffer", "fx"]);

  const lines = paintCatalogShell(100, 28, 0);
  const joined = lines.join("\n");
  const sideW = Math.min(30, Math.max(18, Math.floor(100 * 0.32)));
  const themeExact = lines.filter((l) => l.slice(1, sideW - 1).trim() === "theme");
  expect({
    breadcrumb: joined.includes("theme · layout · widgets"),
    slashFilter: /│\/\s+/.test(joined),
    themeHeaders: themeExact.length,
    demoPath: lines.filter((l) => l.includes("region · theme-region-dim")).length,
    restated: lines.some((l) => l.includes("theme / region")),
  }).toEqual({
    breadcrumb: false,
    slashFilter: true,
    themeHeaders: 1,
    demoPath: 1,
    restated: false,
  });

  // quote/table flow margin adds one mid-block row vs the old 16-row budget
  const tight = paintDemoStory(70, 17, "md-blockquote-strike");
  expect({
    quoted: tight.includes("second line still quoted"),
    table: /keep\s+remove\s+keep/.test(tight),
  }).toEqual({ quoted: true, table: true });
});
