/**
 * Layout resolve: LayoutNode → Frame.
 * Pure geometry. Does not write terminal.
 */

import { chromeFramePaintOps, isChromeFrameShowingPlaceholder } from "./chrome_frame.js";
import { distributeExact, flexMainSizes, resolveFlexItem } from "./flex.js";
import { trackOffsets } from "./grid.js";
import { INDICATION_CONTENT_INSET, indicationGutterLines, indicationGutterWide } from "./indication.js";
import { resolveLength } from "./length.js";
import { collectLiveDemand, spinnerLive, type SpinnerProfile } from "./live_paint.js";
import { markdownToNodes } from "./markdown.js";
import { clamp0, measureGridDims, measureNode as measureNodePure, pad } from "./measure.js";
import { minPeekHeight, omittedLabel, planSqueeze, squeezeOverlay } from "./squeeze.js";
import { wrapLayoutText } from "./text.js";
import type {
  DiffLineRef,
  Frame,
  HitMeta,
  Intent,
  LayoutNode,
  LayoutOpts,
  Overflow,
  PaintOp,
  Positioned,
  Rect,
  TableCellRef,
  UserSelect,
} from "./types.js";
import type { Style } from "../buffer/index.js";
import { FgP } from "../lexicon/index.js";
import { defaultMeasure } from "../measure/index.js";

/**
 * A `userSelect` value that makes an `intent:none` node eligible for the
 * hitlist (i.e. a drag can start a selection on it). The CSS-aligned union
 * rejects the boolean truthiness gate, which would admit
 * `"none"` (a truthy string) — the exact trap these explicit values fix.
 *
 * `"auto"` is treated as non-eligible here: at the root it defaults to "auto"
 * and inherits; a node must explicitly opt into selectability with one of
 * {text, all, contain}. This matches CSS, where `auto` on a non-editable
 * ancestor resolves to `none`.
 */
const SELECTABLE_HIT: ReadonlySet<UserSelect> = new Set(["text", "all", "contain"]);

/** Hit-eligibility check — the union-correct replacement for truthiness. */
function isSelectableHit(v: UserSelect): boolean {
  return SELECTABLE_HIT.has(v);
}

/**
 * Admission gate shared by {@link elementAt} and {@link elementAtPath}. A node
 * is admissible (returned to callers) when it is
 * NOT inert, NOT a phantom container, AND either has a non-none intent OR is
 * explicitly selectable (text/all/contain) OR carries an onClick.
 *
 * Phantoms (flex/gap, grid) are structural containers but never selectable —
 * they are skipped everywhere except the byKey fallback in {@link elementAt},
 * which already filters them via `meta.phantom`.
 */
function isAdmissibleHit(meta: HitMeta): boolean {
  if (meta.inert || meta.phantom) return false;
  if (meta.intent === "none" && !isSelectableHit(meta.userSelect) && !meta.onClick) return false;
  return true;
}

/** Rect contains point (half-open: right/bottom edges excluded). */
function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

type Ctx = {
  measure: (t: string) => number;
  path: string[];
  paintOrder: Positioned[];
  hitList: HitMeta[];
  byKey: Map<string, HitMeta>;
  counters: { invalidStyle: number; frame: number };
  /**
   * When placing grid children, the active cell identity is stamped onto
   * every hit in the cell so copy can rebuild compact markdown.
   */
  tableCell?: TableCellRef;
  /**
   * When placing a diff line box, the logical line stamp is scoped onto
   * descendant hits so copy/mirror can rebuild git lines (not buffer chrome).
   */
  diffLine?: DiffLineRef;
  /**
   * An ancestor was placed despite sitting fully below the clip (the
   * viewport's last child), so this subtree's own last child must still
   * place — a sticky-bottom or squeeze descendant paints from below the
   * floor, and intermediate boxes would otherwise skip it as clipped.
   */
  holdTail?: boolean;
  /** Bottom of the box currently placing children. `sticky: "top"` must not cross it. */
  stickyFloor?: number;
  /** Sticky-top subtrees shifted into the clip. Flushed at the enclosing viewport. */
  stuckLifts: StuckLift[];
};

type StuckLift = { paintAt: number; paintTo: number; hitAt: number; hitTo: number };

/** Ctx-bound measure — same pure measureNode used by structure HTML. */
function measureNode(node: LayoutNode, maxW: number, maxH: number, ctx: Ctx): { w: number; h: number } {
  return measureNodePure(node, maxW, maxH, ctx.measure);
}

