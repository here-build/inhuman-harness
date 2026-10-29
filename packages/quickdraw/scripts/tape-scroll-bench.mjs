/**
 * Headless split-stage bench: transcript scroll cost.
 * Run from packages/quickdraw: node scripts/tape-scroll-bench.mjs
 *
 * The stamps below are written at WIDTH (96). Layout measures the tape at
 * tapeInnerWidth(COLS), which is 98 here, so those stamps miss. For
 * stamp-correct large-session numbers, run scripts/ui-large-bench.mjs.
 */
import { createBuffer, emitAnsiDetailed } from "../dist/buffer/index.js";
import { layout, measureNode, paintFrame, paintTheme } from "../dist/layout/index.js";
import { assemblePaintFrame } from "../dist/runtime/paint_source.js";
import { Speech, expandWidgetPriors, transcriptColumn } from "../dist/widgets/index.js";

const COLS = 100;
const ROWS = 40;
const WIDTH = 96;
const LOOPS = 12;
const WARM = 2;

const PARA = [
  "The layout engine walks every tape child on scroll.",
  "Wrap happens in measure, then again in place, even for clipped rows.",
  "A `measured` stamp is written at prepare and currently ignored.",
  "",
  "```ts",
  "function layout(root, viewport) {",
  "  return place(root, viewport);",
  "}",
  "```",
  "",
  "Sealed speech should be a retained unit, not a fresh wrap.",
].join("\n");

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function time(fn, loops = LOOPS, warm = WARM) {
  for (let i = 0; i < warm; i++) fn();
  const samples = [];
  for (let i = 0; i < loops; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return { p50: median(samples), max: Math.max(...samples), samples };
}

function unit(i, width = WIDTH) {
  const voice = i % 5 === 0 ? "user" : "assistant";
  const text =
    voice === "user"
      ? `prompt ${i}: implement the tape cache and say why wrap is twice`
      : `## reply ${i}\n\n${PARA}\n\nMore lines for wrap: ${"word ".repeat(40)}`;
  return Speech({ text, voice, atMs: 1_700_000_000_000 + i * 1000 }, { key: `u${i}`, width });
}

function tapeBox(n) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push({
      band: i % 5 === 0 ? "input" : "work",
      slot: i % 5 === 0 ? undefined : "speech",
      key: `u${i}`,
      node: unit(i),
    });
  }
  return transcriptColumn(parts, WIDTH);
}

function productRoot(n, scroll) {
  return assemblePaintFrame({
    tape: tapeBox(n),
    composer: {
      type: "box",
      key: "composer:frame",
      style: { height: 3, width: WIDTH },
      children: [{ type: "text", content: "> draft", key: "draft" }],
    },
    cols: COLS,
    rows: ROWS,
    scroll,
    atBottom: false,
  });
}

function flattenRoot(n, scroll) {
  const children = [];
  for (let i = 0; i < n; i++) children.push(unit(i));
  return assemblePaintFrame({
    tape: { type: "box", key: "transcript:body", children },
    composer: {
      type: "box",
      key: "composer:frame",
      style: { height: 3, width: WIDTH },
      children: [{ type: "text", content: "> draft", key: "draft" }],
    },
    cols: COLS,
    rows: ROWS,
    scroll,
    atBottom: false,
  });
}

function flattenViewportRoot(n, scroll) {
  const children = [];
  for (let i = 0; i < n; i++) children.push(unit(i));
  return {
    type: "box",
    key: "frame",
    style: { width: COLS, height: ROWS },
    children: [
      {
        type: "viewport",
        id: "transcript",
        key: "transcript:viewport",
        overflowY: "scroll",
        overflowAnchor: "none",
        scroll,
        children,
      },
    ],
  };
}

function stampMeasured(node) {
  if (node.measured) return node;
  const next = { ...node };
  if (Array.isArray(node.children)) {
    next.children = node.children.map(stampMeasured);
  }
  next.measured = { ...measureNode(next, WIDTH, Number.POSITIVE_INFINITY), atW: WIDTH };
  next.paintReady = true;
  return next;
}

