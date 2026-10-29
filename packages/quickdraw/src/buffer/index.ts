/**
 * Dual-frame cell buffer + row damage + ANSI emit + content guard.
 * No layout. No TEA. Pure grid → bytes.
 *
 * Wide glyphs: display width 2+ → glyph cell + trailing placeholder cells.
 * Emit **skips** placeholders (TERMINAL P3) so terminals don't advance 3 cols.
 */

import type { Rgb } from "../lexicon/index.js";
import { graphemeWidth, isTwoColumnSymbol, isUnitWidthRun } from "../measure/index.js";

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/** Clamp a byte channel to [0,255]; non-finite → 0. Used by SGR emit. */
function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

// ── Content guard ───────────────────────────────────────────────────────────
// Model/user text must never emit CSI that mutates the terminal.

const CSI_OR_ESC = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B./g;
// C2: OSC (ESC ] ... BEL/ST), DCS/SOS/PM/APC (ESC P/X/^/_ ... ST) carry payloads
// (hyperlinks via OSC 8, titles via OSC 0, color queries) that must not leak as
// visible text. Match terminated first, then strip any dangling intro byte.
const OSC_OR_DCS = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[PX^_][^\u001B]*\u001B\\/g;
// Partial intros only: OSC = ESC ], DCS/SOS/PM/APC = ESC P / X / ^ / _.
// (Was `/\x1b[][PX^_]/g` — empty class `[]` matched nothing, ever.)
const OSC_OR_DCS_PARTIAL = /\u001B[\]PX^_]/g;

/**
 * Sanitize text that will be painted as content cells (not our emit path).
 * Removes ESC/CSI/OSC/DCS entirely for v1 (safest).
 */
export function guardContent(text: string): string {
  if (!text.includes("\u001B") && !text.includes("\u009B")) return text;
  // OSC/DCS first — they contain their own ESC, so strip before CSI regex sees them.
  let out = text.replaceAll(OSC_OR_DCS, "");
  out = out.replaceAll(OSC_OR_DCS_PARTIAL, "");
  out = out.replaceAll(CSI_OR_ESC, "");
  out = out.replaceAll(/\u009B[0-9;?]*[ -/]*[@-~]/g, "");
  out = out.replaceAll("\u001B", "");
  return out;
}

// ── Types ───────────────────────────────────────────────────────────────────

