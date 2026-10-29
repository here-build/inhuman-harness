/**
 * ChromeFrame — special layout strategy for boxed prompt chrome.
 *
 * Same pattern as Indication: **one lineage** for measure, place, paint, HTML.
 * Not flex assembly. Outer width is fixed; edges always span it; body sides
 * track bodyH. Multi-role edge segments (progress rail, hint rule) are first-class.
 *
 * Geometry law:
 *   outerW  = explicit width (clamped to alloc)
 *   textW   = outerW - 4   // │ + mark + gap + │
 *   bodyH   = wrap(draft, textW, pre-wrap).length  (≥1)
 *   totalH  = bodyH + 2    // top + bottom edges
 *   body cells: │ · text… │  (mark cell: space, picker `›`, or a counter)
 *   The line above the draft is one chrome rule (shortcuts left / annotation
 *   right). The hint is flex:0 — keys, colons, actions, and ` · ` take
 *   their intrinsic width. Only the annotation (filename) shrinks. If the
 *   hint itself overflows the band, trailing bindings drop as whole units.
 *   Solo frame fuses that into ╭╮. A stacked frame (joinBottom) splits:
 *   annotation stays on ╭╮; shortcuts ride the ├┤ T-join, with optional
 *   joinAnnotation on that same rule's right (session title / above-input).
 *   No annotation → stacked ╭╮ stays plain (slash catalog).
 *   Occupied right-rail slots (annotation, status) sit a space plus one
 *   contour cell off the corner — occupied rims end ` ─╮` / ` ─╯`.
 *   body hit  = **text column only** (not side bars / mark).
 *     Selection/copy/contain use this rect — borders are chrome, not content.
 *     Caret park reads y/h from the same hit; col is content-relative.
 */

import {
  formatContextOccupancy,
  formatHeldStatus,
  formatHeldStatusFit,
  quotaLive,
  type ChromeQuotaWindow,
  type LivePaint,
} from "./live_paint.js";
import { markdownInlineSegs } from "./markdown.js";
import { paintHotkeyChord, revealHotkeys, type ChromeHotkey } from "./paint-hotkey.js";
import { wrapText } from "./text.js";
import type { ChromeStatusItem, LayoutNode, PaintOp, Rect } from "./types.js";
import type { Style } from "../buffer/index.js";
import { FgP, fgProgress, type FgProminence } from "../lexicon/index.js";
import { defaultMeasure } from "../measure/index.js";

export const CHROME_FRAME_CHROME_ROWS = 2 as const;
/** Mark cell default — empty. Picker selection paints `›` via bodyGlyphs. */
export const CHROME_FRAME_DEFAULT_GLYPH = " ";
/** │ + mark + gap + │ — subtracted from outerW to get the draft column. */
export const CHROME_FRAME_BODY_CHROME = 4 as const;
/** Default fill hue — contour, not muted. Chroma is warning tint only. */
export const CHROME_FRAME_DEFAULT_PROGRESS_ROLE = "foreground";
/** Remaining fraction where the fill starts mixing into warning. */
export const CHROME_FRAME_DEFAULT_PROGRESS_GLOW_AT = 0.75;
/** Hot hue mixed in as remaining drops below {@link CHROME_FRAME_DEFAULT_PROGRESS_GLOW_AT}. */
export const CHROME_FRAME_PROGRESS_GLOW_ROLE = "warning";
/** Space + contour cell between a right-rail slot (annotation / status) and ╮/╯. */
const RIGHT_SLOT_PAD = " ─";

/**
 * Rounded box-drawing corners (Grok Build / Claude Code prompt chrome).
 * Unicode light arcs — not square `┌┐└┘`.
 *   ╭ ╮   U+256D / U+256E
 *   ╰ ╯   U+2570 / U+256F
 * (Confirmed in grok binary prompt glyph table: `┌┐└┘╭╮╰╯`.)
 */
export const CHROME_FRAME_CORNERS = {
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
} as const;

/** T-junction corners when stacking chrome frames (spotlight above input). */
export const CHROME_FRAME_JOIN = {
  left: "├",
  right: "┤",
} as const;

export type ChromeFrameNode = Extract<LayoutNode, { type: "chrome_frame" }>;

export type ChromeFrameGeom = {
  outerW: number;
  textW: number;
  bodyLines: string[];
  bodyH: number;
  totalH: number;
  glyph: string;
};

