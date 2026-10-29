import { expect, test } from "vitest";

import { FgP } from "../../lexicon/index.js";
import {
  distributeExact,
  flexMainSizes,
  layout,
  measureGridDims,
  measureNode,
  resolveColumnTracks,
  resolveFlexItem,
  tracksExtent,
  type LayoutNode,
  type Length,
} from "../index.js";

test("flex distribution is exact, finite, and honors sugar", () => {
  const sumFailures: string[] = [];
  for (let n = 1; n <= 12; n++) {
    for (let total = 0; total <= 100; total += 7) {
      const weights = Array.from({ length: n }, (_, i) => (i * 3 + total) % 21);
      const parts = distributeExact(weights, total);
      const sum = parts.reduce((a, b) => a + b, 0);
      const expectSum = weights.every((w) => w === 0) ? 0 : total;
      const finiteNonNeg = parts.every((p) => Number.isFinite(p) && p >= 0 && Number.isInteger(p));
      if (sum !== expectSum || !finiteNonNeg || parts.length !== n) {
        sumFailures.push(`n=${n} total=${total} weights=${weights.join(",")} parts=${parts.join(",")}`);
      }
    }
  }

  const mixed = distributeExact([1, Number.NaN, 1], 100);
  const h1 = {
    nanWeightsFinite: distributeExact([Number.NaN, 1, 1], 100).every(Number.isFinite),
    infWeightsFinite: distributeExact([Infinity, 1, 1], 100).every(Number.isFinite),
    nanTotalFinite: distributeExact([1, 1, 1], Number.NaN).every(Number.isFinite),
    infTotalFinite: distributeExact([1, 1, 1], Infinity).every(Number.isFinite),
    singleNan: distributeExact([Number.NaN], 100),
    mixed,
  };

  const sugar = resolveFlexItem({ flex: 1 }, 50);
  const minOverride = resolveFlexItem({ flex: 1, minMain: 10 }, 50);
  const split = flexMainSizes([resolveFlexItem({ flex: 1 }, 0), resolveFlexItem({ flex: 1 }, 0)], 10, 0);

  const sizeFailures: string[] = [];
  for (const n of [1, 2, 3, 6]) {
    for (const base of [0, 10, 40]) {
      for (const min of [0, 8, 20]) {
        for (const max of [5, 40, 80]) {
          for (const grow of [0, 1, 5]) {
            for (const shrink of [0, 3]) {
              const lo = Math.min(min, base, max);
              const hi = Math.max(min, base, max);
              const items = Array.from({ length: n }, () => ({
                base: Math.max(lo, Math.min(hi, base)),
                min: lo,
                max: hi,
                grow,
                shrink,
              }));
              for (const containerMain of [0, 15, 120]) {
                for (const gap of [0, 2, 4]) {
                  const sizes = flexMainSizes(items, containerMain, gap);
                  const gaps = gap * Math.max(0, n - 1);
                  const total = sizes.reduce((a, b) => a + b, 0) + gaps;
                  const minTotal = items.reduce((a, it) => a + it.min, 0) + gaps;
                  const overflowOk = total <= Math.max(containerMain, minTotal);
                  const floorsOk = sizes.every((s, i) => s >= items[i]!.min);
                  const finiteOk = sizes.every((s) => Number.isFinite(s) && s >= 0);
                  if (sizes.length !== n || !overflowOk || !floorsOk || !finiteOk) {
                    sizeFailures.push(`n=${n} container=${containerMain} gap=${gap} sizes=${sizes.join(",")}`);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  expect({ sumFailures, sizeFailures }).toEqual({
    sumFailures: [],
    sizeFailures: [],
  });
  expect(h1).toEqual({
    nanWeightsFinite: true,
    infWeightsFinite: true,
    nanTotalFinite: true,
    infTotalFinite: true,
    singleNan: [0],
    mixed: [50, 0, 50],
  });
  expect({ sugar, minOverride, split }).toMatchObject({
    sugar: { min: 0, base: 0, grow: 1 },
    minOverride: { min: 10 },
    split: [5, 5],
  });
});

test("grid tracks stay finite and default lines are role chrome", () => {
  const auto = resolveColumnTracks(["auto", "auto", "auto"], [7, 6, 4], 40, 1);
  const fr = resolveColumnTracks(["auto", { fr: 1 }], [5, 3], 20, 1);
  const overflow = resolveColumnTracks(["auto", "auto"], [20, 20], 10, 1);

  const empty: LayoutNode = {
    type: "grid",
    key: "empty-cols",
    style: { columns: [], lines: "none" },
    children: [{ type: "text", content: "x", whiteSpace: "nowrap" }],
  };
  const emptyMeasure = measureNode(empty, 20, 10);
  const emptyFrame = layout(empty, { w: 20, h: 10 });
  const emptyTexts = emptyFrame.paintOrder.flatMap((p) => p.paint.filter((op) => op.kind === "text"));

  const table: LayoutNode = {
    type: "grid",
    key: "t",
    style: {
      columns: ["auto", "auto", "auto"],
      lines: "inner",
      lineStyle: { dim: true, fg: 240 },
      cellPad: { x: 1 },
      columnGap: 1,
      rowGap: 1,
    },
    children: [
      { type: "text", content: "check", style: { bold: true }, whiteSpace: "nowrap" },
      { type: "text", content: "status", style: { bold: true }, whiteSpace: "nowrap" },
      { type: "text", content: "ms", style: { bold: true }, whiteSpace: "nowrap" },
      { type: "text", content: "compile", whiteSpace: "nowrap" },
      { type: "text", content: "ok", whiteSpace: "nowrap" },
      { type: "text", content: "812", whiteSpace: "nowrap" },
      { type: "text", content: "test", whiteSpace: "nowrap" },
      { type: "text", content: "ok", whiteSpace: "nowrap" },
      { type: "text", content: "4021", whiteSpace: "nowrap" },
    ],
  };

  const noLineStyle: LayoutNode = {
    type: "grid",
    style: {
      columns: ["auto", "auto"],
      lines: "inner",
      columnGap: 1,
      rowGap: 1,
      cellPad: 0,
    },
    children: [
      { type: "text", content: "a", whiteSpace: "nowrap" },
      { type: "text", content: "b", whiteSpace: "nowrap" },
      { type: "text", content: "c", whiteSpace: "nowrap" },
      { type: "text", content: "d", whiteSpace: "nowrap" },
    ],
  };
  const lineOps = layout(noLineStyle, { w: 20, h: 5 })
    .paintOrder.filter((p) => p.key?.endsWith(":lines") === true)
    .flatMap((p) => p.paint);
  const lineStyles = lineOps.map((op) => ({
    role: op.kind === "raw" ? undefined : op.style.role,
    prominence: op.kind === "raw" ? undefined : op.style.prominence,
    fg: op.kind === "raw" ? undefined : op.style.fg,
    dim: op.kind === "raw" ? undefined : op.style.dim,
  }));

  const frFailures: string[] = [];
  for (let n = 1; n <= 6; n++) {
    for (const frW of [0, 1, 2, 5]) {
      for (const containerW of [0, 1, 8, 19, 40, 80]) {
        for (const gap of [0, 1, 3, 4]) {
          const tracks = Array.from({ length: n }, () => ({ fr: frW }));
          const widths = resolveColumnTracks(
            tracks,
            Array.from({ length: n }, () => 0),
            containerW,
            gap,
          );
          const extent = tracksExtent(widths, gap);
          const irreducibleGap = gap * Math.max(0, n - 1);
          const finite = widths.every((w) => Number.isFinite(w) && w >= 0);
          if (widths.length !== n || !finite || extent > Math.max(containerW, irreducibleGap)) {
            frFailures.push(`n=${n} fr=${frW} w=${containerW} gap=${gap} widths=${widths.join(",")}`);
          }
        }
      }
    }
  }

  const kinds: Length[] = [
    "auto",
    0,
    12,
    30,
    { fr: 0 },
    { fr: 1 },
    { fr: 5 },
    { pct: 0 },
    { pct: 50 },
    { pct: 100 },
    { ch: 0 },
    { ch: 8 },
    { ch: 20 },
  ];
  const mixedFailures: string[] = [];
  for (let n = 1; n <= 6; n++) {
    for (const kind of kinds) {
      const tracks = Array.from({ length: n }, () => kind);
      for (const min of [0, 3, 25]) {
        for (const containerW of [0, 10, 80]) {
          for (const gap of [0, 1, 4]) {
            const widths = resolveColumnTracks(
              tracks,
              Array.from({ length: n }, () => min),
              containerW,
              gap,
            );
            if (!widths.every((w) => Number.isFinite(w) && w >= 0)) {
              mixedFailures.push(`n=${n} kind=${JSON.stringify(kind)} min=${min} w=${containerW} gap=${gap}`);
            }
          }
        }
      }
    }
  }
  const mixedRow = resolveColumnTracks(["auto", { fr: 1 }, 10, { pct: 20 }, { ch: 4 }], [5, 0, 3, 2, 1], 40, 1);

  expect({
    auto,
    autoExtent: tracksExtent(auto, 1),
    fr,
    overflowFits: tracksExtent(overflow, 1) <= 10 && overflow[0]! + overflow[1]! + 1 <= 10,
  }).toEqual({
    auto: [7, 6, 4],
    autoExtent: 19,
    fr: [5, 14],
    overflowFits: true,
  });
  expect({
    emptyMeasure: {
      finite: Number.isFinite(emptyMeasure.w) && Number.isFinite(emptyMeasure.h),
      positive: emptyMeasure.w > 0 && emptyMeasure.h > 0,
    },
    emptyTexts: emptyTexts.length > 0,
    emptyGeometry: emptyTexts.every(
      (op) =>
        Number.isFinite(op.rect.x) &&
        Number.isFinite(op.rect.y) &&
        Number.isFinite(op.rect.w) &&
        Number.isFinite(op.rect.h),
    ),
    table: measureNode(table, 80, 40),
  }).toEqual({
    emptyMeasure: { finite: true, positive: true },
    emptyTexts: true,
    emptyGeometry: true,
    table: { w: 25, h: 5 },
  });
  expect({
    hasLines: Math.min(lineOps.length, 1),
    sample: lineStyles[0] ?? null,
    allRoleBorder: lineStyles.every(
      (s) => s.role === "border" && s.prominence === FgP.ghost && s.fg === undefined && s.dim === undefined,
    ),
  }).toEqual({
    hasLines: 1,
    sample: {
      role: "border",
      prominence: FgP.ghost,
      fg: undefined,
      dim: undefined,
    },
    allRoleBorder: true,
  });
  expect({
    frFailures,
    mixedFailures,
    mixedRowFinite: mixedRow.every((w) => Number.isFinite(w) && w >= 0),
  }).toEqual({
    frFailures: [],
    mixedFailures: [],
    mixedRowFinite: true,
  });
});

test("auto columns squeeze wrap slack instead of crushing the longest track", () => {
  const auto3: Length[] = ["auto", "auto", "auto"];
  const fits = resolveColumnTracks(auto3, [7, 6, 4], 40, 1, [3, 3, 3]);
  const squeezed = resolveColumnTracks(auto3, [24, 34, 50], 80, 1, [8, 8, 8]);
  const equalOverflow = resolveColumnTracks(["auto", "auto"], [20, 20], 10, 1);
  const prose: LayoutNode = {
    type: "grid",
    style: {
      columns: auto3,
      lines: "inner",
      cellPad: { x: 1 },
      columnGap: 1,
    },
    children: [
      { type: "text", content: "Pi", whiteSpace: "pre-wrap" },
      { type: "text", content: "short ok", whiteSpace: "pre-wrap" },
      {
        type: "text",
        content: "yes, omit when empty (Grok miss if cached)",
        whiteSpace: "pre-wrap",
      },
    ],
  };
  const dims = measureGridDims(prose, 40);
  const inner = dims.colWidths.map((w) => w - dims.padX * 2);

  expect({
    fits,
    squeezed: {
      extent: tracksExtent(squeezed, 1),
      floors: squeezed.every((w) => w >= 8),
      caps: squeezed.every((w, i) => w <= [24, 34, 50][i]!),
      longestWidest: squeezed[2]! >= squeezed[0]! && squeezed[2]! >= squeezed[1]!,
    },
    equalOverflow: {
      extent: tracksExtent(equalOverflow, 1),
      shared: Math.abs((equalOverflow[0] ?? 0) - (equalOverflow[1] ?? 0)) <= 1,
      noneSpine: (equalOverflow[0] ?? 0) > 1 && (equalOverflow[1] ?? 0) > 1,
    },
    prose: {
      fits: dims.totalW <= 40,
      noneSpine: inner.every((w) => w > 1),
      longStillWidest: inner[2]! >= inner[0]! && inner[2]! >= inner[1]!,
    },
  }).toEqual({
    fits: [7, 6, 4],
    squeezed: {
      extent: 80,
      floors: true,
      caps: true,
      longestWidest: true,
    },
    equalOverflow: {
      extent: 10,
      shared: true,
      noneSpine: true,
    },
    prose: {
      fits: true,
      noneSpine: true,
      longStillWidest: true,
    },
  });
});
