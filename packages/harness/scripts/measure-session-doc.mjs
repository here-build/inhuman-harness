/* eslint-disable security/detect-non-literal-fs-filename -- reads the one file named on the command line */
// Where the bytes of a stored session document are.
//
//   node --max-old-space-size=16384 scripts/measure-session-doc.mjs <file.yjs> [--top N]
//
// Reads the update log (length-prefixed Yjs updates, `dist/yjs/update-log.js`), applies it onto a `Y.Doc`
// the way `DocumentImageStore.read` does, walks every shared type, and prints the live string bytes per
// document key (an entity's field name, such as `outcomeJson`) and per entity type and key
// (`harness:job:file-mutate :: priorContent`), with the file size and the size of the joined snapshot.
// Read-only: the file is read once and never written. Build the core first
// (`pnpm --filter @inhuman.tools/harness build`); the log framing comes from `dist`.
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";

import * as decoding from "lib0/decoding";
import * as Y from "yjs";

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
  if (file === undefined) throw new Error("usage: measure-session-doc.mjs <file.yjs> [--top N]");
  return { file, top };
}

/**
 * The updates of an image and how they were framed. The daemon's reader takes only the length-prefixed log;
 * an older image of bare updates back to back is read here so it can still be measured, and is reported as
 * one the daemon would reject.
 * @param {Uint8Array} image
 * @returns {{ updates: Uint8Array[]; framing: string; ignoredBytes: number } | null}
 */
function readImage(image) {
  const framed = readUpdateLog(image);
  if (framed !== null) return { updates: framed, framing: "length-prefixed (the daemon reads it)", ignoredBytes: 0 };
  const updates = [];
  let offset = 0;
  while (offset < image.byteLength) {
    const rest = image.subarray(offset);
    const decoder = decoding.createDecoder(rest);
    const probe = new Y.Doc();
    try {
      Y.readUpdate(decoder, probe);
    } catch {
      break;
    } finally {
      probe.destroy();
    }
    if (decoder.pos === 0) break;
    updates.push(rest.subarray(0, decoder.pos));
    offset += decoder.pos;
  }
  if (updates.length === 0) return null;
  return {
    updates,
    framing: "bare updates, no length prefix (the daemon rejects it)",
    ignoredBytes: image.byteLength - offset,
  };
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
 * @typedef {{ type: Y.AbstractType<unknown>; label: string; owner: string }} Frame
 * @param {Y.Item} item
 * @param {string} key
 * @param {Frame} frame
 * @param {Frame[]} stack
 */
function visit(item, key, frame, stack) {
  const { content } = item;
  if (content instanceof Y.ContentType) {
    stack.push({ type: content.type, label: key, owner: frame.owner });
  } else if (content instanceof Y.ContentString) {
    count(frame.owner, key, content.str);
  } else if (content instanceof Y.ContentAny || content instanceof Y.ContentJSON) {
    count(frame.owner, key, content.arr);
  } else if (content instanceof Y.ContentBinary) {
    count(frame.owner, key, content.content);
  } else if (content instanceof Y.ContentEmbed) {
    count(frame.owner, key, content.embed);
  }
}

/**
 * Walks every live value under the shared roots with a stack, so a deep spine cannot overflow the call stack.
 * Under the `types` root the first level of keys names the entity type; everything beneath it belongs to that type.
 * @param {Y.Doc} doc
 */
function walk(doc) {
  /** @type {Frame[]} */
  const stack = [];
  for (const [name, type] of doc.share) {
    if (name !== "types") {
      stack.push({ type, label: name, owner: name });
      continue;
    }
    for (const [entityType, item] of type._map) {
      if (!item.deleted && item.content instanceof Y.ContentType) {
        stack.push({ type: item.content.type, label: entityType, owner: entityType });
      }
    }
  }
  let types = 0;
  while (stack.length > 0) {
    const frame = stack.pop();
    const { type, label } = frame;
    types += 1;
    // Map entries and attributes: the latest item of each key, when it is not a tombstone.
    for (const [key, item] of type._map) if (!item.deleted) visit(item, key, frame, stack);
    // Sequence entries: an array's elements, an element's children, a text's runs.
    for (let item = type._start; item !== null; item = item.right) {
      if (!item.deleted) visit(item, `${label}[]`, frame, stack);
    }
  }
  return types;
}

/** A key as the table prints it: Plexus keeps some attributes under control characters. */
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
  if (read === null) throw new Error(`${file} holds no Yjs update`);
  const { updates, framing, ignoredBytes } = read;
  const entryBytes = updates.reduce((sum, update) => sum + update.byteLength, 0);

  const started = Date.now();
  let lastProgress = started;
  const doc = new Y.Doc();
  for (const [index, update] of updates.entries()) {
    Y.applyUpdate(doc, update);
    const now = Date.now();
    if (now - lastProgress >= PROGRESS_MS) {
      lastProgress = now;
      stderr.write(`applied ${index + 1}/${updates.length} updates after ${((now - started) / 1000).toFixed(0)} s\n`);
    }
  }
  const decodeSeconds = (Date.now() - started) / 1000;

  const snapshotBytes = Y.encodeStateAsUpdate(doc).byteLength;
  const roots = [...doc.share.keys()];
  const types = walk(doc);
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
  line("joined snapshot bytes", grouped(snapshotBytes));
  line("decode", `${decodeSeconds.toFixed(1)} s`);
  line("shared roots", `${roots.length} (${roots.slice(0, 5).join(", ")}${roots.length > 5 ? ", ..." : ""})`);
  line("types walked", grouped(types));
  line("live string bytes", `${grouped(total.bytes)} in ${grouped(total.strings)} strings`);
  line("  of the snapshot", percent(total.bytes, snapshotBytes));
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
