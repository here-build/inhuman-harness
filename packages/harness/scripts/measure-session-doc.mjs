/* eslint-disable security/detect-non-literal-fs-filename -- reads the one file named on the command line */
// Where the bytes of a stored session document are.
//
//   node --max-old-space-size=16384 scripts/measure-session-doc.mjs <file.log> [--top N]
//
// Reads the update log (length-prefixed DocumentContainer updates, `dist/yjs/update-log.js`),
// walks the document nodes and fields, and prints the live string bytes per key.
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";

import { readUpdateLog } from "../dist/yjs/update-log.js";

/** Same figure as `BLOB_INLINE_MAX_CHARS` in harness-model: a string longer than this is what the blob store takes. */
const INLINE_MAX_CHARS = 8 * 1024;
const PROGRESS_MS = 15_000;

/** @param {string[]} args */
function parseArgs(args) {
  let file;
  let top = 20;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--top") {
      top = Number(args[(index += 1)]);
      if (!Number.isInteger(top) || top < 1) throw new Error("--top takes a positive integer");
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}`);
    } else if (file === undefined) {
      file = arg;
    } else {
      throw new Error("one file only");
    }
  }
  if (file === undefined) throw new Error("usage: measure-session-doc.mjs <file> [--top N]");
  return { file, top };
}

/**
 * @param {Uint8Array} image
 * @returns {{ updates: Uint8Array[]; framing: string; ignoredBytes: number } | null}
 */
function readImage(image) {
  const framed = readUpdateLog(image);
  if (framed !== null) return { updates: framed, framing: "length-prefixed (the daemon reads it)", ignoredBytes: 0 };
  return null;
}

/** String and binary bytes under one label. */
class Tally {
  /** @type {Map<string, { strings: number; bytes: number; overBytes: number; overStrings: number; largest: number; binary: number }>} */
  rows = new Map();

  /** @param {string} label */
  #row(label) {
    let row = this.rows.get(label);
    if (row === undefined) {
      row = { strings: 0, bytes: 0, overBytes: 0, overStrings: 0, largest: 0, binary: 0 };
      this.rows.set(label, row);
    }
    return row;
  }

  /**
   * Counts every string inside a value: a bare string, or the strings of an array or object.
   * @param {string} label
   * @param {unknown} value
   */
  count(label, value) {
    if (typeof value === "string") {
      const row = this.#row(label);
      const bytes = Buffer.byteLength(value, "utf8");
      row.strings += 1;
      row.bytes += bytes;
      row.largest = Math.max(row.largest, bytes);
      if (value.length > INLINE_MAX_CHARS) {
        row.overBytes += bytes;
        row.overStrings += 1;
      }
    } else if (value instanceof Uint8Array) {
      this.#row(label).binary += value.byteLength;
    } else if (Array.isArray(value)) {
      for (const entry of value) this.count(label, entry);
    } else if (value !== null && typeof value === "object") {
      for (const entry of Object.values(value)) this.count(label, entry);
    }
  }

  /** Rows by string bytes, largest first. */
  sorted() {
    return [...this.rows.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  }

  total() {
    const total = { strings: 0, bytes: 0, overBytes: 0, overStrings: 0, binary: 0 };
    for (const row of this.rows.values()) {
      total.strings += row.strings;
      total.bytes += row.bytes;
      total.overBytes += row.overBytes;
      total.overStrings += row.overStrings;
      total.binary += row.binary;
    }
    return total;
  }
}

const byKey = new Tally();
const byOwnerAndKey = new Tally();

/**
 * @param {string} owner the entity type the value belongs to
 * @param {string} key
 * @param {unknown} value
 */
function count(owner, key, value) {
  byKey.count(key, value);
  byOwnerAndKey.count(`${owner} :: ${key}`, value);
}

/**
 * Walks every node under a serialized document.
 * @param {any} node
 */
function walkNode(node) {
  if (!node || typeof node !== "object") return 0;
  let countWalked = 1;
  const tag = node.tag || "unknown";
  if (node.columns) {
    for (const [key, val] of Object.entries(node.columns)) {
      count(tag, key, val);
    }
  }
  if (node.state) {
    for (const [key, val] of Object.entries(node.state)) {
      count(tag, key, val);
    }
  }
  if (node.children) {
    for (const child of Object.values(node.children)) {
      countWalked += walkNode(child);
    }
  }
  if (node.childLists) {
    for (const list of Object.values(node.childLists)) {
      if (Array.isArray(list)) {
        for (const child of list) {
          countWalked += walkNode(child);
        }
      }
    }
  }
  return countWalked;
}

/** A key as the table prints it: keeps some attributes under control characters. */
const printable = (/** @type {string} */ key) =>
  key.replaceAll(/[\u0000-\u001f\u007f]/g, (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, "0")}`);
