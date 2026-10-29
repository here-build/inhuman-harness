/**
 * Sole wrap/ellipsis/line-clamp implementation for @quickdraw.
 *
 * Display-column measure via ../measure/index.js.
 *
 * whiteSpace modes (terminal-oriented, not full CSS):
 * - **normal** — collapse runs of space/tab (not newlines) within a line;
 *   hard `\n` still break lines (TUI-pre-line). Edge spaces kept (no .trim()).
 * - **nowrap** — single line; `\n` → space; optional ellipsis.
 * - **pre-wrap** — preserve all spaces + hard newlines; soft-wrap by columns.
 *   Required for composer fidelity (typed double-space / Shift+Enter).
 * - **pre-line** — hard newlines preserved; collapse space/tab runs within line.
 *
 * **Edge spaces are significant** — inline flex runs like " from " must not
 * lose leading/trailing spaces (was: .trim() → "frommarkdownandcode").
 */

import { defaultMeasure, splitAtWidth, type Measure } from "../measure/index.js";

export type WhiteSpace = "normal" | "nowrap" | "pre-wrap" | "pre-line";

export type WrapOpts = {
  width: number;
  whiteSpace?: WhiteSpace;
  ellipsis?: boolean;
  lineClamp?: number;
  measure?: (text: string) => number;
};

function applyClamp(lines: string[], opts: WrapOpts, measure: (t: string) => number, width: number): string[] {
  const clamp = opts.lineClamp;
  if (clamp === undefined || clamp <= 0 || lines.length <= clamp) {
    return lines.length > 0 ? lines : [""];
  }
  const kept = lines.slice(0, clamp);
  const last = kept[clamp - 1] ?? "";
  if (opts.ellipsis !== false) {
    const ell = "…";
    let cut = last.length;
    while (cut > 0 && measure(last.slice(0, cut) + ell) > width) cut--;
    kept[clamp - 1] = last.slice(0, cut) + ell;
  }
  return kept;
}

/**
 * Single grapheme wider than `width` — force progress by taking the
 * whole first grapheme cluster. Must NOT use rest[0]/slice(0,1): those
 * are UTF-16 code units and split astral emoji (😀) into lone surrogates
 * that put() then skips as zero-width → the emoji vanishes.
 */
function firstGrapheme(rest: string): string {
  const segmenter = new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  });
  const first = segmenter.segment(rest)[Symbol.iterator]().next();
  return first.done ? "" : first.value.segment;
}

/** Soft-wrap one hard line without collapsing spaces (column cut). */
function softWrapExact(line: string, width: number, measure: (t: string) => number): string[] {
  if (line === "") return [""];
  if (measure(line) <= width) return [line];

  const lines: string[] = [];
  let rest = line;
  while (rest.length > 0) {
    if (measure(rest) <= width) {
      lines.push(rest);
      break;
    }
    const [head, tail] = splitAtWidth(rest, width);
    if (head.length === 0) {
      const cluster = firstGrapheme(rest);
      if (!cluster) break;
      lines.push(cluster);
      rest = rest.slice(cluster.length);
      continue;
    }
    // Prefer break at last space in head when it leaves a non-empty head word.
    const sp = head.lastIndexOf(" ");
    if (sp !== -1 && sp < head.length - 1) {
      // space not at end: break after space so next line starts at word
      lines.push(head.slice(0, sp + 1));
      rest = head.slice(sp + 1) + tail;
    } else if (sp === head.length - 1 && head.length > 1) {
      // head ends with space — keep it on this line
      lines.push(head);
      rest = tail;
    } else {
      lines.push(head);
      rest = tail;
    }
  }
  return lines.length > 0 ? lines : [""];
}

/** Soft-wrap after collapsing space/tab runs (edge spaces kept as single). */
function softWrapCollapsed(line: string, width: number, measure: (t: string) => number): string[] {
  // Collapse space/tab only — never touch other characters.
  const collapsed = line.replaceAll(/[ \t]+/g, " ");
  if (collapsed === "") return [""];
  if (measure(collapsed) <= width) return [collapsed];

  const parts = collapsed.split(" ");
  const join = (ps: string[]) => ps.join(" ");
  const lines: string[] = [];
  let cur: string[] = [];

  for (const part of parts) {
    const trial = cur.length === 0 ? [part] : [...cur, part];
    const candidate = join(trial);
    if (measure(candidate) <= width) {
      cur = trial;
      continue;
    }
    if (cur.length > 0) {
      lines.push(join(cur));
      cur = [];
    }
    if (measure(part) <= width) {
      cur = [part];
    } else {
      let rest = part;
      while (measure(rest) > width) {
        const [head, tail] = splitAtWidth(rest, width);
        if (head.length === 0) {
          const cluster = firstGrapheme(rest);
          if (!cluster) break;
          lines.push(cluster);
          rest = rest.slice(cluster.length);
        } else {
          lines.push(head);
          rest = tail;
        }
      }
      cur = rest.length > 0 ? [rest] : [];
    }
  }
  if (cur.length > 0) lines.push(join(cur));
  return lines.length > 0 ? lines : [""];
}

