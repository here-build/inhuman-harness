/**
 * JS side of packages/quickdraw/rust/text-hot. Same fixtures.
 *   node scripts/text-hot-bench.mjs
 */
import { wrapText } from "../dist/layout/text.js";
import { displayWidth } from "../dist/measure/index.js";
import { tapeInnerWidth } from "../dist/runtime/paint_source.js";
import { expandWidgetPriors, Speech, transcriptColumn } from "../dist/widgets/index.js";

const WIDTH = 98;
const TAPE_W = tapeInnerWidth(100);

function shellBlob() {
  return Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(70)}`).join("\n");
}

function wideBlob() {
  const line = "测量宽度😀⏎ and a CJK run 宽".repeat(40);
  return Array.from({ length: 200 }, () => line).join("\n");
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function time(label, fn) {
  const samples = [];
  let value = "";
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    value = fn();
    samples.push(performance.now() - t0);
  }
  const steady = median(samples.slice(1));
  console.log(
    `${label.padEnd(28)} first ${samples[0].toFixed(2).padStart(7)}ms  steady ${steady.toFixed(2).padStart(7)}ms  ${value}`,
  );
}

const PARA = [
  "The layout engine walks every tape child on scroll.",
  "",
  "```ts",
  "function layout(root, viewport) {",
  "  return place(root, viewport);",
  "}",
  "```",
  "",
  "Sealed speech should be a retained unit, not a fresh wrap.",
].join("\n");

function speechTape(n) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const text = `## reply ${i}\n\n${PARA}\n\nMore lines for wrap: ${"word ".repeat(40)}`;
    parts.push({
      band: "work",
      slot: "speech",
      key: `u${i}`,
      node: Speech({ text, voice: "assistant", atMs: 1 }, { key: `u${i}`, width: TAPE_W }),
    });
  }
  return transcriptColumn(parts, TAPE_W);
}

const shell = shellBlob();
const wide = wideBlob();

console.log(`js text-hot  width ${WIDTH}`);
time("shell width", () => {
  let cols = 0;
  for (const line of shell.split("\n")) cols += displayWidth(line);
  return `cols ${cols}`;
});
time("shell wrap", () => {
  const lines = wrapText(shell, { width: WIDTH, whiteSpace: "pre-wrap" });
  return `lines ${lines.length}`;
});
time("wide width", () => {
  let cols = 0;
  for (const line of wide.split("\n")) cols += displayWidth(line);
  return `cols ${cols}`;
});
time("wide wrap", () => {
  const lines = wrapText(wide, { width: WIDTH, whiteSpace: "pre-wrap" });
  return `lines ${lines.length}`;
});
time("expand speech ×200", () => {
  expandWidgetPriors(speechTape(200), { width: TAPE_W });
  return "nodes 200";
});
time("expand speech ×800", () => {
  expandWidgetPriors(speechTape(800), { width: TAPE_W });
  return "nodes 800";
});