export type ChromeSeg = {
  text: string;
  style: Style;
  live?: LivePaint;
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function measure(text: string): number {
  return defaultMeasure(text);
}

/** Draft content width inside `│ · text │` (mark + gap + sides). */
export function chromeFrameTextWidth(outerW: number): number {
  return Math.max(1, outerW - CHROME_FRAME_BODY_CHROME);
}

/** Columns from body left edge to the first text cell: `│ · ` → 3. */
export function chromeFrameTextInset(): number {
  return CHROME_FRAME_BODY_CHROME - 1;
}

/** Text column width inside `│ · text │`. */
export function chromeFrameContentWidth(outerW: number): number {
  return chromeFrameTextWidth(outerW);
}

export function chromeFrameBodyLines(draft: string, outerW: number, placeholder?: string): string[] {
  const w = chromeFrameTextWidth(outerW);
  if (draft.length === 0) {
    const ph = (placeholder ?? "").trimEnd();
    if (ph.length > 0) {
      const lines = wrapText(ph, {
        width: w,
        whiteSpace: "pre-wrap",
        measure: defaultMeasure,
      });
      return lines.length > 0 ? lines : [" "];
    }
    return [" "];
  }
  const lines = wrapText(draft, {
    width: w,
    whiteSpace: "pre-wrap",
    measure: defaultMeasure,
  });
  return lines.length > 0 ? lines : [" "];
}

/**
 * True when the frame is showing empty-state placeholder chrome — body text
 * is not real draft content and must not participate in text selection/copy
 * (browser `<input placeholder>` model).
 */
export function isChromeFrameShowingPlaceholder(node: ChromeFrameNode): boolean {
  if (node.placeholderMode === true) return true;
  const draft = node.speculativeDraft ?? node.draft ?? "";
  if (draft.length > 0) return false;
  return !!(node.placeholder && node.placeholder.length > 0);
}

/**
 * Total painted height = body + top chrome (unless omitted) + bottom chrome.
 */
export function chromeFrameTotalHeight(bodyH: number, opts?: { omitTop?: boolean }): number {
  const chrome = opts?.omitTop ? 1 : CHROME_FRAME_CHROME_ROWS;
  return Math.max(1, bodyH) + chrome;
}

/** True when shortcuts or annotation should ride the line above the draft. */
export function chromeFrameHasHint(node: ChromeFrameNode): boolean {
  if ((node.hotkeys?.length ?? 0) > 0) return true;
  if ((node.annotation ?? "").trim().length > 0) return true;
  return (node.joinAnnotation ?? "").trim().length > 0;
}

/**
 * Progress fill geometry (bottom rail). Active run is **right-aligned**
 * against the status chips; `rest` is the left contour. One role —
 * paint ramps prominence and de-chromes into the contour.
 */
export type ProgressFillSegments = {
  /** Integer cells of the active fill (right side). */
  full: number;
  /** 0..1 fill of the leading (left) boundary cell of the run. */
  frac: number;
  /** Left contour remainder. */
  rest: number;
  total: number;
};

/**
 * Partition a bar budget into one fill + remainder. Partial cell is
 * continuous in [0,1) so present can ease without snapping.
 */
export function progressFillSegments(budget: number, ratio: number): ProgressFillSegments {
  const total = Math.max(0, Math.floor(budget));
  if (total <= 0) {
    return { full: 0, frac: 0, rest: 0, total: 0 };
  }
  const usedExact = clamp01(ratio) * total;
  let full = Math.floor(usedExact + 1e-9);
  let frac = usedExact - full;
  if (frac < 1e-6) {
    frac = 0;
  } else if (frac > 1 - 1e-6) {
    full = Math.min(total, full + 1);
    frac = 0;
  }
  full = Math.min(total, full);
  const used = full + (frac > 0 ? 1 : 0);
  return { full, frac, rest: Math.max(0, total - used), total };
}

/**
 * Ramp along the active run: t=0 is fully fused into the contour (p=0),
 * t=1 is primary against the status chips. Prominence, not lightness —
 * on light ground the loud end is darker. Hue stays contour until
 * warning tint starts; no extra chroma on the fill role itself.
 */
export function progressRampProminence(t: number): number {
  return FgP.primary * clamp01(t);
}

/**
 * Warning chroma for remaining-fill. 0 at/above `glowAt` remaining,
 * 1 at empty runway. `glowAt` is the remaining fraction where orange starts.
 */
export function progressGlowTint(progress: number, glowAt: number): number {
  const at = clamp01(glowAt);
  if (!(at > 0)) return 0;
  const remaining = clamp01(progress);
  if (remaining >= at) return 0;
  return (at - remaining) / at;
}

/** Build a Style from role + branded FG prominence (render boundary). */
function fgStyle(role: string, p: FgProminence, opts: { dim?: boolean; bold?: boolean } = {}): Style {
  return {
    role,
    prominence: p,
    dim: opts.dim,
    bold: opts.bold,
  };
}

export function measureChromeFrame(node: ChromeFrameNode, maxW: number, maxH: number): ChromeFrameGeom {
  const outerW = Math.max(8, Math.min(maxW, Math.floor(node.width) || maxW));
  const glyph = node.glyph && node.glyph.length > 0 ? node.glyph.slice(0, 2) : CHROME_FRAME_DEFAULT_GLYPH;
  const source = chromeFramePaintSource(node);
  const bodyLines =
    node.bodySegRows && node.bodySegRows.length > 0
      ? node.bodySegRows.map(() => " ")
      : isChromeFrameShowingPlaceholder(node)
        ? chromeFrameBodyLines("", outerW, node.placeholder)
        : chromeFramePaintBodyLines(source.draft, source.completion, outerW).map((line) => line.text);
  const bodyH = Math.max(1, bodyLines.length);
  const totalH = Math.min(maxH, chromeFrameTotalHeight(bodyH, { omitTop: node.omitTop === true }));
  // if height clamped, still report true body lines for paint clip
  return {
    outerW,
    textW: chromeFrameTextWidth(outerW),
    bodyLines,
    bodyH,
    totalH: Math.max(1, totalH),
    glyph,
  };
}

function padDash(n: number): string {
  return n > 0 ? "─".repeat(n) : "";
}

/**
 * Frame contour (top rule, sides, corners, unfilled rail, unstyled status).
 * Furniture weight is ghost unless the frame is the selection (primary).
 * Hue follows {@link boxContour}. Progress fill uses its own role and
 * fuses into this contour (gradient hint).
 */
function boxContour(role?: string, prominence: FgProminence = FgP.ghost): Style {
  return fgStyle(role && role.length > 0 ? role : "foreground", prominence);
}

function contourProminenceOf(node: ChromeFrameNode): FgProminence {
  return node.selected === true ? FgP.primary : FgP.ghost;
}
const contour: Style = boxContour();
/** Hotkey chord — primary, no chroma. */
const shortcutKey: Style = fgStyle("foreground", FgP.primary);
/** Hotkey action — same voice as annotation / status, not the contour. */
const shortcutAction: Style = fgStyle("foreground", FgP.ghost);
/** Draft body — primary, roman. */
const bodyStyle: Style = fgStyle("foreground", FgP.primary);
/** Empty-state placeholder — muted, never selected. */
const placeholderStyle: Style = fgStyle("muted", FgP.ghost);
/** Autocomplete remainder — same voice as placeholder; not draft. */
const completionStyle: Style = placeholderStyle;

/**
 * Draft plus optional dim remainder. Completion is paint-only: it hangs off
 * the last draft line and MUST NOT reflow typed text (caret/click wrap draft
 * alone). Wrapping `draft+completion` as one string breaks inside a
 * multi-word prefix (`/connect LM` + ` Studio` at width 11 → `/connect` /
 * `LM Studio`).
 */
function chromeFramePaintSource(node: ChromeFrameNode): {
  draft: string;
  completion: string;
  draftLength: number;
} {
  const draft = node.speculativeDraft ?? node.draft ?? "";
  const completion = draft.length === 0 ? "" : (node.completion ?? "").length > 0 ? node.completion! : "";
  return { draft, completion, draftLength: draft.length };
}

/** Visual body lines of draft, then remainder overflow that does not split them. */
function chromeFramePaintBodyLines(
  draft: string,
  completion: string,
  outerW: number,
): Array<{ text: string; start: number }> {
  const draftLines = chromeFrameBodyLinesWithStarts(draft, outerW);
  if (completion.length === 0) return draftLines;
  const textW = chromeFrameTextWidth(outerW);
  const last = draftLines.at(-1)!;
  const wrapped = wrapText(last.text + completion, {
    width: textW,
    whiteSpace: "pre-wrap",
    measure: defaultMeasure,
  });
  const head = wrapped[0] ?? "";
  if (head.startsWith(last.text)) {
    const out = draftLines.slice(0, -1);
    let pos = last.start;
    for (const line of wrapped) {
      out.push({ text: line, start: pos });
      pos += line.length;
    }
    return out.length > 0 ? out : draftLines;
  }
  // Combined wrap would split the last draft line. Keep it; overflow remainder.
  let overflow = completion;
  let skip = 0;
  if (overflow.startsWith(" ")) {
    overflow = overflow.slice(1);
    skip = 1;
  }
  if (overflow.length === 0) return draftLines;
  const extra = wrapText(overflow, {
    width: textW,
    whiteSpace: "pre-wrap",
    measure: defaultMeasure,
  });
  const out = [...draftLines];
  let pos = last.start + last.text.length + skip;
  for (const line of extra) {
    if (line.length === 0) continue;
    out.push({ text: line, start: pos });
    pos += line.length;
  }
  return out;
}

/** Picker mark (`›`) — primary. Draft mark is a space (no chevron). */
const glyphStyle: Style = fgStyle("foreground", FgP.primary, { bold: true });
/** Counters and other technical marks in the same cell — furniture. */
const counterStyle: Style = fgStyle("muted", FgP.ghost);

function markCellStyle(mark: string): Style {
  return mark === "›" ? glyphStyle : counterStyle;
}

function ellipsizeTo(text: string, maxW: number): string {
  if (maxW <= 0) return "";
  if (measure(text) <= maxW) return text;
  if (maxW === 1) return "…";
  let h = text;
  while (measure(`${h}…`) > maxW && h.length > 0) h = h.slice(0, -1);
  return h.length > 0 ? `${h}…` : "…";
}

/**
 * Furniture clip: 3-cell prefix + … + tail.
 * Fault annotations keep {@link ellipsizeTo} (prefix + …).
 */
function ellipsizeAffixTo(text: string, maxW: number): string {
  if (maxW <= 0) return "";
  if (measure(text) <= maxW) return text;
  if (maxW === 1) return "…";
  let prefix = text;
  while (measure(prefix) > 3 && prefix.length > 0) prefix = prefix.slice(0, -1);
  if (prefix.length === 0) {
    let t = text;
    while (measure(`…${t}`) > maxW && t.length > 0) t = t.slice(1);
    return t.length > 0 ? `…${t}` : "…";
  }
  const head = `${prefix}…`;
  const headW = measure(head);
  if (headW > maxW) {
    let h = prefix;
    while (measure(`${h}…`) > maxW && h.length > 0) h = h.slice(0, -1);
    return h.length > 0 ? `${h}…` : "…";
  }
  if (headW === maxW) return head;
  const tailBudget = maxW - headW;
  let tail = text;
  while (measure(tail) > tailBudget && tail.length > 0) tail = tail.slice(1);
  const tailAt = text.length - tail.length;
  if (tailAt < prefix.length) {
    tail = text.slice(prefix.length);
    while (measure(tail) > tailBudget && tail.length > 0) tail = tail.slice(1);
  }
  return tail.length > 0 ? `${head}${tail}` : head;
}

function segsWidth(segs: readonly ChromeSeg[]): number {
  let n = 0;
  for (const s of segs) n += measure(s.text);
  return n;
}

/**
 * Key / action runs for one binding list. Both are foreground (no chroma).
 * Chord is primary; the label matches the annotation/status slot.
 *
 * The whole hint is flex:0. Action names do not clip.
 */
type HintPiece = ChromeSeg & { hint: "key" | "colon" | "action" | "sep" };

function hintPieces(hotkeys: readonly ChromeHotkey[]): HintPiece[] {
  const out: HintPiece[] = [];
  for (const hotkey of hotkeys) {
    const key = hotkey.key.trim();
    if (key.length === 0) continue;
    if (out.length > 0) out.push({ text: " · ", style: contour, hint: "sep" });
    const action = hotkey.action.trim();
    out.push({ text: paintHotkeyChord(key), style: shortcutKey, hint: "key" });
    if (action.length === 0) continue;
    out.push(
      { text: ": ", style: shortcutKey, hint: "colon" },
      { text: action, style: shortcutAction, hint: "action" },
    );
  }
  return out;
}

function emitHintPieces(pieces: readonly HintPiece[]): ChromeSeg[] {
  return pieces.map(({ text, style }) => ({ text, style }));
}

/** Drop trailing ` · key: action` units until the hint fits. Never clip a binding. */
function dropTrailingHintBindings(pieces: HintPiece[], maxW: number): HintPiece[] {
  let next = [...pieces];
  while (next.length > 0 && segsWidth(next) > maxW) {
    let cut = -1;
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i]!.hint === "sep") {
        cut = i;
        break;
      }
    }
    if (cut < 0) {
      next = [];
      break;
    }
    next = next.slice(0, cut);
  }
  return next;
}

