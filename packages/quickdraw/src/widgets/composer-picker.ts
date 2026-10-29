/**
 * Composer picker algebra: peek-scroll, identity keys, paint window,
 * right-│ coverage. Pure — no I/O, no Tea writeback.
 */

import { wrapText } from "../layout/text.js";
import { FgP, type Rgb } from "../lexicon/index.js";

export const COMPOSER_COMMAND_MAX_VISIBLE = 8;

const DEFAULT_TEXT_W = 40;

export type PickerRow = {
  key?: string;
  name: string;
  status?: string;
  annotation?: string;
  description?: string;
  actionDisplayName?: string;
  actions?: ReadonlyArray<{ name: string; displayName: string; hotkey?: string }>;
  href?: string;
};

export type PickerPaintInput = {
  readonly rows: readonly PickerRow[];
  readonly selectedKey: string | null;
  readonly scrollOffset: number;
  readonly hoverKey: string | null;
  readonly pressKey: string | null;
  readonly viewport?: number;
  readonly textW?: number;
};

export type PickerPaint = {
  readonly bodySegRows: Array<
    Array<{
      text: string;
      role?: string;
      prominence?: number;
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      href?: string;
      fgRgb?: Rgb;
    }>
  >;
  readonly bodyGlyphs: string[];
  readonly bodyRightCoverage: number[];
  readonly paintRowToKey: readonly (string | null)[];
  readonly selectedIndex: number;
};

type KeyedPickerRow = PickerRow & { key: string };

type BodySeg = {
  text: string;
  role?: string;
  prominence?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  href?: string;
  fgRgb?: Rgb;
};

type NameKind = "selected" | "press-full" | "half" | "idle";

export function catalogKey(name: string): string {
  return `catalog:${name.replace(/^\//, "")}`;
}

export function ensureChoiceKeys(rows: readonly PickerRow[], opts?: { catalog?: boolean }): KeyedPickerRow[] {
  return rows.map((row, index) => {
    if (row.key != null && row.key !== "") return row as KeyedPickerRow;
    const key = opts?.catalog ? catalogKey(row.name) : `choice:${index}:${row.name}`;
    return { ...row, key };
  });
}

export function reconcileSelectedKey(prev: string | null, rows: readonly PickerRow[]): string | null {
  const keyed = ensureChoiceKeys(rows);
  if (prev != null && keyed.some((row) => row.key === prev)) return prev;
  return keyed[0]?.key ?? null;
}

export function peekScroll(selectedIndex: number, n: number, viewport: number, scroll: number): number {
  if (n <= 0 || selectedIndex < 0) return 0;
  if (n <= viewport) return 0;
  const maxS = n - viewport;
  let lower = Math.max(0, selectedIndex - viewport + 1);
  let upper = Math.min(maxS, selectedIndex);
  if (viewport >= 3 && selectedIndex < n - 1) {
    lower = Math.max(lower, selectedIndex - viewport + 2);
  }
  if (viewport >= 3 && selectedIndex > 0) {
    upper = Math.min(upper, selectedIndex - 1);
  }
  if (lower > upper) {
    lower = Math.max(0, selectedIndex - viewport + 1);
    upper = Math.min(maxS, selectedIndex);
  }
  if (scroll >= lower && scroll <= upper) return scroll;
  if (scroll < lower) return lower;
  return upper;
}

/**
 * 1-cell-tall coverage of the V-row track.
 *
 * `scrollOffset` lives in `[0, n - viewport]`. Map that onto `[0, V - 1]` so
 * s=0 is flush on cell 0 and s=max is flush on the last cell. Mapping through
 * `n` instead leaves the max-scroll window one cell past the track as n grows.
 */
export function thumbCoverage(n: number, viewport: number, scrollOffset: number): number[] {
  const coverage = Array.from({ length: Math.max(0, viewport) }, () => 0);
  if (n <= viewport || viewport <= 0) return coverage;
  const maxS = n - viewport;
  const s = Math.min(maxS, Math.max(0, scrollOffset));
  const startNum = s * (viewport - 1);
  const endNum = startNum + maxS;
  for (let i = 0; i < viewport; i++) {
    const lo = Math.max(startNum, i * maxS);
    const hi = Math.min(endNum, (i + 1) * maxS);
    coverage[i] = Math.max(0, hi - lo) / maxS;
  }
  return coverage;
}

