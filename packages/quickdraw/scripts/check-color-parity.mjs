#!/usr/bin/env node
/**
 * Color-parity CI ratchet (color-hygiene plan, post-audit decision 3 / G4).
 *
 * The parity law: every painted color states a role and a prominence; a raw
 * literal outside a named quarantine is a bug by definition. This script
 * mechanizes the scout-catalog greps into a CI gate.
 *
 * Scans `packages/quickdraw` (storybook included) and
 * `packages/harness-tui/src/e2e`
 * (skipping dist/node_modules/*.test.ts)
 * for four literal shapes: `fg: <number>`, `bg: <number>`, `#<hex>`,
 * `dim: true`.
 *
 * Exemption rule (deliberately not an AST pass — two simple, deterministic
 * checks over raw lines):
 *
 *   1. Proximity marker: a line is exempt if IT or any of the up-to-3 lines
 *      immediately above it contains `quarantine(` (the lexicon brand call)
 *      or a `color-parity-ignore` comment. This covers the common shapes —
 *      marker on the same line, on the line directly above (a one-line
 *      preceding comment), or a couple of lines up (a short comment
 *      immediately before a small literal block).
 *   2. Comment-block context: a line that is *itself* comment prose (its
 *      trimmed text starts with `*` — a JSDoc continuation — or `//`) is
 *      exempt if the *enclosing comment block* — the full contiguous run of
 *      `/** ... *\/` or consecutive `//` lines it belongs to, scanned in
 *      both directions, not just upward — contains `color-parity-ignore` or
 *      the bare word `quarantine` anywhere in the block. This is deliberately
 *      looser than rule 1's `quarantine(` (no paren required): the line
 *      under test is prose, not executable code, so there's no call-site to
 *      require — it's illustrating or explaining a quarantine, not literally
 *      being one. Only prose lines get this leniency; a real code line
 *      (`fg: 196,`) never qualifies under rule 2, only rule 1.
 *
 * Ratchet, not a blanket ban: `color-parity-baseline.json` records every
 * violation known at baseline time, keyed by file + a hash of the line's
 * *content* (not its line number, which drifts with every unrelated edit
 * above it). The check fails only on violations absent from the baseline —
 * i.e. new literals introduced since the last `--update`. Fixing a baselined
 * line (migrating it to a role) makes it vanish from the live scan and it is
 * never re-baselined; the ratchet only tightens.
 *
 * Modes:
 *   --update    Rewrite the baseline from the current scan (needs sign-off —
 *               see plan doc "Post-audit decisions" #3; this is not a bypass)
 *   (default)   Fail if any current violation is missing from the baseline
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Product root (harness/): fused @inhuman.tools/quickdraw lives at packages/quickdraw/.
const ROOT = path.resolve(SCRIPT_DIR, "../../..");
const BASELINE_PATH = path.join(SCRIPT_DIR, "color-parity-baseline.json");

const SCAN_ROOTS = ["packages/quickdraw", "packages/harness-tui/src/e2e"];
const SKIP_DIRS = new Set(["node_modules", "dist", "docs", "scripts"]);

// The four literal shapes named in the color-hygiene plan's parity law.
const PATTERNS = [
  { name: "fg-literal", regex: /\bfg:\s*\d+/ },
  { name: "bg-literal", regex: /\bbg:\s*\d+/ },
  { name: "hex-literal", regex: /#[0-9a-f]{3,8}\b/i },
  { name: "dim-true", regex: /\bdim:\s*true/ },
];

// Naming a quarantine (the `quarantine()` brand call) or an explicit ignore
// comment exempts a line — rule 1, proximity. Bare "quarantine" (no paren) is
// the looser rule-2 marker, valid only inside an enclosing comment block.
const PROXIMITY_MARKERS = ["quarantine(", "color-parity-ignore"];
const BLOCK_MARKERS = ["color-parity-ignore", "quarantine"];

// How many lines above the flagged line rule 1 will look for a marker.
const LOOKBACK_WINDOW = 3;

const COMMENT_PROSE_RE = /^(\*|\/\/)/;

/**
 * Groups each file's lines into contiguous comment blocks — a `/** ... *\/`
 * run or a run of consecutive `//` lines — so rule 2 can check a prose
 * line's *whole* enclosing block instead of just adjacent lines. Returns a
 * parallel array `blockOfLine[i]` = index into `blocks`, or -1 if line i is
 * not part of a comment.
 */