function fitHintAndAnnotation(
  hotkeys: readonly ChromeHotkey[],
  right: ChromeSeg[],
  budget: number,
  annKeep: "start" | "affix",
): { left: ChromeSeg[]; right: ChromeSeg[] } {
  const pieces = hotkeys.length > 0 ? hintPieces(hotkeys) : [];
  const rightWant = segsWidth(right);
  if (pieces.length === 0) {
    return {
      left: [],
      right: rightWant <= budget ? right : trimSegsTo(right, budget, { keep: annKeep }),
    };
  }
  const left = emitHintPieces(dropTrailingHintBindings(pieces, budget));
  const annW = Math.max(0, budget - segsWidth(left));
  const rightFit = rightWant <= annW ? right : trimSegsTo(right, annW, { keep: annKeep });
  return { left, right: rightFit };
}

function trimSegsTo(segs: ChromeSeg[], maxW: number, opts?: { keep?: "start" | "affix" }): ChromeSeg[] {
  if (maxW <= 0) return [];
  const clip = opts?.keep === "affix" ? ellipsizeAffixTo : ellipsizeTo;
  const out: ChromeSeg[] = [];
  let used = 0;
  for (const s of segs) {
    const tw = measure(s.text);
    if (used + tw <= maxW) {
      out.push(s);
      used += tw;
      continue;
    }
    const room = maxW - used;
    if (room <= 0) break;
    const clipped = clip(s.text, room);
    if (clipped.length > 0) out.push({ ...s, text: clipped });
    break;
  }
  return out;
}