/** Wrapped overlay lines + the same right-│ thumb the slash picker uses. */
export function paintOverlayLines(input: {
  readonly text: string;
  readonly scrollOffset: number;
  readonly viewport: number;
  readonly textW?: number;
}): {
  readonly bodySegRows: PickerPaint["bodySegRows"];
  readonly bodyGlyphs: string[];
  readonly bodyRightCoverage: number[];
  readonly lineCount: number;
} {
  const textW = input.textW ?? DEFAULT_TEXT_W;
  const lines = wrapText(input.text, { width: Math.max(1, textW), whiteSpace: "pre-wrap" });
  const n = lines.length;
  const viewport = input.viewport <= 0 ? Math.max(1, n) : Math.max(1, Math.min(n, input.viewport));
  const maxS = Math.max(0, n - viewport);
  const scroll = Math.min(maxS, Math.max(0, input.scrollOffset));
  const visible = n <= viewport ? lines : lines.slice(scroll, scroll + viewport);
  const coverage = thumbCoverage(n, visible.length, scroll);
  return {
    bodySegRows: visible.map((line) => [{ text: line.length > 0 ? line : " ", role: "muted", prominence: FgP.ghost }]),
    bodyGlyphs: visible.map(() => " "),
    bodyRightCoverage: coverage,
    lineCount: n,
  };
}

/** Admission deck: counter in the mark cell, first message primary, later ghost. */
export function paintNumberedOverlayLines(input: {
  readonly rows: readonly string[];
  readonly scrollOffset: number;
  readonly viewport: number;
  readonly textW?: number;
}): {
  readonly bodySegRows: PickerPaint["bodySegRows"];
  readonly bodyGlyphs: string[];
  readonly bodyRightCoverage: number[];
  readonly lineCount: number;
} {
  const textW = input.textW ?? DEFAULT_TEXT_W;
  const wrapW = Math.max(1, textW);
  const rows: PickerPaint["bodySegRows"] = [];
  const glyphs: string[] = [];
  for (let i = 0; i < input.rows.length; i++) {
    const textStyle =
      i === 0
        ? { role: "foreground" as const, prominence: FgP.primary }
        : { role: "muted" as const, prominence: FgP.ghost };
    const wrapped = wrapText(input.rows[i] ?? "", { width: wrapW, whiteSpace: "pre-wrap" });
    const lines = wrapped.length > 0 ? wrapped : [" "];
    for (const [li, line_] of lines.entries()) {
      const line = line_ ?? " ";
      rows.push([{ text: line.length > 0 ? line : " ", ...textStyle }]);
      glyphs.push(li === 0 ? String(i + 1) : " ");
    }
  }
  const n = rows.length;
  const viewport = input.viewport <= 0 ? Math.max(1, n) : Math.max(1, Math.min(n, input.viewport));
  const maxS = Math.max(0, n - viewport);
  const scroll = Math.min(maxS, Math.max(0, input.scrollOffset));
  const visible = n <= viewport ? rows : rows.slice(scroll, scroll + viewport);
  const visibleGlyphs = n <= viewport ? glyphs : glyphs.slice(scroll, scroll + viewport);
  return {
    bodySegRows: visible,
    bodyGlyphs: visibleGlyphs,
    bodyRightCoverage: thumbCoverage(n, visible.length, scroll),
    lineCount: n,
  };
}