export type Style = {
  bold?: boolean;
  /**
   * ANSI SGR 2 faint. **Not authorable** — widgets state `prominence`, not
   * `dim`. Prominence is the authoring concept; the resolver may *emit*
   * `dim` as the ansi16 degradation of `ghost`/`whisper`, where truecolor
   * fades don't exist. This field stays for that emit path only.
   */
  dim?: boolean;
  /** ANSI SGR 9 crossed-out. Markdown ~~strike~~ etc. */
  strike?: boolean;
  /** ANSI SGR 3 italic. Voice inflection — never expressed via `dim`. */
  italic?: boolean;
  /** ANSI SGR 4 underline. Link affordance: a link is accent + underline. */
  underline?: boolean;
  /** OSC 8 hyperlink target. Painted with accent + underline. */
  href?: string;
  /** 0–255 ANSI / xterm-256 index. Prefer fgRgb when truecolor available. */
  fg?: number;
  /**
   * Truecolor foreground (0–255 per channel). Wins over `fg` when set.
   * From ../theme/index.js role resolve — not hand-picked hex in widgets.
   */
  fgRgb?: Rgb;
  /**
   * Background. **Undefined means transparent** (inherit terminal ground).
   * Never paint default black for unpainted cells (TERMINAL O1).
   */
  bg?: number;
  /** Truecolor background; wins over `bg` when set. Still omit when transparent. */
  bgRgb?: Rgb;
  /**
   * Occupy the background without painting a color (TERMINAL O1).
   * Omitted bg fuses with the cell underneath (panel fill under text).
   * `cast: "transparent"` claims absence so lower layers cannot show through.
   */
  cast?: "transparent";
  /**
   * Procedural background **shader id** (open string).
   * Product: GLSL catalog ids (`gradient`, `aurora`, `doom`, or load path).
   * Present expands to truecolor `bgRgb` only (no sub-cell glyphs).
   * Typed as `string` here to keep buffer decoupled from `../internals/bgfx/index.js`;
   * the branded `BgFxId` lives in that package.
   */
  bgFx?: string;
  /** Region-local U ∈ [0,1] baked by `fillBgFx` (optional; else buffer coords). */
  bgFxU?: number;
  /** Region-local V ∈ [0,1] baked by `fillBgFx`. */
  bgFxV?: number;
  /**
   * Multiplies global bgFx opacity (0–1). Quiet wash over ground.
   * @see setBgFxOpacity
   */
  bgFxOpacity?: number;
  /**
   * Semantic role intent (ColorResolver dual-dirty). Not emitted to SGR;
   * paint-time resolve re-solves against current theme/depth.
   */
  role?: string;
  /** Own prominence request 0–1 (composed with regionProminence). */
  prominence?: number;
  /**
   * Background role intent (ColorResolver dual-dirty), mirroring `role` for
   * the BG ladder (panels, washes, surface). Not emitted to SGR directly —
   * paint-time resolve turns it into `bg`/`bgRgb` against theme/depth.
   */
  bgRole?: string;
  /** Own background prominence request 0–1, mirroring `prominence`. */
  bgProminence?: number;
  /**
   * Local surface for FG opacity (prominence dissolve target). When text
   * sits on painted furniture that is not this cell's bg, pass the parent
   * surface role so low prominence fades into *that* color, not theme ground.
   */
  surfaceRole?: string;
  /** Already-painted background, used as a fallback FG dissolve target. */
  surfaceRgb?: Rgb;
  /** Solidity of surfaceRole (BgP); default solid when surfaceRole set. */
  surfaceProminence?: number;
  /**
   * FG dissolve target (another text role, not a BG surface). Low
   * prominence fades toward that role's ink so a chromatic run can fuse
   * into a contour. Distinct from {@link surfaceRole} (panel furniture).
   */
  fuseRole?: string;
  /** Prominence of {@link fuseRole} (default ghost — box contour). */
  fuseProminence?: number;
  /**
   * Mix this role's ink into {@link role} by {@link tint}. 0 = role only,
   * 1 = full tint. Applied before prominence fade so a remaining-fill can
   * warm toward warning while still dissolving into the contour.
   */
  tintRole?: string;
  /** 0..1 mix of {@link tintRole} into {@link role}. */
  tint?: number;
  /** Region de-emphasis 0–1 (modal/backdrop). Resolver composition only. */
  regionProminence?: number;
  /**
   * Cell is part of an active text selection. The ColorResolver applies the
   * HK-aware perception-preserving recolor (see quickdraw-theme/selection.ts)
   * to fg AND bg — shifting apparent lightness without touching hue. This
   * solves the Zed #17313 blend problem by construction (no alpha-blend, no
   * reverse-video). Dual-dirty: must participate in cellEq or toggling
   * selection won't dirty the row (silent stale frame).
   */
  selected?: boolean;
};

export type Cell = {
  /**
   * Grapheme for this column. Empty when `placeholder` (wide-glyph mate).
   * Emit skips placeholders so wide chars consume 2 columns, not 3.
   */
  ch: string;
  style: Style;
  /**
   * Trailing mate of a wide (or multi-column) glyph to the left.
   * Not written to the terminal; occupies a grid column only.
   */
  placeholder?: boolean;
};

export type Buffer = {
  width: number;
  height: number;
  /** row-major, length = width * height */
  cells: Cell[];
};

const BLANK: Cell = { ch: " ", style: {} };

/** Sentinel ch for placeholder mates — never emitted. */
export const PLACEHOLDER_CH = "";