function buildCommentBlocks(lines) {
  const blockOfLine = Array.from({ length: lines.length }).fill(-1);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("/*")) {
      let end = i;
      while (end < lines.length && !lines[end].includes("*/")) end++;
      if (end >= lines.length) end = lines.length - 1;
      const idx = blocks.push(lines.slice(i, end + 1).join("\n")) - 1;
      for (let k = i; k <= end; k++) blockOfLine[k] = idx;
      i = end + 1;
    } else if (trimmed.startsWith("//")) {
      let end = i;
      while (end + 1 < lines.length && lines[end + 1].trim().startsWith("//")) end++;
      const idx = blocks.push(lines.slice(i, end + 1).join("\n")) - 1;
      for (let k = i; k <= end; k++) blockOfLine[k] = idx;
      i = end + 1;
    } else {
      i++;
    }
  }
  return { blockOfLine, blocks };
}

function isExempt(lines, index, blockOfLine, blocks) {
  const line = lines[index];

  // Rule 1: marker on this line or up to LOOKBACK_WINDOW lines above it.
  for (let k = Math.max(0, index - LOOKBACK_WINDOW); k <= index; k++) {
    if (PROXIMITY_MARKERS.some((marker) => lines[k].includes(marker))) return true;
  }

  // Rule 2: this line is pure comment prose, and its enclosing comment block
  // (searched whole, not just upward) names its quarantine.
  if (COMMENT_PROSE_RE.test(line.trim())) {
    const blockIdx = blockOfLine[index];
    if (blockIdx !== -1 && BLOCK_MARKERS.some((marker) => blocks[blockIdx].includes(marker))) {
      return true;
    }
  }

  return false;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function collectSourceFiles() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(path.join(ROOT, root))) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const rel = path.relative(ROOT, file);
      if (!rel.split(path.sep).includes("src")) continue; // packages/quickdraw/**/src/**
      files.push(file);
    }
  }
  return files.sort();
}

function scanFile(file) {
  const rel = path.relative(ROOT, file);
  const lines = readFileSync(file, "utf8").split("\n");
  const { blockOfLine, blocks } = buildCommentBlocks(lines);
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matched = PATTERNS.find((p) => p.regex.test(line));
    if (!matched || isExempt(lines, i, blockOfLine, blocks)) continue;
    const trimmed = line.trim();
    violations.push({
      file: rel,
      lineNumber: i + 1,
      line: trimmed,
      pattern: matched.name,
      hash: createHash("sha1").update(trimmed).digest("hex").slice(0, 12),
    });
  }
  return violations;
}

function scanAll() {
  return collectSourceFiles().flatMap(scanFile);
}

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    return [];
  }
}

function baselineKey(entry) {
  return `${entry.file}::${entry.hash}`;
}

function main() {
  const update = process.argv.includes("--update");
  const violations = scanAll();

  if (update) {
    const baseline = violations
      .map((v) => ({ file: v.file, hash: v.hash, pattern: v.pattern, line: v.line }))
      .sort((a, b) => (a.file === b.file ? a.hash.localeCompare(b.hash) : a.file.localeCompare(b.file)));
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Baseline updated: ${baseline.length} known violation${baseline.length === 1 ? "" : "s"} recorded.`);
    process.exit(0);
  }

  const baselineKeys = new Set(loadBaseline().map(baselineKey));
  const newViolations = violations.filter((v) => !baselineKeys.has(baselineKey(v)));

  if (newViolations.length === 0) {
    console.log(
      `Color parity check passed: ${violations.length} known violation${violations.length === 1 ? "" : "s"} (baselined), 0 new.`,
    );
    process.exit(0);
  }

  console.error(
    `\n✗ ${newViolations.length} new color-parity violation${newViolations.length === 1 ? "" : "s"} (not in baseline):\n`,
  );
  for (const v of newViolations) {
    console.error(`  ${v.file}:${v.lineNumber}  [${v.pattern}]  ${v.line}`);
  }
  console.error(`\nEvery raw color literal (fg:/bg: index, hex, dim:true) must be either:`);
  console.error(`  - migrated to a role + prominence (SemanticStyle)`);
  console.error(`  - wrapped in quarantine(rgb, kind) with the quarantine named in a comment, or`);
  console.error(`  - marked with a "color-parity-ignore" comment on the line or the line above`);
  console.error(`\nIf this is accepted pre-existing debt (not new), run with --update to re-baseline`);
  console.error(`— that needs sign-off per the color-hygiene plan; the baseline is a ratchet, not a bypass.`);
  console.error(`Baseline file: ${path.relative(ROOT, BASELINE_PATH)}`);
  process.exit(1);
}

main();