export function paintPicker(input: PickerPaintInput): PickerPaint {
  const keyed = ensureChoiceKeys(input.rows);
  const n = keyed.length;
  const viewport = input.viewport ?? COMPOSER_COMMAND_MAX_VISIBLE;
  const textW = input.textW ?? DEFAULT_TEXT_W;
  const maxS = Math.max(0, n - viewport);
  const scroll = Math.min(maxS, Math.max(0, input.scrollOffset));
  const visible = keyed.slice(scroll, scroll + viewport);
  const choiceCoverage = thumbCoverage(n, viewport, scroll);

  const selectedIndex = input.selectedKey ? keyed.findIndex((row) => row.key === input.selectedKey) : -1;

  const bodySegRows: BodySeg[][] = [];
  const bodyGlyphs: string[] = [];
  const bodyRightCoverage: number[] = [];
  const paintRowToKey: Array<string | null> = [];

  for (const [i, element] of visible.entries()) {
    const row = element!;
    const kind = nameKind(row.key, input);
    const nameLines = wrapText(rowDisplayName(row), {
      width: Math.max(1, textW),
      whiteSpace: "normal",
    });
    for (let li = 0; li < nameLines.length; li++) {
      const line = nameLines[li] ?? " ";
      bodyGlyphs.push(li === 0 && kind === "selected" ? "›" : " ");
      bodySegRows.push(
        li === 0 && nameLines.length === 1
          ? commandRowSegs(row, textW, kind)
          : [{ text: line.length > 0 ? line : " ", ...nameStyle(kind) }],
      );
      bodyRightCoverage.push(li === 0 ? (choiceCoverage[i] ?? 0) : 0);
      paintRowToKey.push(row.key);
    }

    const href = (row.href ?? "").trim();
    if (href.length > 0) {
      bodyGlyphs.push(" ");
      bodySegRows.push(linkRowSegs(href, textW));
      bodyRightCoverage.push(0);
      paintRowToKey.push(row.key);
    }
  }

  return {
    bodySegRows,
    bodyGlyphs,
    bodyRightCoverage,
    paintRowToKey,
    selectedIndex,
  };
}

function nameKind(key: string, input: PickerPaintInput): NameKind {
  if (input.selectedKey != null && key === input.selectedKey) return "selected";
  if (input.pressKey != null && key === input.pressKey && input.hoverKey === input.pressKey) {
    return "press-full";
  }
  if (key === input.hoverKey || key === input.pressKey) return "half";
  return "idle";
}

function nameStyle(kind: NameKind): {
  role: string;
  prominence: number;
  bold?: boolean;
} {
  if (kind === "selected" || kind === "press-full") {
    return {
      role: "foreground",
      prominence: FgP.primary,
      bold: true,
    };
  }
  if (kind === "half") {
    return { role: "muted", prominence: FgP.secondary };
  }
  return { role: "muted", prominence: FgP.ghost };
}

function descStyle(kind: NameKind): { role: string; prominence: number } {
  if (kind === "idle") {
    return { role: "muted", prominence: FgP.ghost };
  }
  return { role: "muted", prominence: FgP.secondary };
}

function rowDisplayName(row: PickerRow): string {
  let name = row.name;
  const annotation = (row.annotation ?? "").trim();
  if (annotation.length > 0) name = `${name} · ${annotation}`;
  if (row.status && row.status.trim().length > 0) {
    name = `${name} · ${row.status.trim()}`;
  }
  return name.length > 0 ? name : " ";
}

function commandRowSegs(row: PickerRow, textW: number, kind: NameKind): BodySeg[] {
  const leftStyle = nameStyle(kind);
  const rightStyle = descStyle(kind);
  const dimStyle = { role: "muted" as const, prominence: FgP.ghost };

  let name = rowDisplayName(row);
  const description = (row.description ?? "").trim();
  let right = description.length > 0 && description !== row.name ? description : "";

  const minGap = 1;
  let used = name.length;
  if (right.length > 0) used += minGap + right.length;

  if (used > textW && right.length > 0) {
    const room = textW - name.length - minGap;
    right = room > 0 ? right.slice(0, room) : "";
    used = name.length + (right.length > 0 ? minGap + right.length : 0);
  }
  if (used > textW) {
    while (name.length > textW && name.length > 0) name = name.slice(0, -1);
    right = "";
  }

  const segs: BodySeg[] = [{ text: name.length > 0 ? name : " ", ...leftStyle }];
  if (right.length > 0) {
    const gap = Math.max(minGap, textW - name.length - right.length);
    segs.push({ text: " ".repeat(gap), ...dimStyle }, { text: right, ...rightStyle });
  }
  return segs;
}

function linkRowSegs(href: string, textW: number): BodySeg[] {
  let label = href;
  if (label.length > textW) {
    label = textW <= 1 ? "…" : `${label.slice(0, Math.max(1, textW - 1))}…`;
  }
  return [{ text: label.length > 0 ? label : " ", role: "accent", underline: true, href }];
}