/** @param {number} value */
const grouped = (value) => value.toLocaleString("en-US");
/** @param {number} part @param {number} whole */
const percent = (part, whole) => (whole === 0 ? "0.0%" : `${((100 * part) / whole).toFixed(1)}%`);

/**
 * @param {string} title
 * @param {Tally} tally
 * @param {number} top
 */
function table(title, tally, top) {
  const all = tally.sorted();
  const total = tally.total();
  const header = [title, "strings", "string bytes", "share", "over 8192", "largest"];
  const body = all
    .slice(0, top)
    .map(([key, row]) => [
      printable(key),
      grouped(row.strings),
      grouped(row.bytes),
      percent(row.bytes, total.bytes),
      grouped(row.overBytes),
      grouped(row.largest),
    ]);
  const widths = header.map((cell, column) => Math.max(cell.length, ...body.map((row) => row[column].length)));
  const render = (/** @type {string[]} */ cells) =>
    cells
      .map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])))
      .join("  ");
  stdout.write(`${render(header)}\n${widths.map((width) => "-".repeat(width)).join("  ")}\n`);
  for (const row of body) stdout.write(`${render(row)}\n`);
  if (all.length > top) stdout.write(`(${grouped(all.length - top)} more)\n`);
}

function main() {
  const { file, top } = parseArgs(argv.slice(2));
  const fileBytes = statSync(file).size;
  const image = readFileSync(file);
  const read = readImage(image);
  if (read === null) throw new Error(`${file} holds no document update`);
  const { updates, framing, ignoredBytes } = read;
  const entryBytes = updates.reduce((sum, update) => sum + update.byteLength, 0);

  const started = Date.now();
  let types = 0;
  for (const update of updates) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(update));
      if (parsed && typeof parsed === "object" && parsed.root) {
        types += walkNode(parsed.root);
      }
    } catch {}
  }
  const decodeSeconds = (Date.now() - started) / 1000;
  const total = byKey.total();

  const line = (/** @type {string} */ name, /** @type {string} */ value) =>
    stdout.write(`${name.padEnd(24)}${value}\n`);
  line("file", basename(file));
  line("file bytes", grouped(fileBytes));
  line("framing", framing);
  line(
    "log entries",
    `${grouped(updates.length)} (${grouped(entryBytes)} bytes)${ignoredBytes === 0 ? "" : `, ${grouped(ignoredBytes)} trailing bytes are not an update`}`,
  );
  line("decode", `${decodeSeconds.toFixed(1)} s`);
  line("types walked", grouped(types));
  line("live string bytes", `${grouped(total.bytes)} in ${grouped(total.strings)} strings`);
  line(
    `  over ${grouped(INLINE_MAX_CHARS)} chars`,
    `${grouped(total.overBytes)} in ${grouped(total.overStrings)} strings (${percent(total.overBytes, total.bytes)} of string bytes)`,
  );
  line("live binary bytes", grouped(total.binary));
  stdout.write("\n");
  table("key", byKey, top);
  stdout.write("\n");
  table("entity type :: key", byOwnerAndKey, top);
}

try {
  main();
} catch (error) {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
}