/**
 * One full-width chrome rule: shortcuts left, annotation right, dashes between.
 * Solo frame uses ╭╮. Stacked: call twice — annotation on ╭╮, shortcuts on ├┤.
 */
export function chromeFrameTopSegs(
  outerW: number,
  hotkeys: readonly ChromeHotkey[] | null | undefined,
  opts?: {
    join?: boolean;
    /** ╰╯ instead of ╭╮. Ignored when {@link join}. */
    bottom?: boolean;
    annotation?: string | null;
    annotationRole?: string;
    annotationSegs?: ChromeSeg[];
    contourRole?: string;
    contourProminence?: FgProminence;
    modHeld?: boolean;
  },
): ChromeSeg[] {
  const w = Math.max(4, outerW);
  const box = boxContour(opts?.contourRole, opts?.contourProminence);
  const hint = revealHotkeys(hotkeys ?? [], { modHeld: opts?.modHeld === true });
  const hasHint = hint.length > 0;
  const L = opts?.join
    ? CHROME_FRAME_JOIN.left
    : opts?.bottom === true
      ? CHROME_FRAME_CORNERS.bl
      : CHROME_FRAME_CORNERS.tl;
  const R = opts?.join
    ? CHROME_FRAME_JOIN.right
    : opts?.bottom === true
      ? CHROME_FRAME_CORNERS.br
      : CHROME_FRAME_CORNERS.tr;

  const fault = opts?.annotationRole === "error" || opts?.annotationRole === "warning";
  const annStyle: Style = fgStyle(
    fault
      ? (opts!.annotationRole as string)
      : opts?.annotationRole && opts.annotationRole.length > 0
        ? opts.annotationRole
        : "foreground",
    fault ? FgP.primary : FgP.ghost,
  );
  let right: ChromeSeg[] = opts?.annotationSegs ? opts.annotationSegs.filter((s) => s.text.length > 0) : [];
  if (right.length === 0) {
    const ann = (opts?.annotation ?? "").trim();
    if (ann.length > 0) {
      right = markdownInlineSegs(ann, annStyle).map((s) => ({
        text: s.text,
        // Furniture emphasis is the bright run (same voice as a hotkey chord).
        // Fault annotations stay their role — do not restyle ** as primary.
        style: !fault && s.style.bold === true ? { ...s.style, bold: false, prominence: FgP.primary } : s.style,
      }));
    }
  }

  const segs: ChromeSeg[] = [{ text: L, style: box }];
  if (!hasHint && right.length === 0) {
    segs.push({ text: padDash(w - 2), style: box }, { text: R, style: box });
    return segs;
  }

  const leftPrefix = hasHint ? "─ " : "";
  // Space after the dash fill; space + contour dash before the corner when occupied.
  const rightPrefix = right.length > 0 ? " " : "";
  const rightSuffix = right.length > 0 ? RIGHT_SLOT_PAD : "";
  const trail = hasHint ? 1 : 0;
  const minFill = hasHint && right.length > 0 ? 1 : 0;
  const chrome = 2 + measure(leftPrefix) + trail + measure(rightPrefix) + measure(rightSuffix) + minFill;
  const budget = Math.max(0, w - chrome);

  const fitted = fitHintAndAnnotation(hint, right, budget, fault ? "start" : "affix");
  const leftSegs = fitted.left;
  const rightFit = fitted.right;

  if (leftPrefix) segs.push({ text: leftPrefix, style: box });
  for (const s of leftSegs) segs.push(s);
  if (hasHint) segs.push({ text: " ", style: box });

  const used =
    2 +
    measure(leftPrefix) +
    segsWidth(leftSegs) +
    (hasHint ? 1 : 0) +
    measure(rightPrefix) +
    segsWidth(rightFit) +
    measure(rightSuffix);
  const fill = Math.max(0, w - used);
  if (fill > 0) segs.push({ text: padDash(fill), style: box });
  if (rightPrefix) segs.push({ text: rightPrefix, style: box });
  for (const s of rightFit) segs.push(s);
  if (rightSuffix) segs.push({ text: rightSuffix, style: box });
  segs.push({ text: R, style: box });
  return segs;
}

/** Plain bottom rule (no context bar) — optional T-join corners. */
export function chromeFramePlainBottomSegs(
  outerW: number,
  opts?: { join?: boolean; contourRole?: string; contourProminence?: FgProminence },
): ChromeSeg[] {
  const w = Math.max(4, outerW);
  const box = boxContour(opts?.contourRole, opts?.contourProminence);
  const L = opts?.join ? CHROME_FRAME_JOIN.left : CHROME_FRAME_CORNERS.bl;
  const R = opts?.join ? CHROME_FRAME_JOIN.right : CHROME_FRAME_CORNERS.br;
  return [
    { text: L, style: box },
    { text: padDash(w - 2), style: box },
    { text: R, style: box },
  ];
}

/**
 * Top edge from multi-style content segs (between corners).
 * Pads with contour dashes so corners stay at outerW.
 */
export function chromeFrameTopFromContentSegs(
  outerW: number,
  content: ChromeSeg[],
  opts?: { contourRole?: string; contourProminence?: FgProminence },
): ChromeSeg[] {
  const w = Math.max(4, outerW);
  const box = boxContour(opts?.contourRole, opts?.contourProminence);
  const segs: ChromeSeg[] = [{ text: CHROME_FRAME_CORNERS.tl, style: box }];
  let used = 2; // corners
  for (const s of content) {
    const tw = measure(s.text);
    if (used + tw > w) break;
    segs.push(s);
    used += tw;
  }
  const fill = Math.max(0, w - used);
  if (fill > 0) segs.push({ text: padDash(fill), style: box });
  segs.push({ text: CHROME_FRAME_CORNERS.tr, style: box });
  return segs;
}