function stage(label, build, n, scroll) {
  const raw = build(n, scroll);
  const expanded = expandWidgetPriors(raw, { width: WIDTH });
  const stamped = stampMeasured(expanded);
  const theme = paintTheme();
  let frame;
  const layoutMs = time(() => {
    frame = layout(expanded, { w: COLS, h: ROWS });
  });
  const layoutStampedMs = time(() => {
    frame = layout(stamped, { w: COLS, h: ROWS });
  });
  const buf = createBuffer(COLS, ROWS);
  const paintMs = time(() => {
    paintFrame(frame, buf, theme, { nowMs: 0 });
  });
  let prev = null;
  const emitMs = time(() => {
    const next = createBuffer(COLS, ROWS);
    paintFrame(frame, next, theme, { nowMs: 0 });
    emitAnsiDetailed(prev, next);
    prev = next;
  });
  const firstEmit = (() => {
    const next = createBuffer(COLS, ROWS);
    paintFrame(frame, next, theme, { nowMs: 0 });
    const t0 = performance.now();
    const out = emitAnsiDetailed(null, next);
    return { ms: performance.now() - t0, bytes: out.bytes, dirtyRows: out.dirtyRows };
  })();
  const scrollFrame = layout(expandWidgetPriors(build(n, scroll + 8), { width: WIDTH }), {
    w: COLS,
    h: ROWS,
  });
  const scrollPaint = createBuffer(COLS, ROWS);
  paintFrame(scrollFrame, scrollPaint, theme, { nowMs: 0 });
  const basePaint = createBuffer(COLS, ROWS);
  paintFrame(frame, basePaint, theme, { nowMs: 0 });
  const scrollEmit = emitAnsiDetailed(basePaint, scrollPaint);

  return {
    label,
    n,
    ops: frame.paintOrder.length,
    hits: frame.hitList.length,
    liveHz: frame.liveDemand?.maxHz ?? 0,
    layoutP50: layoutMs.p50,
    layoutMax: layoutMs.max,
    layoutStampedP50: layoutStampedMs.p50,
    paintP50: paintMs.p50,
    emitWarmP50: emitMs.p50,
    firstEmit: firstEmit.ms,
    firstBytes: firstEmit.bytes,
    scrollDirty: scrollEmit.dirtyRows,
    scrollBytes: scrollEmit.bytes,
  };
}

function fmt(row) {
  return [
    row.label.padEnd(18),
    String(row.n).padStart(4),
    row.layoutP50.toFixed(2).padStart(8),
    row.layoutStampedP50.toFixed(2).padStart(10),
    row.paintP50.toFixed(2).padStart(8),
    row.emitWarmP50.toFixed(2).padStart(8),
    String(row.ops).padStart(6),
    String(row.scrollDirty).padStart(6),
  ].join(" ");
}

const sizes = [20, 50, 100, 200, 400];
const shapes = [
  ["product-1child", productRoot],
  ["flat-in-box", flattenRoot],
  ["vp-children", flattenViewportRoot],
];

console.log(["shape".padEnd(18), "   n", "layout", "lay+stamp", "   paint", "emitWarm", "   ops", "dirtyΔ"].join(" "));

for (const n of sizes) {
  for (const [label, build] of shapes) {
    const row = stage(label, build, n, 12);
    console.log(fmt(row));
  }
  console.log("");
}

function countNodes(node, acc = { n: 0, text: 0, md: 0, chars: 0 }) {
  acc.n += 1;
  if (node.type === "text") {
    acc.text += 1;
    acc.chars += node.content?.length ?? 0;
  }
  if (node.type === "markdown") acc.md += 1;
  if (Array.isArray(node.children)) for (const c of node.children) countNodes(c, acc);
  return acc;
}

