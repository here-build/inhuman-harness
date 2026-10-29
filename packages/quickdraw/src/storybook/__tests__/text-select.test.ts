/**
 * Text drag-select in the interactive storybook.
 *
 * createTtySession enables SGR mouse, which kills native terminal select.
 * The host recolors only cells under a selectable hit meta — so the demo
 * stage must be userSelect:text (harness content-site law). Without that,
 * recolor hits 0 and clears the gesture every present.
 *
 * Catalog rows stay userSelect:none + intent:activate — clickable, not
 * stream-selected when multi-row geometry runs full-width across the shell.
 */
import { expect, test } from "vitest";

import { clear, createBuffer } from "../../buffer/index.js";
import { createSelectionHost, emptyEcho, renderFrame } from "../../index.js";
import { attuneTheme, elementAt, paintFrame } from "../../layout/index.js";
import { buildShell } from "../shell.js";
import type { Story } from "../types.js";

const DEMO_TEXT = "hello selectable world";

function manyStories(n: number): Story[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    name: i === 0 ? "Select me" : `Story ${String(i).padStart(2, "0")}`,
    category: "widgets",
    description: "synthetic selectable demo",
    build: () =>
      ({
        type: "box" as const,
        key: "demo-wrap",
        style: { width: 40, height: 6 },
        children: [
          {
            type: "text" as const,
            key: "demo-body",
            content: DEMO_TEXT,
            whiteSpace: "nowrap" as const,
          },
          {
            type: "text" as const,
            key: "demo-line2",
            content: "second line of demo body",
            whiteSpace: "nowrap" as const,
          },
          {
            type: "text" as const,
            key: "demo-line3",
            content: "third line for multi-row drag",
            whiteSpace: "nowrap" as const,
          },
        ],
      }) as const,
  }));
}

function shellWithDemo(storyCount = 1) {
  const stories = manyStories(storyCount);
  const tree = buildShell({
    cols: 80,
    rows: 24,
    filter: "",
    selected: 0,
    focus: "demo",
    tick: 0,
    sample: 0,
    stories,
  });
  const { paint } = attuneTheme({ depth: "truecolor" });
  const { frame, buffer } = renderFrame({
    snapshot: { tree: { root: tree, boxes: {} }, getBox: () => undefined },
    geometry: { cols: 80, rows: 24 },
    state: { nowMs: 0, echo: emptyEcho(), theme: paint },
  });
  if (frame === null) throw new Error("shell frame");
  return { frame, buf: buffer, stories };
}

function findText(buf: ReturnType<typeof createBuffer>, needle: string): { col: number; row: number } | null {
  const w = buf.width;
  const h = buf.height;
  for (let row = 0; row < h; row++) {
    let line = "";
    for (let col = 0; col < w; col++) {
      line += buf.cells[row * w + col]?.ch ?? " ";
    }
    const idx = line.indexOf(needle);
    if (idx !== -1) return { col: idx, row };
  }
  return null;
}

function selectedCells(buf: ReturnType<typeof createBuffer>): Set<string> {
  const out = new Set<string>();
  for (let row = 0; row < 24; row++) {
    for (let col = 0; col < 80; col++) {
      if (buf.cells[row * 80 + col]?.style?.selected) out.add(`${col},${row}`);
    }
  }
  return out;
}

test("demo-stage text select: chrome, click, drag copy, clear, no catalog recolor", () => {
  const { frame, buf } = shellWithDemo(12);
  const hitPos = findText(buf, "Story 01");
  expect(hitPos).not.toBeNull();
  expect({
    demo: frame.byKey.get("demo-stage")?.userSelect,
    side: frame.byKey.get("side")?.userSelect,
    row: {
      userSelect: frame.byKey.get("s-s1")?.userSelect,
      intent: frame.byKey.get("s-s1")?.intent,
    },
    hit: elementAt(frame, hitPos!.col, hitPos!.row)?.key,
  }).toEqual({
    demo: "text",
    side: "none",
    row: { userSelect: "none", intent: "activate" },
    hit: expect.stringMatching(/^s-s1/),
  });

  const anchor = findText(buf, "hello");
  expect(anchor).not.toBeNull();
  const host = createSelectionHost();
  host.setViewport(80, 24);
  host.bindPaint(buf, frame);
  host.handle({ kind: "press", col: anchor!.col, row: anchor!.row, tMs: 100 });
  host.handle({
    kind: "drag",
    col: anchor!.col + 4,
    row: anchor!.row,
    tMs: 110,
  });
  const out = host.handle({
    kind: "release",
    col: anchor!.col + 4,
    row: anchor!.row,
    tMs: 120,
  });
  const painted = createBuffer(80, 24);
  clear(painted);
  paintFrame(frame, painted, attuneTheme({ depth: "truecolor" }).paint);
  host.bindPaint(painted, frame);
  const ground = attuneTheme({ depth: "truecolor" }).theme.ground;
  expect({
    selection: out.selection !== null,
    copyReady: out.copyReady,
    recolor: host.recolor(painted, frame, ground),
    selected: painted.cells.filter((c) => c?.style?.selected).length,
    osc: host.copyOscIfReady(out).startsWith("\x1b]52;"),
  }).toMatchObject({
    selection: true,
    copyReady: true,
    recolor: true,
    osc: true,
  });
  expect(painted.cells.filter((c) => c?.style?.selected).length).toBeGreaterThan(0);

  // Story switch / filter / sample change contentIdentity → cadence clears.
  host.clear();
  const cleared = createBuffer(80, 24);
  clear(cleared);
  paintFrame(frame, cleared, attuneTheme({ depth: "truecolor" }).paint);
  host.bindPaint(cleared, frame);
  expect({
    selection: host.selection(),
    recolor: host.recolor(cleared, frame, ground),
  }).toEqual({ selection: null, recolor: false });

  const start = findText(buf, "hello");
  const end = findText(buf, "third line");
  expect(start).not.toBeNull();
  expect(end).not.toBeNull();
  // Multi-row stream → middle rows run full-width geometry; sidebar must
  // stay chrome (userSelect none) so list names never light up.
  expect(end!.row).toBeGreaterThan(start!.row);
  host.handle({ kind: "press", col: start!.col, row: start!.row, tMs: 100 });
  host.handle({ kind: "drag", col: end!.col + 5, row: end!.row, tMs: 110 });
  host.handle({ kind: "release", col: end!.col + 5, row: end!.row, tMs: 120 });

  const multi = createBuffer(80, 24);
  clear(multi);
  paintFrame(frame, multi, attuneTheme({ depth: "truecolor" }).paint);
  const before = selectedCells(multi);
  host.bindPaint(multi, frame);
  expect(host.recolor(multi, frame, ground)).toBe(true);

  const r = frame.byKey.get("demo-stage")!.hitRect;
  let added = 0;
  let addedOutsideStage = 0;
  for (let row = 0; row < 24; row++) {
    for (let col = 0; col < 80; col++) {
      if (!multi.cells[row * 80 + col]?.style?.selected) continue;
      if (before.has(`${col},${row}`)) continue;
      added++;
      const inStage = col >= r.x && col < r.x + r.w && row >= r.y && row < r.y + r.h;
      if (!inStage) addedOutsideStage++;
    }
  }
  expect({ added: added > 0, addedOutsideStage }).toEqual({
    added: true,
    addedOutsideStage: 0,
  });
});