function styleFromSpec(s: {
  role?: string;
  prominence?: number;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  href?: string;
  fgRgb?: { r: number; g: number; b: number };
}): Style {
  return {
    role: s.role,
    prominence: s.prominence,
    bold: s.bold,
    dim: s.dim,
    italic: s.italic,
    underline: s.underline,
    href: s.href,
    fgRgb: s.fgRgb,
  };
}

function statusChipText(item: ChromeStatusItem): string {
  return (typeof item === "string" ? item : item.text).trim();
}

function statusChipStyle(item: ChromeStatusItem, box: Style): Style {
  if (typeof item === "string") return contour;
  if (item.role && item.role.length > 0) {
    return { role: item.role, prominence: item.prominence ?? FgP.secondary };
  }
  return box;
}

function normalizeStatusItems(items: readonly ChromeStatusItem[] | undefined): ChromeStatusItem[] {
  return (items ?? []).filter((item) => statusChipText(item).length > 0);
}

type StatusRailOpts = {
  statusItems?: readonly ChromeStatusItem[];
  quotaWindows?: readonly ChromeQuotaWindow[];
  contextUsed?: number;
  contextLimit?: number;
  modHeld?: boolean;
  nowMs?: number;
};

/** Persist-mod replaces furniture chips with occupancy + quota; signal chips stay. */
function statusRailOf(
  opts: StatusRailOpts,
  maxColumns?: number,
): {
  items: ChromeStatusItem[];
  live?: LivePaint;
} {
  const base = normalizeStatusItems(opts.statusItems);
  if (opts.modHeld !== true) return { items: base };
  const windows = (opts.quotaWindows ?? []).filter((window) => Number.isFinite(window.remainingPercent));
  const prefix = formatContextOccupancy(opts.contextUsed ?? 0, opts.contextLimit ?? 0);
  const nowMs = opts.nowMs ?? Date.now();
  const full = formatHeldStatus(prefix, windows, nowMs);
  const text = maxColumns === undefined ? full : formatHeldStatusFit(prefix, windows, nowMs, maxColumns, measure);
  if (text === "") return { items: base };
  const signals = base.filter((item) => typeof item !== "string");
  const occupancyOnly = text !== full;
  return {
    items: [text, ...signals],
    // Live ticks rebuild the full hint and would paint over a fitted chip.
    live: windows.length > 0 && !occupancyOnly ? quotaLive(windows, { prefix }) : undefined,
  };
}

/** Joined status for measure / hit geometry. Leading space matches paint. */
export function statusRightText(opts: StatusRailOpts): string {
  const items = statusRailOf(opts).items.map(statusChipText);
  if (items.length > 0) return ` ${items.join(" · ")}`;
  return "";
}

/** Right-rail chips. Drops leftmost furniture first so a signal chip survives clip. */
function statusRightSegs(opts: StatusRailOpts, box: Style, maxW: number): ChromeSeg[] {
  if (maxW <= 0) return [];
  // Leading space is part of the painted rail, so the chip text has one less column.
  const rail = statusRailOf(opts, Math.max(0, maxW - 1));
  let chips = rail.items;
  if (chips.length === 0) return [];
  const build = (list: ChromeStatusItem[]): ChromeSeg[] => {
    const segs: ChromeSeg[] = [{ text: " ", style: box }];
    for (const [i, element] of list.entries()) {
      if (i > 0) segs.push({ text: " · ", style: box });
      const chip = element!;
      const seg: ChromeSeg = {
        text: statusChipText(chip),
        style: statusChipStyle(chip, box),
      };
      if (rail.live !== undefined && typeof chip === "string" && i === 0) seg.live = rail.live;
      segs.push(seg);
    }
    return segs;
  };
  let segs = build(chips);
  while (segsWidth(segs) > maxW && chips.length > 1) {
    chips = chips.slice(1);
    segs = build(chips);
  }
  if (segsWidth(segs) > maxW) {
    const clipped = ellipsizeTo(statusRightText({ statusItems: chips }), maxW);
    return clipped.length > 0 ? [{ text: clipped, style: box }] : [];
  }
  return segs;
}

/** One ─ per fill cell, prominence ramping toward the status edge. */
function progressRampSegs(fill: ProgressFillSegments, role: string, fuseRole = "foreground", glow = 0): ChromeSeg[] {
  const n = fill.full + (fill.frac > 0 ? 1 : 0);
  if (n <= 0) return [];
  const out: ChromeSeg[] = [];
  const tint = Math.max(glow, 0);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);
    const tt = i === 0 && fill.frac > 0 ? t * fill.frac : t;
    out.push({
      text: "─",
      style: {
        role,
        prominence: progressRampProminence(tt),
        fuseRole,
        fuseProminence: FgP.ghost,
        ...(tint > 0 ? { tintRole: CHROME_FRAME_PROGRESS_GLOW_ROLE, tint } : {}),
      },
    });
  }
  return out;
}