// ── Grid ops ────────────────────────────────────────────────────────────────

export function createBuffer(width: number, height: number): Buffer {
  const n = width * height;
  const cells = new Array<Cell>(n);
  for (let i = 0; i < n; i++) cells[i] = { ...BLANK, style: {} };
  return { width, height, cells };
}

export function clear(buf: Buffer): void {
  for (let i = 0; i < buf.cells.length; i++) {
    buf.cells[i] = { ch: " ", style: {} };
  }
}

/**
 * Transparent bg inherits the cell under paint (panel fill under border/text).
 * Explicit `bg` / `bgRgb` / `bgFx` on the incoming style wins. Matches TERMINAL O1:
 * undefined bg means transparent, not "clear to black."
 * `cast: "transparent"` claims that absence — occupy the cell, do not fuse.
 * Procedural `bgFx` (+ baked UV) also inherits so text/border over fx keeps the field.
 */
export function mergeStyle(under: Style, over: Style): Style {
  const out: Style = { ...over };
  const overClaimsBg = over.bg !== undefined || over.bgRgb !== undefined || over.bgFx !== undefined;
  if (overClaimsBg || over.cast === "transparent") return out;
  if (under.bgFx !== undefined) {
    out.bgFx = under.bgFx;
    if (under.bgFxU !== undefined) out.bgFxU = under.bgFxU;
    if (under.bgFxV !== undefined) out.bgFxV = under.bgFxV;
    if (under.bgFxOpacity !== undefined) out.bgFxOpacity = under.bgFxOpacity;
    if (under.bgRgb !== undefined) out.bgRgb = under.bgRgb;
  } else if (under.bgRgb !== undefined) {
    out.bgRgb = under.bgRgb;
  } else if (under.bg !== undefined) {
    out.bg = under.bg;
  }
  return out;
}

function writeCell(buf: Buffer, x: number, y: number, cell: Cell): void {
  if (x < 0 || x >= buf.width || y < 0 || y >= buf.height) return;
  const i = y * buf.width + x;
  const prev = buf.cells[i]!;
  // C1/C6: overwriting a wide glyph's primary cell (prev non-placeholder whose
  // trailing mate(s) are placeholders) orphans those placeholders — whether the
  // incoming cell is a narrow glyph (C1) or a new wide glyph's placeholder that
  // lands on the old primary (C6: put("a漢") then put("漢")). Emit skips
  // placeholders, so an orphan shifts subsequent columns. Clear consecutive
  // trailing mates on this row before writing.
  if (!prev.placeholder) {
    const rowEnd = (y + 1) * buf.width;
    for (let j = i + 1; j < rowEnd; j++) {
      const mate = buf.cells[j];
      if (!mate?.placeholder) break;
      buf.cells[j] = { ...BLANK };
    }
  }
  buf.cells[i] = {
    ...cell,
    style: mergeStyle(prev.style, cell.style),
  };
}

/**
 * Put text at (x,y) walking **grapheme clusters** by display width.
 * - **ContentGuard first** — strip ESC/CSI so measure (string-width strips ANSI)
 *   and put agree. Bare ESC is width 0; leaving `[2J…` after skipping ESC desyncs
 *   layout width and can still break a live terminal if re-emitted.
 * - width 0 (combining/ZW alone): refused — do not advance
 * - width 1: one cell
 * - width ≥ 2: glyph + (w-1) mates; clips if no room for full wide span.
 *   CJK/emoji mates are placeholders (emit skips). {@link isTwoColumnSymbol}
 *   mates are a real space so a wcwidth-1 TTY still advances past the ink.
 */