function keyOf(node: LayoutNode, path: string[]): string {
  if ("key" in node && node.key) return node.key;
  if ("id" in node && node.id) return node.id;
  return path.join("/");
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function overflowAxisTight(v: Overflow | undefined): boolean {
  return v === "hidden" || v === "clip" || v === "auto" || v === "scroll";
}

function overflowTight(style: { overflow?: Overflow; overflowX?: Overflow; overflowY?: Overflow }): boolean {
  return overflowAxisTight(style.overflow) || overflowAxisTight(style.overflowX) || overflowAxisTight(style.overflowY);
}

/** Sticky-bottom / squeeze / overlay still place when fully below the clip. */
function placesFullyBelowClip(node: LayoutNode): boolean {
  if (node.type === "overlay") return true;
  if (node.type === "box" && (node.style?.sticky === "bottom" || node.style?.squeeze)) return true;
  return false;
}

/** Sticky-top still places once its top edge has crossed above the clip. */
function pinsFromAboveClip(node: LayoutNode, childRect: Rect, clip: Rect): boolean {
  return isStickyTop(node) && childRect.y + childRect.h <= clip.y;
}

/** Move shifted sticky-top subtrees above paint that was recorded after them. */
function flushStuckLifts(ctx: Ctx, from: number): void {
  const lifts = ctx.stuckLifts.splice(from);
  const paintSlices: Positioned[][] = [];
  const hitSlices: HitMeta[][] = [];
  for (let i = lifts.length - 1; i >= 0; i--) {
    const lift = lifts[i]!;
    paintSlices.push(ctx.paintOrder.splice(lift.paintAt, lift.paintTo - lift.paintAt));
    hitSlices.push(ctx.hitList.splice(lift.hitAt, lift.hitTo - lift.hitAt));
  }
  for (let i = paintSlices.length - 1; i >= 0; i--) {
    const paint = paintSlices[i]!;
    const hits = hitSlices[i]!;
    if (paint.length > 0) ctx.paintOrder.push(...paint);
    if (hits.length > 0) ctx.hitList.push(...hits);
  }
}

function pushHit(
  ctx: Ctx,
  key: string,
  hitRect: Rect,
  intent: Intent,
  opts: {
    userSelect?: UserSelect;
    inert?: boolean;
    onClick?: unknown;
    kind?: string;
    phantom?: boolean;
    parent?: string;
    viewport?: { scrollY: number; maxScroll: number };
  },
): void {
  const userSelect: UserSelect = opts.userSelect ?? "auto";
  const meta: HitMeta = {
    key,
    hitRect,
    intent,
    userSelect,
    inert: opts.inert ?? false,
    onClick: opts.onClick,
    element: opts.kind ? { kind: opts.kind, ...(opts.viewport ?? {}) } : undefined,
    phantom: opts.phantom,
    parent: opts.parent,
    tableCell: opts.phantom ? undefined : ctx.tableCell,
    // Phantoms (flex/gap) must not carry semantic stamps — they span the
    // whole half and would steal participation from real code text hits.
    diffLine: opts.phantom ? undefined : ctx.diffLine,
  };
  ctx.byKey.set(key, meta);
  // Hitlist admission: a node is hittable if it has a non-none intent, OR is
  // a phantom container (flex/gap), OR is explicitly selectable (text/all/contain).
  // The userSelect gate uses the union-correct check, NOT truthiness — "none"
  // and "auto" are not hit-eligible on their own.
  if (intent !== "none" || opts.phantom || isSelectableHit(userSelect)) {
    ctx.hitList.push(meta);
  }
}

/** Default subtle chrome for inner grid bars — same role/prominence as box border. */
const DEFAULT_GRID_LINE: Style = { role: "border", prominence: FgP.ghost };

/**
 * Default region fade for `overlay` with `backdrop: true` and no
 * `backdropStyle`. Decision 1 (color-hygiene): content behind a modal is
 * region-dimmed — the room recedes, identity stays visible. Layout stamps
 * this onto every paint op already in the order (base content); overlay
 * children place *after* and stay full-prominence. Hosts no longer need to
 * rebind paintTheme for a single-modal case. Matches storybook modal-backdrop
 * law (stories/theme.ts theme-region-dim uses 0.4).
 */
const BACKDROP_REGION_PROMINENCE = 0.4;

/**
 * Stamp region-dim onto already-placed paint (the room behind a modal).
 * Nested overlays multiply so a second scrim compounds (sidebar 1×, tape 2×)
 * and never raises a lower region. `raw` ops own their styles and are left alone.
 */
function stampBackdropRegion(paintOrder: Positioned[], regionP: number): void {
  for (const pos of paintOrder) {
    for (const op of pos.paint) {
      if (op.kind === "raw") continue;
      const prev = op.style.regionProminence;
      const next = prev === undefined ? regionP : prev * regionP;
      if (prev === next) continue;
      op.style = { ...op.style, regionProminence: next };
    }
  }
}

function paintInnerGridBars(
  rect: Rect,
  colWidths: readonly number[],
  rowHeights: readonly number[],
  colOff: readonly number[],
  rowOff: readonly number[],
  colGap: number,
  rowGap: number,
  nCols: number,
  nRows: number,
  lineStyle: Style,
): PaintOp[] {
  const paints: PaintOp[] = [];
  for (let r = 0; r < nRows - 1; r++) {
    if (rowGap <= 0) continue;
    const y = rect.y + rowOff[r]! + rowHeights[r]!;
    for (let g = 0; g < rowGap; g++) {
      let line = "";
      for (let c = 0; c < nCols; c++) {
        line += "─".repeat(Math.max(0, colWidths[c]!));
        if (c < nCols - 1) {
          line += (g === 0 ? "┼" : "│").repeat(Math.max(0, colGap));
        }
      }
      if (line.length > 0) {
        paints.push({
          kind: "text",
          rect: {
            x: rect.x,
            y: y + g,
            w: line.length,
            h: 1,
          },
          lines: [line],
          style: lineStyle,
        });
      }
    }
  }
  for (let c = 0; c < nCols - 1; c++) {
    if (colGap <= 0) continue;
    const x = rect.x + colOff[c]! + colWidths[c]!;
    for (let r = 0; r < nRows; r++) {
      const y = rect.y + rowOff[r]!;
      const h = rowHeights[r]!;
      for (let g = 0; g < colGap; g++) {
        paints.push({
          kind: "text",
          rect: { x: x + g, y, w: 1, h },
          lines: Array.from({ length: h }, () => "│"),
          style: lineStyle,
        });
      }
    }
  }
  return paints;
}

function placeGrid(
  node: Extract<LayoutNode, { type: "grid" }>,
  rect: Rect,
  clip: Rect,
  ctx: Ctx,
  inherit: { userSelect: UserSelect; inert: boolean },
  key: string,
  userSelect: UserSelect,
  inert: boolean,
  parentKey: string | undefined,
): void {
  const dims = measureGridDims(node, rect.w, ctx.measure);
  const { colWidths, rowHeights, colGap, rowGap, padX, padY, nCols, nRows } = dims;
  const children = node.children ?? [];
  const lines = node.style.lines ?? "none";
  const lineStyle = node.style.lineStyle ?? DEFAULT_GRID_LINE;

  const gridClip = intersect(rect, clip);
  if (gridClip) {
    pushHit(ctx, key, gridClip, "none", {
      kind: "grid",
      phantom: true,
      userSelect,
      inert,
      parent: parentKey,
    });
  }

  const colOff = trackOffsets(colWidths, colGap);
  const rowOff = trackOffsets(rowHeights, rowGap);

  if (lines === "inner" && gridClip) {
    const paints = paintInnerGridBars(
      rect,
      colWidths,
      rowHeights,
      colOff,
      rowOff,
      colGap,
      rowGap,
      nCols,
      nRows,
      lineStyle,
    );
    if (paints.length > 0) {
      ctx.paintOrder.push({
        key: `${key}:lines`,
        rect,
        paint: paints,
        clip: gridClip,
      });
    }
  }

  // Place cells (row-major). Stamp tableCell so selection copy can rebuild
  // compact markdown instead of the full terminal bar padding.
  for (let r = 0; r < nRows; r++) {
    for (let c = 0; c < nCols; c++) {
      const idx = r * nCols + c;
      const child = children[idx];
      if (!child) continue;
      const cellX = rect.x + colOff[c]!;
      const cellY = rect.y + rowOff[r]!;
      const cellW = colWidths[c]!;
      const cellH = rowHeights[r]!;
      const contentRect: Rect = {
        x: cellX + padX,
        y: cellY + padY,
        w: Math.max(0, cellW - padX * 2),
        h: Math.max(0, cellH - padY * 2),
      };
      const childClip = intersect(contentRect, clip);
      if (!childClip) continue;
      const prevTable = ctx.tableCell;
      ctx.tableCell = {
        gridKey: key,
        row: r,
        col: c,
        nCols,
        nRows,
      };
      place(child, contentRect, childClip, ctx, inherit, key);
      ctx.tableCell = prevTable;
    }
  }
}

function stickyBottomRect(node: LayoutNode, rect: Rect, clip: Rect): Rect {
  if (node.type !== "box" || node.style?.sticky !== "bottom") return rect;
  const overflow = rect.y + rect.h - (clip.y + clip.h);
  if (overflow <= 0) return rect;
  return { ...rect, y: rect.y - overflow };
}

function isStickyTop(node: LayoutNode): boolean {
  return node.type === "box" && node.style?.sticky === "top";
}

/**
 * Pin once the box's top edge meets the clip. While the top is still below
 * that edge the box stays in flow; it sticks the moment the top arrives, not
 * after the rest of the box has scrolled away. `floor` is the next sticky
 * sibling (the next turn); it pushes this box back out.
 *
 * A box that does not fit never pins while any of it is still in the clip:
 * full height would blanket the viewport. Once it has left entirely it
 * squeezes to its first row, so the prompt the visible lines belong to stays
 * named. That row is this same box, not a copy.
 */
function stickyTopRect(node: LayoutNode, rect: Rect, clip: Rect, floor: number | undefined): Rect {
  if (!isStickyTop(node)) return rect;
  if (rect.y >= clip.y) return rect;
  const left = rect.y + rect.h <= clip.y;
  if (!left && rect.h >= clip.h) return rect;
  const squeezed = left && rect.h >= clip.h;
  const h = squeezed ? 1 : rect.h;
  const room = (floor ?? clip.y + clip.h) - clip.y;
  if (h > room) return rect;
  const limit = (floor ?? clip.y + clip.h) - h;
  const y = Math.max(rect.y, Math.min(clip.y, limit));
  if (y === rect.y && h === rect.h) return rect;
  return { ...rect, y, h };
}

function omitNode(count: number, key: string): LayoutNode {
  return {
    type: "text",
    key,
    content: omittedLabel(count),
    whiteSpace: "nowrap",
    ellipsis: true,
    lineClamp: 1,
    userSelect: "none",
    style: { role: "chrome", prominence: FgP.ghost },
  };
}

function placeSqueezedChildren(
  node: Extract<LayoutNode, { type: "box" }>,
  content: Rect,
  clip: Rect,
  ctx: Ctx,
  inherit: { userSelect: UserSelect; inert: boolean },
  parentKey: string,
  pin: { head: number; tail: number },
): void {
  const children = node.children ?? [];
  if (children.length === 0) return;
  const heights = children.map((c) => measureNode(c, content.w, 10_000, ctx).h);
  const naturalH = heights.reduce((a, b) => a + b, 0);
  const peek = minPeekHeight(heights, pin.head, pin.tail);
  const overlay = squeezeOverlay(content, clip, naturalH, peek);
  if (!overlay) return;
  // Overlay sits on scrolled tape. Void cells would keep the tape's
  // glyph + wash via mergeStyle. Occupy the overlay first with a
  // transparent cast — no surface tint, no fuse.
  const floor: Rect = { x: overlay.x, y: overlay.y, w: overlay.w, h: overlay.h };
  ctx.paintOrder.push({
    key: `${parentKey}:void`,
    rect: floor,
    paint: [{ kind: "fill", rect: floor, style: { cast: "transparent" } }],
    clip,
  });
  const slots = planSqueeze({
    heights,
    overlay,
    naturalY: content.y,
    clipH: clip.h,
    head: pin.head,
    tail: pin.tail,
  });
  for (const slot of slots) {
    if (slot.kind === "child") {
      const child = children[slot.index];
      if (!child) continue;
      place(child, { x: content.x, y: slot.y, w: content.w, h: slot.h }, clip, ctx, inherit, parentKey);
      continue;
    }
    place(
      omitNode(slot.count, `${parentKey}:omit-${slot.edge}`),
      { x: content.x, y: slot.y, w: content.w, h: 1 },
      clip,
      ctx,
      inherit,
      parentKey,
    );
  }
}

function place(
  node: LayoutNode,
  rect: Rect,
  clip: Rect,
  ctx: Ctx,
  inherit: { userSelect: UserSelect; inert: boolean },
  parentKey?: string,
): void {
  const regionStart = ctx.paintOrder.length;
  const hitAt = ctx.hitList.length;
  const naturalY = rect.y;
  rect = stickyBottomRect(node, rect, clip);
  rect = stickyTopRect(node, rect, clip, ctx.stickyFloor);
  const path = [...ctx.path, node.type];
  const prevPath = ctx.path;
  ctx.path = path;
  const key = keyOf(node, path);
  const userSelect: UserSelect =
    "userSelect" in node && node.userSelect !== undefined ? node.userSelect : inherit.userSelect;
  const inert = "inert" in node && node.inert !== undefined ? node.inert : inherit.inert;
  const nextInherit = { userSelect, inert };

  switch (node.type) {
    case "text": {
      const vis = intersect(rect, clip);
      if (!vis) break;
      const style: Style = node.style ?? {};
      // Live label: one op, resolved at paintFrame(nowMs).
      if (node.live) {
        ctx.paintOrder.push({
          key,
          rect,
          paint: [
            {
              kind: "live",
              rect,
              style,
              live: node.live,
              content: node.live.kind === "birth" ? node.content : undefined,
            },
          ],
          clip,
        });
        break;
      }
      const lines = wrapLayoutText(node, rect.w, ctx.measure).lines;
      // Top-clip: skip lines above the visible rect (viewport scroll).
      const topSkip = Math.max(0, vis.y - rect.y);
      const visible = lines.slice(topSkip, topSkip + vis.h);
      ctx.paintOrder.push({
        key,
        rect,
        paint: [
          {
            kind: "text",
            rect: {
              x: rect.x,
              y: rect.y + topSkip,
              w: rect.w,
              h: visible.length,
            },
            lines: visible,
            style,
          },
        ],
        clip,
      });
      // Text was paint-only historically. Grid / diff stamps need a hit for
      // semantic copy; keyed text is also addressable.
      if (ctx.tableCell || ctx.diffLine || ("key" in node && node.key)) {
        // Chrome under a stamp (gutter/nums with userSelect:"none") stays none.
        // Only auto/inherit upgrades to text so content is hittable.
        let hitUs = userSelect;
        if ((ctx.tableCell || ctx.diffLine) && !isSelectableHit(userSelect) && userSelect !== "none") {
          hitUs = "text";
        }
        pushHit(ctx, key, vis, "none", {
          userSelect: hitUs,
          inert,
          kind: "text",
          parent: parentKey,
        });
      }
      break;
    }
    case "raw": {
      const vis = intersect(rect, clip);
      if (vis) {
        ctx.paintOrder.push({
          key,
          rect,
          paint: [{ kind: "raw", rect, paint: node.paint }],
          clip,
        });
        const intent = inert ? "none" : (node.intent ?? "none");
        pushHit(ctx, key, vis, intent, {
          userSelect,
          inert,
          kind: "raw",
          parent: parentKey,
        });
      }
      break;
    }
    case "box": {
      const style = node.style ?? {};
      const pd = pad(style.padding);
      const border = style.border ? 1 : 0;
      const clipped = intersect(rect, clip);
      // Off-screen children are skipped unless they themselves are sticky,
      // squeeze, or overlay. Nested sticky inside a skipped unit is out.

      const paints: PaintOp[] = [];
      const pinClip = rect.y !== naturalY && style.sticky === "top" ? clipped : null;
      if (clipped && style.background) {
        paints.push({ kind: "fill", rect: pinClip ?? rect, style: style.background });
      }
      if (clipped && border) {
        paints.push({
          kind: "border",
          rect,
          style: { role: "border", prominence: FgP.ghost },
        });
      }
      if (paints.length > 0) {
        ctx.paintOrder.push({ key, rect, paint: paints, clip });
      }

      const intent = inert ? "none" : (node.intent ?? (node.onClick === undefined ? "none" : "activate"));
      // Border ring is chrome for selection — same law as chrome_frame. Without
      // this stamp a selectable ancestor (storybook demo-stage) claims ╭─╮/│
      // cells and free-text paints box-drawing into the highlight. Interaction
      // hit stays the full outer rect so bordered buttons still click on the
      // frame; chrome_mask step-2 none-stamp wins over the selectable claim
      // for paint/copy only.
      if (clipped && border && key) {
        pushHit(ctx, `${key}:chrome`, clipped, "none", {
          userSelect: "none",
          inert,
          kind: "box_chrome",
          parent: parentKey,
        });
      }
      if (clipped) {
        pushHit(ctx, key, pinClip ?? clipped, intent, {
          userSelect,
          inert,
          onClick: node.onClick,
          kind: "box",
          parent: parentKey,
        });
      }

      const content: Rect = {
        x: rect.x + pd.l + border,
        y: rect.y + pd.t + border,
        w: Math.max(0, rect.w - pd.l - pd.r - border * 2),
        h: Math.max(0, rect.h - pd.t - pd.b - border * 2),
      };
      let childClip: Rect | null = clip;
      if (overflowTight(style)) {
        childClip = intersect(content, clip);
      }

      // Diff line stamp scopes to descendants (tableCell analog).
      const prevDiff = ctx.diffLine;
      if (node.diffLine) ctx.diffLine = node.diffLine;
      const prevFloor = ctx.stickyFloor;
      ctx.stickyFloor = rect.y + rect.h;

      const squeeze = style.squeeze;
      if (squeeze && (squeeze.head > 0 || squeeze.tail > 0) && (node.children?.length ?? 0) > 0) {
        placeSqueezedChildren(node, content, clip, ctx, nextInherit, key, squeeze);
        ctx.diffLine = prevDiff;
        ctx.stickyFloor = prevFloor;
        break;
      }

      const boxChildren = node.children ?? [];
      // Sticky-top lives on every user prompt, so a "any sticky?" premeasure
      // would wrap the whole tape. Measure as we go; look ahead only for the
      // next prompt's natural y (sticky floor). Sticky-top below the clip
      // cannot pin — do not keep walking the rest of the column for it.
      const heightAt: Array<number | undefined> = [];
      const childH = (i: number): number => {
        const item = boxChildren[i]!;
        if (item.type === "overlay") return 0;
        const cached = heightAt[i];
        if (cached !== undefined) return cached;
        const h = measureNode(item, content.w, content.h, ctx).h;
        heightAt[i] = h;
        return h;
      };
      let specialAfter = false;
      const specialTail: boolean[] = Array.from({ length: boxChildren.length });
      for (let i = boxChildren.length - 1; i >= 0; i--) {
        specialTail[i] = specialAfter;
        if (placesFullyBelowClip(boxChildren[i]!)) specialAfter = true;
      }
      let cy = content.y;
      for (let boxI = 0; boxI < boxChildren.length; boxI++) {
        const child = boxChildren[boxI]!;
        if (!childClip) break;
        // Overlay is absolute: full parent content rect, does not advance flow.
        if (child.type === "overlay") {
          place(child, content, childClip, ctx, nextInherit, key);
          continue;
        }
        const mh = childH(boxI);
        // Column stack: stretch to content width (TUI default). Shrink-wrap
        // width broke indication remeasure (wrap at 1ch → caret/glyph split).
        const childRect = {
          x: content.x,
          y: cy,
          w: content.w,
          h: Math.min(content.h - (cy - content.y), mh),
        };
        // A held tail (an ancestor placed despite being fully below the clip)
        // keeps its own last child placed, so a sticky-bottom or squeeze
        // descendant can still paint from below the floor. Off-screen wrap of
        // every other clipped child stays skipped.
        const heldTail = ctx.holdTail === true && boxI === boxChildren.length - 1;
        if (
          !heldTail &&
          !intersect(childRect, childClip) &&
          !pinsFromAboveClip(child, childRect, childClip) &&
          !placesFullyBelowClip(child)
        ) {
          cy += mh;
          // Once we are fully below the clip, later ordinary rows cannot paint.
          // A held tail still walks so the last child keeps its natural y.
          if (cy >= childClip.y + childClip.h && specialTail[boxI] !== true) {
            if (ctx.holdTail === true && boxI < boxChildren.length - 1) continue;
            break;
          }
          continue;
        }
        let nextTurn = rect.y + rect.h;
        if (isStickyTop(child)) {
          let lookY = cy + mh;
          for (let j = boxI + 1; j < boxChildren.length; j++) {
            if (boxChildren[j]!.type === "overlay") continue;
            if (isStickyTop(boxChildren[j]!)) {
              nextTurn = lookY;
              break;
            }
            lookY += childH(j);
          }
        }
        const prevHold = ctx.holdTail;
        const savedFloor: number | undefined = ctx.stickyFloor;
        ctx.holdTail = heldTail;
        if (isStickyTop(child)) ctx.stickyFloor = nextTurn;
        place(child, childRect, childClip, ctx, nextInherit, key);
        ctx.stickyFloor = savedFloor;
        ctx.holdTail = prevHold;
        cy += mh;
      }
      ctx.diffLine = prevDiff;
      ctx.stickyFloor = prevFloor;
      break;
    }
    case "flex": {
      const style = node.style ?? {};
      const dir = style.direction === "column" || style.direction === "column_reverse" ? "column" : "row";
      const gap = clamp0(style.gap ?? 0);
      const pd = pad(style.padding);
      const content: Rect = {
        x: rect.x + pd.l,
        y: rect.y + pd.t,
        w: Math.max(0, rect.w - pd.l - pd.r),
        h: Math.max(0, rect.h - pd.t - pd.b),
      };
      const children = node.children ?? [];
      const mainSize = dir === "row" ? content.w : content.h;
      const crossSize = dir === "row" ? content.h : content.w;

      const measured = children.map((c) => {
        const m = measureNode(c, dir === "row" ? mainSize : content.w, dir === "row" ? content.h : mainSize, ctx);
        return m;
      });

      const flexInputs = children.map((c, i) => {
        const m = measured[i]!;
        const contentMain = dir === "row" ? m.w : m.h;
        const boxStyle = c.type === "box" ? c.style : undefined;
        const explicit =
          boxStyle &&
          (dir === "row" ? resolveLength(boxStyle.width, content.w) : resolveLength(boxStyle.height, content.h));
        return resolveFlexItem(
          {
            flex: boxStyle?.flex as number | { grow?: number; shrink?: number; basis?: number } | undefined,
            flexGrow: boxStyle?.flexGrow,
            flexShrink: boxStyle?.flexShrink,
            flexBasis: typeof boxStyle?.flexBasis === "number" ? boxStyle.flexBasis : undefined,
            minMain:
              boxStyle &&
              (dir === "row"
                ? resolveLength(boxStyle.minWidth, content.w)
                : resolveLength(boxStyle.minHeight, content.h)) !== "auto"
                ? (resolveLength(
                    dir === "row" ? boxStyle.minWidth : boxStyle.minHeight,
                    dir === "row" ? content.w : content.h,
                  ) as number)
                : undefined,
            explicitMain: explicit === "auto" ? undefined : (explicit as number),
          },
          contentMain,
        );
      });

      const mains = flexMainSizes(flexInputs, mainSize, gap);
      const align = style.alignItems ?? "stretch";
      const justify = style.justifyContent ?? "flex_start";

      // phantom for gap ownership
      const flexClip = intersect(rect, clip);
      if (flexClip) {
        pushHit(ctx, `${key}:flex`, flexClip, "none", {
          phantom: true,
          kind: "flex",
          userSelect,
          inert,
          parent: parentKey,
        });
      }

      // Free main-axis space after grow/shrink — justify-content places it.
      // Use largest-remainder (distributeExact) so free cells are not dropped;
      // pure floor leaves last item short of flush for space_between (n≥3).
      const n = children.length;
      const usedMain = mains.reduce((a, b) => a + b, 0) + gap * Math.max(0, n - 1);
      const freeMain = Math.max(0, mainSize - usedMain);
      let startOff = 0;
      // betweens[i] = gap (+ free) after child i, for i in 0..n-2
      const betweens = Array.from({ length: Math.max(0, n - 1) }, () => gap);
      if (freeMain > 0 && n > 0) {
        switch (justify) {
          case "flex_end":
            startOff = freeMain;
            break;
          case "center":
            startOff = Math.floor(freeMain / 2);
            break;
          case "space_between":
            // first at start, last at end; n=1 → start (CSS)
            if (n > 1) {
              const extras = distributeExact(
                Array.from({ length: n - 1 }, () => 1),
                freeMain,
              );
              for (let i = 0; i < n - 1; i++) {
                betweens[i] = gap + extras[i]!;
              }
            }
            break;
          case "space_around": {
            // CSS: equal padding around each item → end slots weight 1, mid weight 2
            const weights = Array.from({ length: n + 1 }, () => 2);
            weights[0] = 1;
            weights[n] = 1;
            const parts = distributeExact(weights, freeMain);
            startOff = parts[0]!;
            for (let i = 0; i < n - 1; i++) {
              betweens[i] = gap + parts[i + 1]!;
            }
            break;
          }
          case "space_evenly": {
            const parts = distributeExact(
              Array.from({ length: n + 1 }, () => 1),
              freeMain,
            );
            startOff = parts[0]!;
            for (let i = 0; i < n - 1; i++) {
              betweens[i] = gap + parts[i + 1]!;
            }
            break;
          }
          default:
            break;
        }
      }

      let cursor = (dir === "row" ? content.x : content.y) + startOff;
      for (const [i, child] of children.entries()) {
        const main = mains[i]!;
        const m = measured[i]!;
        let cross = dir === "row" ? m.h : m.w;
        if (align === "stretch") cross = crossSize;
        let crossOff = 0;
        if (align === "center") crossOff = Math.floor((crossSize - cross) / 2);
        if (align === "flex_end") crossOff = crossSize - cross;

        const childRect: Rect =
          dir === "row"
            ? {
                x: cursor,
                y: content.y + crossOff,
                w: main,
                h: Math.min(cross, content.h),
              }
            : {
                x: content.x + crossOff,
                y: cursor,
                w: Math.min(cross, content.w),
                h: main,
              };
        place(child, childRect, clip, ctx, nextInherit, key);
        if (i < n - 1) cursor += main + betweens[i]!;
      }
      break;
    }
    case "grid": {
      placeGrid(node, rect, clip, ctx, nextInherit, key, userSelect, inert, parentKey);
      break;
    }
    case "viewport": {
      const clipped = intersect(rect, clip);
      if (!clipped) break;

      const children = node.children ?? [];
      // Stack children vertically; scroll by content row (not child index).
      const anchor = node.overflowAnchor ?? "auto";
      let totalH = 0;
      const heights = children.map((c) => {
        const m = measureNode(c, rect.w, 10_000, ctx);
        totalH += m.h;
        return m.h;
      });

      const maxScroll = Math.max(0, totalH - rect.h);
      const scrollY = anchor === "auto" ? maxScroll : Math.max(0, Math.min(maxScroll, node.scroll ?? 0));
      // Short stack: park the last child on the floor (height-0 flex-1 gap).
      const floorGap = children.length >= 2 && totalH < rect.h ? rect.h - totalH : 0;
      pushHit(ctx, key, clipped, "none", {
        kind: "viewport",
        userSelect,
        inert,
        parent: parentKey,
        viewport: { scrollY, maxScroll },
      });

      let y = rect.y - scrollY;
      const liftMark = ctx.stuckLifts.length;
      for (let i = 0; i < children.length; i++) {
        const last = i === children.length - 1;
        if (last) y += floorGap;
        const h = heights[i]!;
        // Skip fully above / break fully below — except the last child, which
        // may carry sticky-bottom or squeeze descendants that must still place().
        if (!last && y + h <= clipped.y) {
          y += h;
          continue;
        }
        if (!last && y >= clipped.y + clipped.h) break;
        // Full natural height — top/bottom clip via place() + line skip.
        const prevHold = ctx.holdTail;
        ctx.holdTail = last && y >= clipped.y + clipped.h;
        place(children[i]!, { x: rect.x, y, w: rect.w, h }, clipped, ctx, nextInherit, key);
        ctx.holdTail = prevHold;
        y += h;
      }
      flushStuckLifts(ctx, liftMark);
      break;
    }
    case "indication": {
      const clipped = intersect(rect, clip);
      if (!clipped) break;
      const style: Style = node.style ?? {};
      // Law 6: [lead][gutter][gap][content] — content at column 3.
      // Gutter spans **content height** (not stretched allocation) so ∵…∴
      // close on the last body row, not the bottom of a tall flex cell.
      const contentW = Math.max(0, rect.w - INDICATION_CONTENT_INSET);
      let contentH = 0;
      const childMs: { h: number; w: number }[] = [];
      for (const child of node.children ?? []) {
        const m = measureNode(child, contentW, 10_000, ctx);
        childMs.push(m);
        contentH += m.h;
      }
      // Paint gutter for full content height; clip + line-skip handle scroll.
      const barH = Math.max(1, contentH || 1);
      const g = node.gutter;
      // A two-cell sigil starts in the lead column. A one-cell glyph stays at column 1.
      const wideGutter = indicationGutterWide(g);
      const gutterRect = {
        x: rect.x + (wideGutter ? 0 : 1),
        y: rect.y,
        w: wideGutter ? 2 : 1,
        h: barH,
      };
      const gutterClipped = intersect(gutterRect, clipped);
      // Spinner gutter → live paint ops (render-side; no braille in tree).
      if (g?.kind === "spinner" && gutterClipped) {
        const profile: SpinnerProfile = g.profile ?? "working";
        const live = spinnerLive(profile);
        const rows = g.rows ?? "top";
        const topSkip = Math.max(0, gutterClipped.y - gutterRect.y);
        const paint: PaintOp[] = [];
        for (let i = 0; i < gutterClipped.h; i++) {
          const rowInBar = topSkip + i;
          const spinHere = rows === "all" || rowInBar === 0;
          const cell = {
            x: gutterClipped.x,
            y: gutterClipped.y + i,
            w: 1,
            h: 1,
          };
          if (spinHere) {
            paint.push({
              kind: "live",
              rect: cell,
              style: { ...style, bold: true },
              live,
            });
          } else {
            paint.push({
              kind: "text",
              rect: cell,
              lines: [" "],
              style: { ...style, bold: true },
            });
          }
        }
        if (paint.length > 0) {
          ctx.paintOrder.push({
            key: `${key}:glyph`,
            rect: gutterClipped,
            paint,
            clip: clipped,
          });
        }
      } else if (gutterClipped) {
        const gutterLines = indicationGutterLines(node, barH);
        if (gutterLines.length > 0) {
          const topSkip = Math.max(0, gutterClipped.y - gutterRect.y);
          const visibleGlyphs = gutterLines.slice(topSkip, topSkip + gutterClipped.h);
          ctx.paintOrder.push({
            key: `${key}:glyph`,
            rect: gutterClipped,
            paint: [
              {
                kind: "text",
                rect: gutterClipped,
                lines: visibleGlyphs,
                style,
              },
            ],
            clip: clipped,
          });
        }
      }
      const intent = inert ? "none" : (node.intent ?? "none");
      pushHit(ctx, key, clipped, intent, {
        userSelect,
        inert,
        onClick: node.onClick,
        kind: "indication",
        parent: parentKey,
      });
      const content: Rect = {
        x: rect.x + INDICATION_CONTENT_INSET,
        y: rect.y,
        w: contentW,
        h: barH,
      };
      let cy = content.y;
      let i = 0;
      for (const child of node.children ?? []) {
        const m = childMs[i++] ?? measureNode(child, content.w, 10_000, ctx);
        place(
          child,
          {
            x: content.x,
            y: cy,
            w: Math.min(content.w, m.w),
            h: m.h,
          },
          clipped,
          ctx,
          nextInherit,
          key,
        );
        cy += m.h;
      }
      break;
    }
    case "indentation_exception": {
      const clipped = intersect(rect, clip);
      if (clipped) {
        pushHit(ctx, key, clipped, "none", {
          kind: `indentation_exception:${node.kind}`,
          userSelect,
          inert,
          parent: parentKey,
        });
      }
      let cy = rect.y;
      for (const child of node.children ?? []) {
        const m = measureNode(child, rect.w, 10_000, ctx);
        place(
          child,
          {
            x: rect.x,
            y: cy,
            w: Math.min(rect.w, m.w),
            h: m.h,
          },
          clip,
          ctx,
          nextInherit,
          key,
        );
        cy += m.h;
      }
      break;
    }
    case "markdown": {
      const kids = markdownToNodes(node.content, {
        key: node.key ?? key,
        baseStyle: node.style,
      });
      let cy = rect.y;
      for (const child of kids) {
        const m = measureNode(child, rect.w, 10_000, ctx);
        place(
          child,
          {
            x: rect.x,
            y: cy,
            w: Math.min(rect.w, m.w),
            h: Math.max(1, m.h),
          },
          clip,
          ctx,
          nextInherit,
          key,
        );
        cy += Math.max(1, m.h);
      }
      break;
    }
    case "diff": {
      // Unexpanded hole — product always pre-expands. Occupy width, paint nothing.
      break;
    }
    case "chrome_frame": {
      // Special TEA strategy: fixed-width multi-role chrome (not flex).
      const clipped = intersect(rect, clip);
      if (!clipped) break;
      const m = measureNode(node, rect.w, rect.h, ctx);
      const placeRect: Rect = {
        x: rect.x,
        y: rect.y,
        w: Math.min(rect.w, m.w),
        h: Math.min(rect.h, m.h),
      };
      const { ops, bodyHit, progressHit } = chromeFramePaintOps(node, placeRect);
      if (ops.length > 0) {
        ctx.paintOrder.push({
          key: key ? `${key}:frame` : "chrome_frame:frame",
          rect: placeRect,
          paint: ops,
          clip,
        });
      }
      // Two hits, deliberately:
      //   1) full outer rect as userSelect:none chrome — top/bottom edges
      //      (╭─╮ / ╰─╯), side bars (│), mark col. Without this a
      //      selectable ancestor (storybook stage) claims border cells and
      //      free-text paints ─/│ into the highlight.
      //   2) body text column as contain (or none for placeholder) — the only
      //      selectable surface. chrome_mask restores leaf contain over the
      //      chrome stamp so draft text stays selectable/confined.
      // Key on the body hit stays the frame key (callers use "composer") for
      // caret park y/h + content-relative col.
      if (key) {
        const showingPh = isChromeFrameShowingPlaceholder(node);
        const chromeHit = intersect(placeRect, clip);
        const bodyVis = intersect(bodyHit, clip);
        if (chromeHit) {
          pushHit(ctx, `${key}:chrome`, chromeHit, "none", {
            userSelect: "none",
            inert,
            kind: "chrome_frame_chrome",
            parent: parentKey,
          });
        }
        if (bodyVis) {
          pushHit(ctx, key, bodyVis, "focus", {
            userSelect: node.bodyUserSelect ?? (showingPh ? "none" : "contain"),
            inert,
            kind: "chrome_frame",
            parent: parentKey,
          });
        }
        const progressVis = intersect(progressHit, clip);
        if (progressVis && progressVis.w > 0 && progressVis.h > 0) {
          pushHit(ctx, `${key}:progress`, progressVis, "none", {
            userSelect: "none",
            inert,
            kind: "chrome_frame_progress",
            parent: parentKey,
          });
        }
      }
      break;
    }
    case "disclosure": {
      const clipped = intersect(rect, clip);
      if (!clipped) break;
      const intent = inert ? "none" : (node.intent ?? "none");
      pushHit(ctx, key, clipped, intent, {
        userSelect,
        inert,
        onClick: node.onClick,
        kind: "disclosure",
        parent: parentKey,
      });
      const kids = node.collapsed === false ? (node.children ?? []) : [node.summary];
      let cy = rect.y;
      for (const child of kids) {
        const m = measureNode(child, rect.w, 10_000, ctx);
        if (cy + m.h <= clipped.y) {
          cy += m.h;
          continue;
        }
        if (cy >= clipped.y + clipped.h) break;
        place(
          child,
          {
            x: rect.x,
            y: cy,
            w: Math.min(rect.w, m.w),
            h: m.h,
          },
          clipped,
          ctx,
          nextInherit,
          key,
        );
        cy += m.h;
      }
      break;
    }
    case "overlay": {
      const full = intersect(rect, clip);
      if (!full) break;
      if (node.backdrop) {
        // Decision 1: content behind a modal is region-dimmed
        // (regionProminence) — the room recedes, identity stays visible.
        // Default (no backdropStyle): stamp the region onto every paint op
        // already in the order (base content). Overlay children place after
        // and keep full prominence. Explicit backdropStyle is painted
        // furniture the caller owns (bgRole + BgP or a literal wash) and
        // does not stamp — the scrim covers rather than fades.
        // Hit still registers so click-outside dismiss works either way.
        if (node.backdropStyle) {
          ctx.paintOrder.push({
            key: `${key}:backdrop`,
            rect,
            paint: [{ kind: "fill", rect, style: node.backdropStyle }],
            clip,
          });
        } else {
          stampBackdropRegion(ctx.paintOrder, BACKDROP_REGION_PROMINENCE);
        }
        pushHit(ctx, `${key}:backdrop`, full, node.intent ?? "dismiss", {
          kind: "overlay-backdrop",
          inert,
          onClick: node.onClick,
          parent: parentKey,
        });
      }
      const children = node.children ?? [];
      if (node.origin != null && children.length > 0) {
        const ox = rect.x + clamp0(node.origin.x);
        const oy = rect.y + clamp0(node.origin.y);
        for (const child of children) {
          const maxW = Math.max(0, rect.x + rect.w - ox);
          const maxH = Math.max(0, rect.y + rect.h - oy);
          const m = measureNode(child, maxW, maxH, ctx);
          place(child, { x: ox, y: oy, w: Math.min(maxW, m.w), h: Math.min(maxH, m.h) }, full, ctx, nextInherit, key);
        }
      } else if (node.center && children.length > 0) {
        const child = children[0]!;
        const m = measureNode(child, Math.floor(rect.w * 0.8), Math.floor(rect.h * 0.6), ctx);
        const cx = rect.x + Math.floor((rect.w - m.w) / 2);
        const cy = rect.y + Math.floor((rect.h - m.h) / 2);
        place(child, { x: cx, y: cy, w: m.w, h: m.h }, full, ctx, nextInherit, key);
      } else {
        let cy = rect.y + 1;
        for (const child of children) {
          const m = measureNode(child, rect.w - 2, rect.h, ctx);
          place(child, { x: rect.x + 1, y: cy, w: Math.min(rect.w - 2, m.w), h: m.h }, full, ctx, nextInherit, key);
          cy += m.h;
        }
      }
      break;
    }
  }

  if (node.regionProminence !== undefined) {
    stampBackdropRegion(ctx.paintOrder.slice(regionStart), node.regionProminence);
  }
  if (rect.y !== naturalY && node.type === "box" && node.style?.sticky === "top") {
    ctx.stuckLifts.push({
      paintAt: regionStart,
      paintTo: ctx.paintOrder.length,
      hitAt,
      hitTo: ctx.hitList.length,
    });
  }
  ctx.path = prevPath;
}

export function layout(root: LayoutNode, viewport: { w: number; h: number }, opts: LayoutOpts = {}): Frame {
  const measure = opts.measure ?? defaultMeasure;
  const ctx: Ctx = {
    measure,
    path: [],
    paintOrder: [],
    hitList: [],
    byKey: new Map(),
    counters: { invalidStyle: 0, frame: 0 },
    stuckLifts: [],
  };

  const w = Math.max(1, viewport.w);
  const h = Math.max(1, viewport.h);
  const rect: Rect = { x: 0, y: 0, w, h };
  place(root, rect, rect, ctx, { userSelect: "auto", inert: false });
  flushStuckLifts(ctx, 0);

  // hit list reverse paint for occlusion: reverse so later paint wins
  ctx.hitList.reverse();

  ctx.counters.frame += 1;
  const liveDemand = collectLiveDemand(ctx.paintOrder);
  return {
    version: opts.frameVersion ?? ctx.counters.frame,
    paintOrder: ctx.paintOrder,
    hitList: ctx.hitList,
    byKey: ctx.byKey,
    viewport: { w, h },
    liveDemand,
  };
}

export function elementAt(frame: Frame, x: number, y: number): { key: string; meta: HitMeta } | null {
  for (const meta of frame.hitList) {
    if (meta.inert) continue;
    if (!rectContains(meta.hitRect, x, y)) continue;
    if (meta.intent === "none" && meta.phantom) continue;
    // Union-correct check: "none"/"auto" are not hit-eligible on their own;
    // only {text, all, contain} admit a none-intent node (truthiness would admit them,
    // which incorrectly admitted the literal "none" string).
    if (meta.intent === "none" && !isSelectableHit(meta.userSelect) && !meta.onClick) continue;
    return { key: meta.key, meta };
  }
  // fallback: addressable box (byKey) containing point. Apply the SAME
  // admission gate as the primary path — otherwise chrome (userSelect:"none")
  // with no intent/onClick would be returned here, defeating the gate above.
  for (const meta of frame.byKey.values()) {
    if (!isAdmissibleHit(meta)) continue;
    if (!rectContains(meta.hitRect, x, y)) continue;
    return { key: meta.key, meta };
  }
  return null;
}

/**
 * Root→leaf chain of admissible hits at `(x, y)`, or `null` if nothing is
 * hittable there. The leaf is the same node {@link elementAt} returns
 * (topmost in paint order); the chain then walks `HitMeta.parent` up to the
 * root and is returned root-first.
 *
 * Structural selection (Phase 4) uses this to walk up the LayoutNode AST:
 * "expand selection from this cell to its containing block." Each link in the
 * returned chain passes the same admission gate as {@link elementAt}
 * (see {@link isAdmissibleHit}) — so a `userSelect:"none"` structural
 * container is traversed (its parent pointer is followed) but excluded from
 * the result, while selectable containers (`text` / `all` / `contain`) appear
 * so a caller can offer "select this block" at each level.
 *
 * Parent links resolve via {@link Frame.byKey}; the walk terminates when a
 * parent key is absent (e.g. a flex container, which is structural but not in
 * byKey) or undefined (the root). A cycle guard caps the walk at the frame's
 * byKey size to defend against malformed parent loops.
 */
export function elementAtPath(frame: Frame, x: number, y: number): Array<{ key: string; meta: HitMeta }> | null {
  const leaf = elementAt(frame, x, y);
  if (!leaf) return null;

  // Walk parent pointers from the leaf upward. Collect every meta; admission
  // filtering happens after the walk so a non-admissible structural container
  // (chrome) still links its selectable descendants to their grand-parents.
  const chain: Array<{ key: string; meta: HitMeta }> = [];
  const seen = new Set<string>();
  let cur: HitMeta | undefined = leaf.meta;
  // Cap at byKey.size + 1 so a malformed parent loop can't spin forever; +1
  // covers the leaf itself before any parent is entered.
  const cap = frame.byKey.size + 1;
  let steps = 0;
  while (cur && steps < cap) {
    if (seen.has(cur.key)) break;
    seen.add(cur.key);
    chain.push({ key: cur.key, meta: cur });
    steps++;
    const parentKey = cur.parent;
    if (parentKey === undefined) break;
    cur = frame.byKey.get(parentKey);
  }

  // Root-first order, then drop non-admissible structural containers
  // (chrome userSelect:"none", phantoms). The leaf itself is always kept —
  // elementAt already admitted it.
  chain.reverse();
  return chain.filter((link, idx) => idx === chain.length - 1 || isAdmissibleHit(link.meta));
}

/**
 * Nearest `userSelect: "contain"` region covering `(x, y)`, if any.
 * Walks the root→leaf hit path from the leaf upward so nested contain boxes
 * pick the innermost (composer inside a larger pane).
 *
 * Used by the gesture machine to arm confinement: once a drag starts inside
 * a contain region, endpoints are clamped to {@link ContainRegion.rect}.
 */
export function containRegionAt(frame: Frame, x: number, y: number): { key: string; rect: Rect } | null {
  const path = elementAtPath(frame, x, y);
  if (!path || path.length === 0) return null;
  // Leaf-first search for the innermost contain.
  for (let i = path.length - 1; i >= 0; i--) {
    const link = path[i]!;
    if (link.meta.userSelect === "contain") {
      const r = link.meta.hitRect;
      return { key: link.key, rect: { x: r.x, y: r.y, w: r.w, h: r.h } };
    }
  }
  return null;
}