/** Bottom edge: optional one-hue progress ramp + status, spanning `outerW`. */
export function chromeFrameBottomSegs(
  outerW: number,
  opts: {
    progress?: number;
    progressRole?: string;
    /** Remaining fraction where warning chroma starts. Default 0.75. */
    progressGlowAt?: number;
    statusItems?: readonly ChromeStatusItem[];
    quotaWindows?: readonly ChromeQuotaWindow[];
    contextUsed?: number;
    contextLimit?: number;
    modHeld?: boolean;
    nowMs?: number;
    /** T-join corners when stacked under another frame. */
    join?: boolean;
    /** Skip progress rail — plain rule only. */
    plain?: boolean;
    /** Hue of ╰╯ and the unfilled rail. Default foreground. */
    contourRole?: string;
    contourProminence?: FgProminence;
  },
): ChromeSeg[] {
  const w = Math.max(4, outerW);
  const box = boxContour(opts.contourRole, opts.contourProminence);
  if (opts.plain) {
    return chromeFramePlainBottomSegs(w, {
      join: opts.join,
      contourRole: opts.contourRole,
      contourProminence: opts.contourProminence,
    });
  }
  const boxed = opts.contourRole != null && opts.contourRole.length > 0;
  const raw = opts.progress;
  // Omit progress → dashes. `progress ?? 0` invents a fill on a plain rule.
  const hasProgress = !boxed && typeof raw === "number" && Number.isFinite(raw);
  const bl = opts.join ? CHROME_FRAME_JOIN.left : CHROME_FRAME_CORNERS.bl;
  const br = opts.join ? CHROME_FRAME_JOIN.right : CHROME_FRAME_CORNERS.br;

  const minRail = hasProgress ? 6 : 0;
  const reserve = measure(RIGHT_SLOT_PAD);
  const rightSegs = statusRightSegs(opts, box, Math.max(0, w - 2 - minRail - reserve));
  const rightW = segsWidth(rightSegs);
  const trailPad = rightW > 0 ? measure(RIGHT_SLOT_PAD) : 0;

  const segs: ChromeSeg[] = [{ text: bl, style: box }];

  if (!hasProgress) {
    const mid = Math.max(0, w - 2 - rightW - trailPad);
    if (mid > 0) segs.push({ text: padDash(mid), style: box });
    for (const s of rightSegs) segs.push(s);
    if (trailPad > 0) segs.push({ text: RIGHT_SLOT_PAD, style: box });
    segs.push({ text: br, style: box });
    return segs;
  }

  const ratio = clamp01(raw);
  const role =
    opts.progressRole && opts.progressRole.length > 0 ? opts.progressRole : CHROME_FRAME_DEFAULT_PROGRESS_ROLE;
  const fillBudget = Math.max(0, w - 2 - rightW - trailPad);
  const fill = progressFillSegments(fillBudget, ratio);
  const fuseRole = opts.contourRole && opts.contourRole.length > 0 ? opts.contourRole : "foreground";
  const glowAt =
    typeof opts.progressGlowAt === "number" && Number.isFinite(opts.progressGlowAt)
      ? opts.progressGlowAt
      : CHROME_FRAME_DEFAULT_PROGRESS_GLOW_AT;
  const ramp = progressRampSegs(fill, role, fuseRole, progressGlowTint(ratio, glowAt));
  if (fill.rest > 0) segs.push({ text: padDash(fill.rest), style: box });
  const painted = fill.full + (fill.frac > 0 ? 1 : 0) + fill.rest + rightW + trailPad + 2;
  if (painted < w) {
    segs.push({ text: padDash(w - painted), style: box });
  }
  for (const s of ramp) segs.push(s);
  for (const s of rightSegs) segs.push(s);
  if (trailPad > 0) segs.push({ text: RIGHT_SLOT_PAD, style: box });
  segs.push({ text: br, style: box });
  return segs;
}

/** Right │ — contour hue; coverage ramps contour weight→primary. */
function rightBarStyle(t: number | undefined, contourRole?: string, prominence: FgProminence = FgP.ghost): Style {
  const box = boxContour(contourRole, prominence);
  if (t === undefined) return box;
  return {
    role: contourRole && contourRole.length > 0 ? contourRole : "foreground",
    prominence: fgProgress(prominence, FgP.primary, t),
  };
}

/** One body row: `│ · text…(padded) │` — always `outerW` cells. */
export function chromeFrameBodyRowSegs(
  line: string,
  row: number,
  outerW: number,
  glyph: string,
  opts?: {
    placeholder?: boolean;
    /**
     * Absolute draft offsets of this visual line's content (`line` is
     * draft.slice(lineStart, lineStart+line.length)). When set with
     * `selA`/`selB`, selected runs paint with `selected: true`.
     */
    lineStart?: number;
    selA?: number;
    selB?: number;
    /** Offsets ≥ this (into draft+completion) paint muted, not as draft. */
    draftLength?: number;
    /** 0..1 coverage of the right │ (ghost→primary). Omit → contour ghost. */
    rightCoverage?: number;
    contourRole?: string;
    contourProminence?: FgProminence;
  },
): ChromeSeg[] {
  const box = boxContour(opts?.contourRole, opts?.contourProminence);
  const textW = chromeFrameTextWidth(outerW);
  let body = line;
  while (measure(body) > textW && body.length > 0) body = body.slice(0, -1);
  if (body.length === 0) body = " ";
  const pad = Math.max(0, textW - measure(body));
  // Pad with spaces in the segment string — paint is text ops, not flex;
  // spaces are literal cells (pre-sized), so right │ is always at outerW-1.
  const textStyle = opts?.placeholder ? placeholderStyle : bodyStyle;
  const split =
    !opts?.placeholder &&
    opts?.lineStart !== undefined &&
    (opts.draftLength !== undefined || (opts.selA !== undefined && opts.selB !== undefined && opts.selA < opts.selB));
  const textSegs = split
    ? splitBodyRuns(body, opts!.lineStart!, {
        selA: opts!.selA,
        selB: opts!.selB,
        draftLength: opts!.draftLength,
        draftStyle: textStyle,
        pad,
      })
    : [{ text: body + (pad > 0 ? " ".repeat(pad) : ""), style: textStyle }];

  const mark = row === 0 ? glyph : " ";
  const marked = mark.trim().length > 0;
  return [
    { text: "│", style: box },
    { text: marked ? mark : " ", style: marked ? markCellStyle(mark) : {} },
    { text: " ", style: {} },
    ...textSegs,
    { text: "│", style: rightBarStyle(opts?.rightCoverage, opts?.contourRole, opts?.contourProminence) },
  ];
}

/** Split a visual body line into draft / selected / completion runs. */
function splitBodyRuns(
  body: string,
  lineStart: number,
  opts: {
    selA?: number;
    selB?: number;
    draftLength?: number;
    draftStyle: Style;
    pad: number;
  },
): ChromeSeg[] {
  const segs: ChromeSeg[] = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    const kind = bodyRunKind(lineStart + i, opts);
    let j = i + 1;
    while (j < n && bodyRunKind(lineStart + j, opts) === kind) j++;
    segs.push({
      text: body.slice(i, j),
      style:
        kind === "completion"
          ? completionStyle
          : kind === "sel"
            ? { ...opts.draftStyle, selected: true }
            : opts.draftStyle,
    });
    i = j;
  }
  if (opts.pad > 0) segs.push({ text: " ".repeat(opts.pad), style: opts.draftStyle });
  if (segs.length === 0) segs.push({ text: " ", style: opts.draftStyle });
  return segs;
}