function heavyTape(n, linesPer) {
  const blob = Array.from({ length: linesPer }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
  const children = [];
  for (let i = 0; i < n; i++) {
    children.push({
      type: "indication",
      key: `h${i}`,
      gutter: { kind: "top", glyph: "$" },
      children: [
        {
          type: "text",
          key: `h${i}:t`,
          content: blob,
          whiteSpace: "pre-wrap",
        },
      ],
    });
  }
  return assemblePaintFrame({
    tape: { type: "box", key: "transcript:body", children },
    composer: {
      type: "box",
      key: "composer:frame",
      style: { height: 3, width: WIDTH },
      children: [{ type: "text", content: "> draft", key: "draft" }],
    },
    cols: COLS,
    rows: ROWS,
    scroll: 40,
    atBottom: false,
  });
}

{
  const n = 200;
  const raw = productRoot(n, 12);
  const expanded = expandWidgetPriors(raw, { width: WIDTH });
  const nodes = countNodes(expanded);
  const expandMs = time(() => expandWidgetPriors(productRoot(n, 12), { width: WIDTH }), 8, 1);
  let measured;
  const measureMs = time(
    () => {
      measured = measureNode(expanded, WIDTH, 10_000);
    },
    8,
    1,
  );
  console.log("\nattribution n=200 product markdown-speech:");
  console.log(`  expandWidgetPriors  p50=${expandMs.p50.toFixed(2)}ms`);
  console.log(`  measureNode(root)   p50=${measureMs.p50.toFixed(2)}ms  h=${measured.h}`);
  console.log(`  tree nodes=${nodes.n} text=${nodes.text} md=${nodes.md} chars=${nodes.chars}`);
  const frame = layout(expanded, { w: COLS, h: ROWS });
  console.log(`  paintOrder=${frame.paintOrder.length} hits=${frame.hitList.length}`);
  console.log(`  viewport maxScroll=${frame.byKey.get("transcript:viewport")?.element?.maxScroll}`);
}

function tokenTape(files, lines, runs) {
  const children = [];
  for (let f = 0; f < files; f++) {
    const rows = [];
    for (let y = 0; y < lines; y++) {
      const segs = [];
      for (let r = 0; r < runs; r++) {
        segs.push({
          type: "text",
          key: `f${f}:${y}:${r}`,
          content: r === 0 ? "const" : ` tok${r}`,
          whiteSpace: "nowrap",
          style: { role: "code" },
        });
      }
      rows.push({
        type: "flex",
        key: `f${f}:${y}`,
        style: { direction: "row" },
        children: segs,
      });
    }
    children.push({
      type: "box",
      key: `f${f}`,
      children: rows,
    });
  }
  return assemblePaintFrame({
    tape: { type: "box", key: "transcript:body", children },
    composer: {
      type: "box",
      key: "composer:frame",
      style: { height: 3, width: WIDTH },
      children: [{ type: "text", content: "> draft", key: "draft" }],
    },
    cols: COLS,
    rows: ROWS,
    scroll: 80,
    atBottom: false,
  });
}

console.log("\nhighlighted-code shaped trees (flex row per line, N token runs):");
for (const [files, lines, runs] of [
  [5, 80, 8],
  [20, 80, 8],
  [10, 200, 8],
  [40, 100, 8],
]) {
  const raw = tokenTape(files, lines, runs);
  const nodes = countNodes(raw);
  const row = stage(`tok ${files}x${lines}x${runs}`, () => raw, files, 80);
  console.log(
    `${String(files).padStart(3)} files × ${String(lines).padStart(3)} lines × ${runs} runs  nodes=${String(nodes.n).padStart(6)}  layout=${row.layoutP50.toFixed(2)}ms  paint=${row.paintP50.toFixed(2)}ms  ops=${row.ops}`,
  );
}

console.log("\nheavy pre-wrap (shell-like) product-shaped tape:");
for (const [n, lines] of [
  [20, 80],
  [50, 80],
  [20, 400],
  [5, 2000],
]) {
  const row = stage(`prewrap ${n}x${lines}`, () => heavyTape(n, lines), n, 40);
  console.log(
    `${String(n).padStart(3)} units × ${String(lines).padStart(4)} lines  layout=${row.layoutP50.toFixed(2)}ms  paint=${row.paintP50.toFixed(2)}ms  ops=${row.ops}`,
  );
}