export function put(buf: Buffer, x: number, y: number, text: string, style: Style = {}): void {
  if (y < 0 || y >= buf.height) return;
  // Chokepoint: all content paths (markdown, highlight, widgets) land here.
  text = guardContent(text);
  let cx = x;
  if (isUnitWidthRun(text)) {
    for (const element of text) {
      if (cx >= buf.width) break;
      if (cx >= 0) {
        writeCell(buf, cx, y, { ch: element!, style, placeholder: false });
      }
      cx += 1;
    }
    return;
  }

  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    const w = Math.max(0, graphemeWidth(segment));
    if (w === 0) continue;

    if (cx + w > buf.width) {
      if (cx >= buf.width) break;
      if (w > 1) break;
    }

    if (cx < 0) {
      cx += w;
      continue;
    }

    writeCell(buf, cx, y, { ch: segment, style, placeholder: false });
    const pad = isTwoColumnSymbol(segment);
    for (let k = 1; k < w; k++) {
      writeCell(buf, cx + k, y, {
        ch: pad ? " " : PLACEHOLDER_CH,
        style,
        placeholder: !pad,
      });
    }
    cx += w;
  }
}

// ── Damage ──────────────────────────────────────────────────────────────────

function rgbEq(a: Rgb | undefined, b: Rgb | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

function cellEq(a: Cell, b: Cell): boolean {
  return (
    a.ch === b.ch &&
    !!a.placeholder === !!b.placeholder &&
    a.style.bold === b.style.bold &&
    a.style.dim === b.style.dim &&
    a.style.strike === b.style.strike &&
    a.style.italic === b.style.italic &&
    a.style.underline === b.style.underline &&
    a.style.href === b.style.href &&
    a.style.fg === b.style.fg &&
    a.style.bg === b.style.bg &&
    a.style.bgFx === b.style.bgFx &&
    a.style.bgFxU === b.style.bgFxU &&
    a.style.bgFxV === b.style.bgFxV &&
    // C3: dual-dirty resolver fields — a role/prominence shift between frames
    // must mark the row dirty, or emitAnsi skips it (silent stale frame).
    a.style.role === b.style.role &&
    a.style.prominence === b.style.prominence &&
    a.style.bgRole === b.style.bgRole &&
    a.style.bgProminence === b.style.bgProminence &&
    a.style.surfaceRole === b.style.surfaceRole &&
    a.style.surfaceProminence === b.style.surfaceProminence &&
    a.style.fuseRole === b.style.fuseRole &&
    a.style.fuseProminence === b.style.fuseProminence &&
    a.style.tintRole === b.style.tintRole &&
    a.style.tint === b.style.tint &&
    a.style.regionProminence === b.style.regionProminence &&
    a.style.bgFxOpacity === b.style.bgFxOpacity &&
    a.style.cast === b.style.cast &&
    rgbEq(a.style.fgRgb, b.style.fgRgb) &&
    rgbEq(a.style.bgRgb, b.style.bgRgb) &&
    // Selection toggle must dirty the row so the recolor re-resolves.
    a.style.selected === b.style.selected
  );
}

function rowEq(prev: Buffer, next: Buffer, y: number): boolean {
  const w = next.width;
  const base = y * w;
  for (let x = 0; x < w; x++) {
    if (!cellEq(prev.cells[base + x]!, next.cells[base + x]!)) return false;
  }
  return true;
}

/** Rows that differ (or all rows if size changed / no prev). */
export function dirtyRows(prev: Buffer | null, next: Buffer): number[] {
  if (!prev || prev.width !== next.width || prev.height !== next.height) {
    return Array.from({ length: next.height }, (_, i) => i);
  }
  const out: number[] = [];
  for (let y = 0; y < next.height; y++) {
    if (!rowEq(prev, next, y)) out.push(y);
  }
  return out;
}

// ── ANSI emit ───────────────────────────────────────────────────────────────

/** Clamp an ANSI 256 color index; non-finite/out-of-range → undefined (omit). */
function clampIndex(n: number): number | undefined {
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function osc8Href(href: string | undefined): string {
  if (href === undefined || href === "") return "";
  if (!/^https?:\/\//i.test(href)) return "";
  if (/[\u0000-\u001F\u007F]/.test(href)) return "";
  return href;
}

function sgr(style: Style): string {
  const parts: string[] = ["0"];
  if (style.bold) parts.push("1");
  if (style.dim) parts.push("2");
  if (style.italic) parts.push("3");
  if (style.underline) parts.push("4");
  if (style.strike) parts.push("9");
  if (style.fgRgb) {
    // H2: clamp each channel — NaN/Infinity/out-of-range must not corrupt SGR.
    const { r, g, b } = style.fgRgb;
    parts.push(`38;2;${clampByte(r)};${clampByte(g)};${clampByte(b)}`);
  } else if (style.fg !== undefined) {
    const c = clampIndex(style.fg);
    if (c !== undefined) parts.push(`38;5;${c}`);
  }
  if (style.bgRgb) {
    const { r, g, b } = style.bgRgb;
    parts.push(`48;2;${clampByte(r)};${clampByte(g)};${clampByte(b)}`);
  } else if (style.bg !== undefined) {
    const c = clampIndex(style.bg);
    if (c !== undefined) parts.push(`48;5;${c}`);
  }
  return `\u001B[${parts.join(";")}m`;
}

export type EmitAnsiOpts = {
  sync2026?: boolean;
  forceFull?: boolean;
};

export type EmitAnsiStats = {
  ansi: string;
  dirtyRows: number;
  bytes: number;
};

/**
 * Emit ANSI for dirty rows with wire metrics.
 * Absolute CUP, clear line, write row.
 * **Skips placeholder cells** so wide glyphs advance 2 columns, not 3.
 * Optional Mode 2026 wrap.
 */
export function emitAnsiDetailed(prev: Buffer | null, next: Buffer, opts: EmitAnsiOpts = {}): EmitAnsiStats {
  const rows = opts.forceFull ? Array.from({ length: next.height }, (_, i) => i) : dirtyRows(prev, next);

  if (rows.length === 0) {
    return { ansi: "", dirtyRows: 0, bytes: 0 };
  }

  const chunks: string[] = [];
  if (opts.sync2026) chunks.push("\u001B[?2026h");
  if (opts.forceFull || !prev) chunks.push("\u001B[2J");

  for (const y of rows) {
    chunks.push(`\u001B[${y + 1};1H\u001B[0m\u001B[2K`);
    let runStyle = "";
    let runHref = "";
    let run = "";
    const flush = () => {
      if (!run) return;
      if (runHref !== "") chunks.push(`\u001B]8;;${runHref}\u001B\\`);
      chunks.push(`${runStyle + run}\u001B[0m`);
      if (runHref !== "") chunks.push("\u001B]8;;\u001B\\");
      run = "";
    };
    for (let x = 0; x < next.width; x++) {
      const cell = next.cells[y * next.width + x]!;
      if (cell.placeholder) continue;
      const st = sgr(cell.style);
      const href = osc8Href(cell.style.href);
      if (st !== runStyle || href !== runHref) {
        flush();
        runStyle = st;
        runHref = href;
      }
      run += cell.ch;
    }
    flush();
  }

  if (opts.sync2026) chunks.push("\u001B[?2026l");
  const ansi = chunks.join("");
  return { ansi, dirtyRows: rows.length, bytes: ansi.length };
}

/**
 * Emit ANSI for dirty rows. Absolute CUP, clear line, write row.
 * **Skips placeholder cells** so wide glyphs advance 2 columns, not 3.
 * Optional Mode 2026 wrap.
 */
export function emitAnsi(prev: Buffer | null, next: Buffer, opts: EmitAnsiOpts = {}): string {
  return emitAnsiDetailed(prev, next, opts).ansi;
}

/** Shallow copy of buffer cells (for storing previous frame). */
export function cloneBuffer(buf: Buffer): Buffer {
  return {
    width: buf.width,
    height: buf.height,
    cells: buf.cells.map((c) => ({
      ch: c.ch,
      style: { ...c.style },
      placeholder: c.placeholder,
    })),
  };
}

export { fillBgFx } from "./bgfx-mark.js";