function bodyRunKind(
  abs: number,
  opts: { selA?: number; selB?: number; draftLength?: number },
): "draft" | "sel" | "completion" {
  if (opts.draftLength !== undefined && abs >= opts.draftLength) return "completion";
  if (opts.selA !== undefined && opts.selB !== undefined && abs >= opts.selA && abs < opts.selB) {
    return "sel";
  }
  return "draft";
}

/**
 * Visual body lines of a draft with absolute start offsets into the draft.
 * Matches {@link chromeFrameBodyLines} partition for pre-wrap soft wrap.
 */
export function chromeFrameBodyLinesWithStarts(draft: string, outerW: number): Array<{ text: string; start: number }> {
  const w = chromeFrameTextWidth(outerW);
  if (draft.length === 0) return [{ text: " ", start: 0 }];
  const hardLines = draft.split("\n");
  const out: Array<{ text: string; start: number }> = [];
  let pos = 0;
  for (let hi = 0; hi < hardLines.length; hi++) {
    const hard = hardLines[hi]!;
    const soft = wrapText(hard, {
      width: w,
      whiteSpace: "pre-wrap",
      measure: defaultMeasure,
    });
    let hardPos = 0;
    for (const line of soft) {
      out.push({ text: line, start: pos + hardPos });
      hardPos += line.length;
    }
    pos += hard.length;
    if (hi < hardLines.length - 1) pos += 1; // consumed `\n`
  }
  return out.length > 0 ? out : [{ text: " ", start: 0 }];
}

/**
 * Body row from multi-style content segs.
 *
 * Aligned grid: `│ · text… │`   textW = outerW − 4
 * Selection marks go in `glyph` (`›` / ` `), not in text.
 */
export function chromeFrameBodyFromContentSegs(
  content: ChromeSeg[],
  outerW: number,
  opts: {
    withGlyph?: boolean;
    /** Glyph cell for this row (1 display col preferred). */
    glyph?: string;
    row?: number;
    /** 0..1 coverage of the right │ (ghost→primary). Omit → contour ghost. */
    rightCoverage?: number;
    contourRole?: string;
    contourProminence?: FgProminence;
  } = {},
): ChromeSeg[] {
  const w = Math.max(4, outerW);
  const box = boxContour(opts.contourRole, opts.contourProminence);
  const contentBudget = chromeFrameTextWidth(w);

  const g = (opts.glyph && opts.glyph.length > 0 ? opts.glyph : " ").slice(0, 2);
  const marked = g.trim().length > 0;
  const segs: ChromeSeg[] = [
    { text: "│", style: box },
    { text: marked ? g : " ", style: marked ? markCellStyle(g) : {} },
    { text: " ", style: {} },
  ];

  let contentUsed = 0;
  for (const s of content) {
    const tw = measure(s.text);
    if (contentUsed + tw > contentBudget) break;
    segs.push(s);
    contentUsed += tw;
  }
  const pad = Math.max(0, contentBudget - contentUsed);
  if (pad > 0) segs.push({ text: " ".repeat(pad), style: {} });
  segs.push({ text: "│", style: rightBarStyle(opts.rightCoverage, opts.contourRole, opts.contourProminence) });
  return segs;
}

/**
 * Resolve glyph cell for body row i.
 * bodyGlyphs wins; else draft mode uses frame glyph on row 0 only.
 */
export function chromeFrameRowGlyph(node: ChromeFrameNode, row: number, frameGlyph: string): string {
  if (node.bodyGlyphs && row < node.bodyGlyphs.length) {
    const g = node.bodyGlyphs[row];
    if (g !== undefined && g !== null) {
      return g.length > 0 ? g.slice(0, 2) : " ";
    }
  }
  if (row === 0) return frameGlyph;
  return " ";
}

/** Emit horizontal segment runs as text paint ops at (x, y). */
export function segsToPaintOps(segs: ChromeSeg[], x: number, y: number, clipW: number): PaintOp[] {
  const ops: PaintOp[] = [];
  let cx = x;
  let remaining = clipW;
  for (const s of segs) {
    if (remaining <= 0) break;
    let t = s.text;
    let tw = measure(t);
    if (tw > remaining) {
      // hard clip by columns
      while (t.length > 0 && measure(t) > remaining) t = t.slice(0, -1);
      tw = measure(t);
    }
    if (t.length === 0 || tw <= 0) continue;
    ops.push(
      s.live === undefined
        ? {
            kind: "text",
            rect: { x: cx, y, w: tw, h: 1 },
            lines: [t],
            style: s.style,
          }
        : {
            kind: "live",
            rect: { x: cx, y, w: tw, h: 1 },
            style: s.style,
            live: s.live,
          },
    );
    cx += tw;
    remaining -= tw;
  }
  return ops;
}

/**
 * Full paint ops for a chrome_frame placed at `rect`.
 *
 * Row map (always full `w` cells per edge/body line):
 *   y+0          ╭╮ — solo: shortcuts + annotation; stacked: annotation only
 *   y+1..y+bodyH body (`│  text… │`)
 *   last         bottom edge, or ├┤ T-join carrying shortcuts + joinAnnotation
 */