/**
 * Wrap `content` into display lines of at most `width` columns.
 * Hard newlines (`\n`) produce line breaks in every mode except `nowrap`.
 */
export function wrapText(content: string, opts: WrapOpts): string[] {
  const measure = opts.measure ?? defaultMeasure;
  const width = Math.max(1, opts.width);
  const ws = opts.whiteSpace ?? "normal";

  if (ws === "nowrap") {
    const line = content.replaceAll("\n", " ");
    if (measure(line) <= width) return [line];
    if (opts.ellipsis && width >= 1) {
      const ell = "…";
      let cut = line.length;
      while (cut > 0 && measure(line.slice(0, cut) + ell) > width) cut--;
      return [line.slice(0, cut) + ell];
    }
    const [head] = splitAtWidth(line, width);
    return [head.length > 0 ? head : ""];
  }

  // Hard line breaks first. Trailing \n → final empty segment (caret on new line).
  const hardLines = content.split("\n");
  const out: string[] = [];

  for (const hard of hardLines) {
    if (ws === "pre-wrap") {
      out.push(...softWrapExact(hard, width, measure));
    } else {
      // normal + pre-line: collapse space/tab within the hard line
      out.push(...softWrapCollapsed(hard, width, measure));
    }
  }

  return applyClamp(out.length > 0 ? out : [""], opts, measure, width);
}

type CachedText = {
  content: string;
  whiteSpace?: WhiteSpace;
  ellipsis?: boolean;
  lineClamp?: number;
};

type WrapCacheEntry = {
  content: string;
  atW: number;
  whiteSpace: WhiteSpace;
  ellipsis: boolean;
  lineClamp: number;
  measure: Measure;
  lines: string[];
  maxLine: number;
};

export type WrappedText = {
  lines: string[];
  /** Widest display column among `lines`. Computed once with the wrap. */
  maxLine: number;
};

/**
 * Width-keyed wrap for a layout text node. Scroll and live paint reuse the
 * same node; `place` and `measure` both wrap, and a partially visible block
 * still wraps its whole string. A later call at the same width returns the
 * lines already computed. Several widths are retained so measure and place can
 * disagree by an inset without thrashing. Content identity is the string
 * reference — a replacement misses. Callers must not mutate the returned array.
 */
const wrapCache = new WeakMap<object, WrapCacheEntry[]>();

function sameWrapKey(hit: WrapCacheEntry, node: CachedText, atW: number, measure: Measure): boolean {
  return (
    hit.content === node.content &&
    hit.atW === atW &&
    hit.whiteSpace === (node.whiteSpace ?? "normal") &&
    hit.ellipsis === (node.ellipsis === true) &&
    hit.lineClamp === (node.lineClamp ?? 0) &&
    hit.measure === measure
  );
}

function widestLine(lines: readonly string[], measure: Measure): number {
  let max = 0;
  for (const line of lines) {
    const width = measure(line);
    if (width > max) max = width;
  }
  return max;
}

export function wrapLayoutText(node: CachedText, width: number, measure: Measure = defaultMeasure): WrappedText {
  const atW = Math.max(1, width);
  const slots = wrapCache.get(node);
  const hit = slots?.find((entry) => sameWrapKey(entry, node, atW, measure));
  if (hit !== undefined) return { lines: hit.lines, maxLine: hit.maxLine };
  const lines = wrapText(node.content, {
    width: atW,
    whiteSpace: node.whiteSpace,
    ellipsis: node.ellipsis,
    lineClamp: node.lineClamp,
    measure,
  });
  const entry: WrapCacheEntry = {
    content: node.content,
    atW,
    whiteSpace: node.whiteSpace ?? "normal",
    ellipsis: node.ellipsis === true,
    lineClamp: node.lineClamp ?? 0,
    measure,
    lines,
    maxLine: widestLine(lines, measure),
  };
  if (slots === undefined) wrapCache.set(node, [entry]);
  else if (slots.length < 8) slots.push(entry);
  else slots[slots.length - 1] = entry;
  return { lines: entry.lines, maxLine: entry.maxLine };
}
