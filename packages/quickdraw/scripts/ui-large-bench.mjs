/**
 * Large-setup present-path bench.
 *
 *   node scripts/ui-large-bench.mjs
 *
 * Reports cold layout (first wrap) and warm layout (same nodes, scroll moved).
 * Speech rows are stamped the way retained widgets stamp them: at
 * `tapeInnerWidth(cols)`, on the speech root only. A stamp at any other
 * width never hits — layout asks for the tape column, not the speech
 * constructor width.
 */
import { createBuffer } from "../dist/buffer/index.js";
import { layout, measureNode, paintFrame, paintTheme } from "../dist/layout/index.js";
import { assemblePaintFrame, tapeInnerWidth } from "../dist/runtime/paint_source.js";
import { Speech, expandWidgetPriors, transcriptColumn } from "../dist/widgets/index.js";

const COLS = 100;
const ROWS = 40;
const TAPE_W = tapeInnerWidth(COLS);

const PARA = [
  "The layout engine walks every tape child on scroll.",
  "Wrap happens in measure, then again in place, even for clipped rows.",
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

function time(fn, loops = 5) {
  const samples = [];
  for (let i = 0; i < loops; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return { first: samples[0], rest: median(samples.slice(1)) };
}

function unit(i) {
  const voice = i % 5 === 0 ? "user" : "assistant";
  const text =
    voice === "user"
      ? `prompt ${i}: keep the tape responsive when the session is long`
      : `## reply ${i}\n\n${PARA}\n\nMore lines for wrap: ${"word ".repeat(40)}`;
  return Speech({ text, voice, atMs: 1_700_000_000_000 + i * 1000 }, { key: `u${i}`, width: TAPE_W });
}

function stampSpeechRoots(node) {
  if (node.key && /:speech(-user)?$/.test(String(node.key))) {
    const measured = measureNode(node, TAPE_W, Number.POSITIVE_INFINITY);
    return { ...node, paintReady: true, measured: { ...measured, atW: TAPE_W } };
  }
  const next = { ...node };
  if (Array.isArray(node.children)) next.children = node.children.map(stampSpeechRoots);
  if (node.summary) next.summary = stampSpeechRoots(node.summary);
  return next;
}

function product(tape, scroll) {
  return assemblePaintFrame({
    tape,
    composer: {
      type: "box",
      key: "composer:frame",
      style: { height: 3, width: TAPE_W },
      children: [{ type: "text", content: "> draft", key: "draft" }],
    },
    cols: COLS,
    rows: ROWS,
    scroll,
    atBottom: false,
  });
}

function speechTape(n) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push({
      band: i % 5 === 0 ? "input" : "work",
      slot: i % 5 === 0 ? undefined : "speech",
      key: `u${i}`,
      node: unit(i),
    });
  }
  return transcriptColumn(parts, TAPE_W);
}

function shellTape(units, lines) {
  const blob = Array.from({ length: lines }, (_, i) => `line ${i} ${"x".repeat(70)}`).join("\n");
  const children = [];
  for (let i = 0; i < units; i++) {
    children.push({
      type: "indication",
      key: `h${i}`,
      gutter: { kind: "top", glyph: "$" },
      children: [{ type: "text", key: `h${i}:t`, content: blob, whiteSpace: "pre-wrap" }],
    });
  }
  return { type: "box", key: "transcript:body", style: { width: TAPE_W }, children };
}

function stampKeys(node, pattern) {
  if (node.key && pattern.test(String(node.key))) {
    const measured = measureNode(node, TAPE_W, Number.POSITIVE_INFINITY);
    return { ...node, paintReady: true, measured: { ...measured, atW: TAPE_W } };
  }
  const next = { ...node };
  if (Array.isArray(node.children)) next.children = node.children.map((child) => stampKeys(child, pattern));
  return next;
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
      rows.push({ type: "flex", key: `f${f}:${y}`, style: { direction: "row" }, children: segs });
    }
    children.push({ type: "box", key: `f${f}`, children: rows });
  }
  return { type: "box", key: "transcript:body", style: { width: TAPE_W }, children };
}

function frameAt(node, scroll) {
  return layout(product(node, scroll), { w: COLS, h: ROWS });
}

function bench(label, node) {
  const cold = time(() => frameAt(node, 40));
  const frame = frameAt(node, 40);
  const theme = paintTheme();
  const paint = time(() => {
    const buf = createBuffer(COLS, ROWS);
    paintFrame(frame, buf, theme, { nowMs: 0 });
  });
  const warm = time(() => frameAt(node, 80));
  console.log(
    `${label.padEnd(32)} first ${cold.first.toFixed(2).padStart(7)}ms  scroll ${warm.first.toFixed(2).padStart(7)}ms  steady ${warm.rest.toFixed(2).padStart(7)}ms  paint ${paint.rest.toFixed(2).padStart(6)}ms  ops ${String(frame.paintOrder.length).padStart(4)}`,
  );
}

function expandedSpeech(n, stamp) {
  const expanded = expandWidgetPriors(speechTape(n), { width: TAPE_W });
  return stamp ? stampSpeechRoots(expanded) : expanded;
}

console.log(`tape ${TAPE_W}×${ROWS} in ${COLS} cols — cold = first layout, warm = scroll on the same nodes\n`);

for (const n of [50, 200, 800]) {
  const t0 = performance.now();
  expandWidgetPriors(speechTape(n), { width: TAPE_W });
  const expandMs = performance.now() - t0;
  bench(`speech ×${n} expanded`, expandedSpeech(n, false));
  bench(`speech ×${n} + root stamp`, expandedSpeech(n, true));
  console.log(`${"expand (not in cold)".padEnd(32)} ${expandMs.toFixed(2)}ms`);
}

console.log("");
bench("shell 1×4000", shellTape(1, 4000));
bench("shell 1×4000 stamped", stampKeys(shellTape(1, 4000), /^h\d+$/));
bench("shell 20×400", shellTape(20, 400));
bench("shell 20×400 stamped", stampKeys(shellTape(20, 400), /^h\d+$/));
bench("tokens 20×80×8", tokenTape(20, 80, 8));
bench("tokens 20×80×8 file stamp", stampKeys(tokenTape(20, 80, 8), /^f\d+$/));
bench("tokens 1×2000×8", tokenTape(1, 2000, 8));
bench("tokens 1×2000×8 file stamp", stampKeys(tokenTape(1, 2000, 8), /^f\d+$/));