export function chromeFramePaintOps(
  node: ChromeFrameNode,
  rect: Rect,
): { ops: PaintOp[]; bodyHit: Rect; progressHit: Rect; geom: ChromeFrameGeom } {
  const geom = measureChromeFrame(node, rect.w, rect.h);
  const w = Math.min(rect.w, geom.outerW);
  const maxRows = Math.max(1, rect.h);
  const ops: PaintOp[] = [];

  const omitTop = node.omitTop === true;
  const joinHint = node.joinBottom === true && chromeFrameHasHint(node);
  const contourP = contourProminenceOf(node);
  const chromeTop = omitTop ? 0 : 1;
  // Prefer keeping edges: body gets whatever remains after chrome rows.
  const chromeMin = chromeTop + 1; // top(optional) + bottom
  const bodyBudget =
    maxRows <= chromeMin ? Math.max(0, maxRows - chromeTop) : Math.min(geom.bodyLines.length, maxRows - chromeMin);
  const bodyH =
    maxRows <= chromeTop
      ? 0
      : maxRows === chromeTop + 1
        ? Math.min(1, geom.bodyLines.length)
        : Math.max(omitTop ? 0 : 1, bodyBudget);

  // top (skipped when stacked under a joinBottom panel). Shortcuts leave
  // this rule for the T-join; annotation stays here when a ╭╮ exists.
  // hotkeysBottom is window chrome: hints ride ╰╯, title stays on ╭╮.
  const hotkeysOnTop = joinHint === false && node.hotkeysBottom !== true;
  if (!omitTop) {
    if (node.topSegs && node.topSegs.length > 0) {
      const content: ChromeSeg[] = node.topSegs.map((s) => ({
        text: s.text,
        style: styleFromSpec(s),
      }));
      ops.push(
        ...segsToPaintOps(
          chromeFrameTopFromContentSegs(w, content, {
            contourRole: node.contourRole,
            contourProminence: contourP,
          }),
          rect.x,
          rect.y,
          w,
        ),
      );
    } else {
      ops.push(
        ...segsToPaintOps(
          chromeFrameTopSegs(w, hotkeysOnTop ? node.hotkeys : null, {
            join: node.joinTop === true,
            annotation: node.annotation,
            annotationRole: node.annotationRole,
            contourRole: node.contourRole,
            contourProminence: contourP,
            modHeld: node.modHeld,
          }),
          rect.x,
          rect.y,
          w,
        ),
      );
    }
  }

  const bodyY0 = rect.y + chromeTop;
  for (let i = 0; i < bodyH; i++) {
    const rightCoverage = node.bodyRightCoverage?.[i];
    if (node.bodySegRows?.[i]) {
      const content: ChromeSeg[] = node.bodySegRows[i]!.map((s) => ({
        text: s.text,
        style: styleFromSpec(s),
      }));
      const rowGlyph = chromeFrameRowGlyph(node, i, geom.glyph);
      ops.push(
        ...segsToPaintOps(
          chromeFrameBodyFromContentSegs(content, w, {
            glyph: rowGlyph,
            row: i,
            rightCoverage,
            contourRole: node.contourRole,
            contourProminence: contourP,
          }),
          rect.x,
          bodyY0 + i,
          w,
        ),
      );
    } else {
      const ph = isChromeFrameShowingPlaceholder(node);
      const source = chromeFramePaintSource(node);
      const withStarts = ph ? null : chromeFramePaintBodyLines(source.draft, source.completion, w);
      const rowInfo = withStarts?.[i];
      const line = rowInfo?.text ?? geom.bodyLines[i] ?? " ";
      const cursor = node.cursor;
      const mark = node.mark;
      const hasSel = typeof cursor === "number" && typeof mark === "number" && mark !== cursor;
      const selA = hasSel ? Math.min(cursor!, mark!) : undefined;
      const selB = hasSel ? Math.max(cursor!, mark!) : undefined;
      ops.push(
        ...segsToPaintOps(
          chromeFrameBodyRowSegs(line, i, w, geom.glyph, {
            placeholder: ph,
            lineStart: rowInfo?.start,
            selA,
            selB,
            draftLength: ph ? undefined : source.draftLength,
            rightCoverage,
            contourRole: node.contourRole,
            contourProminence: contourP,
          }),
          rect.x,
          bodyY0 + i,
          w,
        ),
      );
    }
  }

  // bottom (when room). A stacked picker paints shortcuts on this T-join —
  // the line above the draft — not on ╭╮. Annotation stays on ╭╮;
  // joinAnnotation is the T-join's right-rail (title above the input).
  const botY = bodyY0 + bodyH;
  let progressHit: Rect = { x: rect.x + 1, y: botY, w: Math.max(0, w - 2), h: 1 };
  if (botY < rect.y + maxRows) {
    const bottomSegs = joinHint
      ? chromeFrameTopSegs(w, node.hotkeys, {
          join: true,
          annotation: node.joinAnnotation,
          annotationRole: node.joinAnnotationRole,
          contourRole: node.contourRole,
          contourProminence: contourP,
          modHeld: node.modHeld,
        })
      : node.hotkeysBottom === true
        ? chromeFrameTopSegs(w, node.hotkeys, {
            bottom: true,
            contourRole: node.contourRole,
            contourProminence: contourP,
            modHeld: node.modHeld,
          })
        : chromeFrameBottomSegs(w, {
            progress: node.progress,
            progressRole: node.progressRole,
            progressGlowAt: node.progressGlowAt,
            statusItems: node.statusItems,
            quotaWindows: node.quotaWindows,
            contextUsed: node.contextUsed,
            contextLimit: node.contextLimit,
            modHeld: node.modHeld,
            join: node.joinBottom === true,
            plain: node.plainBottom === true,
            contourRole: node.contourRole,
            contourProminence: contourP,
          });
    ops.push(...segsToPaintOps(bottomSegs, rect.x, botY, w));
    // Painted rail, not the unclipped label: a narrow frame may have dropped
    // the quota and kept occupancy, and the hit must follow what is on screen.
    const rightW = Math.max(0, segsWidth(bottomSegs.slice(1, -1)) - (w - 2));
    progressHit = {
      x: rect.x + 1,
      y: botY,
      w: Math.max(0, w - 2 - rightW),
      h: 1,
    };
  }

  // Selection/contain hit = text column only. Side │ and mark are chrome —
  // not part of the selectable draft (copy joins body lines with \n).
  const textInset = chromeFrameTextInset();
  const textW = chromeFrameContentWidth(w);
  const bodyHit: Rect = {
    x: rect.x + textInset,
    y: bodyY0,
    w: textW,
    h: Math.max(1, bodyH || 1),
  };

  // Body only. Hint-rule keys stay primary — Enter/Esc still arrive.
  // Recap (`readOnly`) keeps ordinary body voice; waiting still whispers.
  if (node.interactive === false && node.readOnly !== true) {
    const whisper = FgP.whisper;
    const bodyY1 = bodyY0 + bodyH;
    for (const op of ops) {
      if (op.kind !== "text") continue;
      if (op.rect.y < bodyY0 || op.rect.y >= bodyY1) continue;
      op.style = { ...op.style, prominence: whisper };
    }
  }

  return {
    ops,
    bodyHit,
    progressHit,
    geom: {
      ...geom,
      outerW: w,
      bodyH: bodyH || 1,
      totalH: chromeTop + (bodyH || 1) + (botY < rect.y + maxRows ? 1 : 0),
    },
  };
}
