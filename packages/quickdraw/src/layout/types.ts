import type { Length } from "./length.js";
import { ChromeQuotaWindow, LiveDemand, LivePaint, SpinnerProfile } from "./live_paint.js";
import type { ChromeHotkey } from "./paint-hotkey.js";
import type { Buffer, Style } from "../buffer/index.js";

export type Rect = { x: number; y: number; w: number; h: number };

export type Intent = "activate" | "dismiss" | "focus" | "none";

/**
 * CSS `user-select` parity — inline attribute (no rulesets yet). The same node
 * tree must render with identical selectability in terminal and web.
 *
 * - `"auto"`     — inherits (default; resolves per-context like the CSS value)
 * - `"text"`     — selectable content (transcript body, composer body)
 * - `"none"`     — chrome (borders, gutters, status bars, animations);
 *                  excluded from selection and from clipboard serialization
 * - `"all"`      — whole-element selection: a click/selection snaps to the
 *                  entire node, no partial range (Notion-block / Warp-block)
 * - `"contain"`  — selection is confined within this node and may not extend
 *                  into siblings (the composer `<textarea>`-confinement case)
 *
 * Engine semantics: a node with `userSelect` in {text, all, contain} is
 * eligible for the hitlist even when `intent === "none"` (so a drag can start
 * a selection on it). `"none"` and `"auto"` (defaulting to non-selectable at
 * the root) are NOT hit-eligible on their own. Inheritance follows CSS:
 * children inherit the parent's value unless they override.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/CSS/user-select
 */
export type UserSelect = "auto" | "text" | "none" | "all" | "contain";

export type Overflow = "visible" | "hidden" | "clip" | "auto" | "scroll";
export type OverflowAnchor = "auto" | "none";

export type BoxStyle = {
  width?: Length;
  height?: Length;
  minWidth?: Length;
  minHeight?: Length;
  maxWidth?: Length;
  maxHeight?: Length;
  padding?: number | { t?: number; r?: number; b?: number; l?: number };
  border?: boolean;
  background?: Style;
  overflow?: Overflow;
  overflowX?: Overflow;
  overflowY?: Overflow;
  flex?: number | { grow?: number; shrink?: number; basis?: Length };
  flexGrow?: number;
  flexShrink?: number;
  flexBasis?: Length;
  alignSelf?: "flex_start" | "flex_end" | "center" | "stretch";
  margin?: number;
  /**
   * `bottom` — pull into the clip when the box would paint below it.
   * `top` — pin to the clip top once the box's top edge scrolls above it,
   * until the next sticky sibling pushes it out. A pin taller than the room
   * left under that floor squeezes to its first content row instead of
   * blanketing the viewport or scrolling away.
   */
  sticky?: "bottom" | "top";
  /**
   * Clip squeeze: pin first `head` children at the overlay top, last `tail`
   * at the bottom, and elide the rest behind `·· N lines omitted ··`. Natural
   * height stays the sum of children. Ask Diff uses `{ head: 4, tail: 4 }`.
   */
  squeeze?: { head: number; tail: number };
};

export type FlexStyle = {
  direction?: "row" | "column" | "row_reverse" | "column_reverse";
  gap?: number;
  justifyContent?: "flex_start" | "flex_end" | "center" | "space_between" | "space_around" | "space_evenly";
  alignItems?: "flex_start" | "flex_end" | "center" | "stretch";
  padding?: number | { t?: number; r?: number; b?: number; l?: number };
  width?: Length;
  height?: Length;
};

/**
 * CSS-grid subset (cell tracks). Children are row-major cells.
 * `columns.length` is the column count; rows = ceil(children / cols).
 *
 * `lines: "inner"` paints │ / ─ / ┼ only between tracks — no outer box.
 */
export type GridStyle = {
  columns: Length[];
  /** Default 1 when `lines: "inner"`, else 0. */
  columnGap?: number;
  /** Default 1 when `lines: "inner"`, else 0. */
  rowGap?: number;
  lines?: "none" | "inner";
  /** Style for inner bars — keep dim / low-fg for subtle chrome. */
  lineStyle?: Style;
  /**
   * Padding inside each cell (cells). Tables use `{ x: 1 }` so text breathes
   * off the bars without inventing outer margins.
   */
  cellPad?: number | { x?: number; y?: number };
  width?: Length;
  height?: Length;
};

/** Layout-local bag. Not ComposerCommandChoice — do not import widgets. */
export type ChromeFramePickerRow = {
  key?: string;
  name: string;
  status?: string;
  annotation?: string;
  description?: string;
  actionDisplayName?: string;
  actions?: ReadonlyArray<{ name: string; displayName: string; hotkey?: string }>;
  href?: string;
};

/**
 * Host-only stamps. expandWidgetPriors returns a paint-ready node immediately.
 * `measured` is the width-tagged stamp from the last prepare. `atW` is the
 * `maxW` that produced `w`/`h` — measure honors the stamp only at that width.
 */
export type PaintReadyMark = {
  regionProminence?: number;
  paintReady?: true;
  measured?: { w: number; h: number; atW?: number };
};

/**
 * Composer status-rail chip. A bare string is furniture (contour voice).
 * `{ text, role }` is a signal — hue on the role, default prominence secondary.
 */
export type ChromeStatusChip = {
  text: string;
  role?: string;
  prominence?: number;
};
export type ChromeStatusItem = string | ChromeStatusChip;

export type LayoutNode = PaintReadyMark &
  (
    | {
        type: "box";
        style?: BoxStyle;
        children?: LayoutNode[];
        id?: string;
        key?: string;
        intent?: Intent;
        userSelect?: UserSelect;
        inert?: boolean;
        onClick?: unknown;
        /**
         * Diff logical line stamp — scoped onto descendant hits (like grid
         * tableCell). Source of truth for git-format copy; paint may ellipsize.
         */
        diffLine?: DiffLineRef;
      }
    | {
        type: "flex";
        style?: FlexStyle;
        children?: LayoutNode[];
        key?: string;
      }
    | {
        type: "grid";
        style: GridStyle;
        children?: LayoutNode[];
        key?: string;
      }
    | {
        type: "text";
        content: string;
        whiteSpace?: "normal" | "nowrap" | "pre-wrap" | "pre-line";
        ellipsis?: boolean;
        lineClamp?: number;
        style?: Style;
        key?: string;
        userSelect?: UserSelect;
        /**
         * When set, paint resolves label from wall clock (content is measure
         * placeholder only). Present demand via Frame.liveDemand.
         */
        live?: LivePaint;
      }
    | {
        type: "viewport";
        id: string;
        key?: string;
        children?: LayoutNode[];
        overflowAnchor?: OverflowAnchor;
        overflowX?: Overflow;
        overflowY?: Overflow;
        /**
         * First visible content row when overflow-anchor is `none`.
         * Layout stacks children vertically and offsets by this many rows.
         * Ignored when overflow-anchor is `auto` (pin to bottom).
         */
        scroll?: number;
        style?: BoxStyle;
      }
    | {
        type: "raw";
        paint: (rect: Rect, buf: Buffer) => void;
        key?: string;
        intent?: Intent;
        w?: number;
        h?: number;
      }
    | {
        /**
         * Law 6: `[lead][gutter|void][gap][content]` — content at column 3.
         *
         * Gutter:
         * - `{ kind: "top", glyph }` — first row only (collapsed ⁖, user ❯)
         * - `{ kind: "rule", glyph }` — same glyph every row (blockquote │,
         *   expanded extra ┃)
         * - `{ kind: "corners", top, bottom?, mid? }` — range (omit bottom
         *   while open)
         * - `{ kind: "spinner", profile?, rows? }` — paint-side spinner
         */
        type: "indication";
        key?: string;
        gutter:
          | { kind: "top"; glyph: string }
          | { kind: "rule"; glyph: string }
          | {
              kind: "corners";
              top: string;
              /** Last-row glyph; omit while open/live (no closer yet). */
              bottom?: string | null;
              /** Interior rows (default `·`). */
              mid?: string;
            }
          | {
              kind: "spinner";
              /** Semantic profile (thinking / tool / working). Default working. */
              profile?: SpinnerProfile;
              /** `top` (default) = first row only; `all` = every bar row. */
              rows?: "top" | "all";
            };
        children?: LayoutNode[];
        style?: Style;
        intent?: Intent;
        onClick?: unknown;
        /**
         * Selection eligibility. Thought chrome uses `"none"` so bare click
         * activates collapse instead of starting a text selection.
         */
        userSelect?: UserSelect;
      }
    | {
        /**
         * Law 6 exception: full-bleed body (must declare kind).
         * Only allowlisted kinds may use this (diff, etc.).
         */
        type: "indentation_exception";
        key?: string;
        kind: "diff" | "code_pad" | "raw_full";
        children?: LayoutNode[];
      }
    | {
        /**
         * Absolute overlay layer. Placed after base children in paint order.
         * `backdrop: true` with no `backdropStyle` stamps `regionProminence`
         * onto every paint op already in the order (decision 1: the room
         * recedes, identity stays visible — no scrim rect). Overlay children
         * place after the stamp and stay full-prominence. Pass `backdropStyle`
         * only for explicit painted furniture (bgRole + BgP or a literal
         * wash); that path paints a fill and does not stamp.
         */
        type: "overlay";
        key?: string;
        /** center child in viewport when true */
        center?: boolean;
        /**
         * Overlay-local origin for children. Wins over `center` and the
         * default top-left stack. Used to seat a plaque next to an already
         * laid-out anchor (copy-toast grain, in-tree).
         */
        origin?: { x: number; y: number };
        backdrop?: boolean;
        /** Explicit painted backdrop furniture — must set bg (or bgRole) if used. */
        backdropStyle?: Style;
        children?: LayoutNode[];
        intent?: Intent;
        onClick?: unknown;
      }
    | {
        /**
         * Host-local `<details>`: TEA/MobX ship both branches; the renderer
         * flips `collapsed`. Layout measures summary XOR children — never both.
         */
        type: "disclosure";
        key?: string;
        /** Default true (summary visible). Host collapse map overrides this flag. */
        collapsed?: boolean;
        summary: LayoutNode;
        children?: LayoutNode[];
        intent?: Intent;
        onClick?: unknown;
        userSelect?: UserSelect;
      }
    | {
        /** Markdown prior — render expands via widgets/expand (SMD). */
        type: "markdown";
        key?: string;
        content: string;
        style?: Style;
      }
    | {
        /** Pierre diff prior — render expands via widgets/expand. */
        type: "diff";
        key?: string;
        old: string;
        new: string;
        width: number;
        path?: string;
        language?: string | null;
        mode?: "auto" | "unified" | "split";
        /** Paint-time elision after whole-file parse + highlight. `"all"` keeps every line. */
        context?: number | "all";
        lineDiffType?: "word-alt" | "word" | "char" | "none";
        noHighlight?: boolean;
        hideHeader?: boolean;
        /**
         * Ask Diff: pin this many body rows at each end and squeeze the
         * middle (`·· N lines omitted ··`). In-tape Diff omits this.
         */
        stickyBottomRows?: number;
        /** 1-based file line of the first displayed row. Span diffs default to 1. */
        lineStart?: number;
      }
    | {
        /**
         * Boxed prompt chrome — special measure/place/paint lineage
         * (see chrome_frame.ts). Not flex assembly.
         *
         * Fixed outer width; multi-role top/bottom edges; body `│  draft │`.
         * `key` hits the **body** rect (caret park); frame paint is under
         * `${key}:frame` when key is set.
         */
        type: "chrome_frame";
        key?: string;
        width: number;
        draft: string;
        cursor?: number;
        mark?: number | null;
        placeholder?: string;
        placeholderMode?: boolean;
        hotkeys?: readonly ChromeHotkey[] | null;
        hotkeysBottom?: boolean;
        modHeld?: boolean;
        topSegs?: Array<{
          text: string;
          role?: string;
          prominence?: number;
          bold?: boolean;
          dim?: boolean;
          underline?: boolean;
          href?: string;
        }>;
        bodySegRows?: Array<
          Array<{
            text: string;
            role?: string;
            prominence?: number;
            bold?: boolean;
            dim?: boolean;
            italic?: boolean;
            underline?: boolean;
            href?: string;
            fgRgb?: { r: number; g: number; b: number };
          }>
        >;
        bodyGlyphs?: string[];
        speculativeDraft?: string;
        completion?: string;
        annotation?: string | null;
        annotationRole?: string;
        /** T-join right-rail when stacked. ╭╮ keeps {@link annotation}. */
        joinAnnotation?: string | null;
        joinAnnotationRole?: string;
        statusItems?: ChromeStatusItem[];
        quotaWindows?: ChromeQuotaWindow[];
        contextUsed?: number;
        contextLimit?: number;
        contourRole?: string;
        selected?: boolean;
        progress?: number;
        progressRole?: string;
        progressGlowAt?: number;
        progressAnnotation?: string | null;
        glyph?: string;
        interactive?: boolean;
        readOnly?: boolean;
        joinBottom?: boolean;
        joinTop?: boolean;
        omitTop?: boolean;
        plainBottom?: boolean;
        bodyUserSelect?: UserSelect;
        bodyRightCoverage?: number[];
        picker?: {
          rows: readonly ChromeFramePickerRow[];
          selectedKey: string | null;
          scrollOffset: number;
          viewport: number;
        };
      }
  );

/**
 * Grid cell identity for semantic copy (minimal markdown tables).
 * Set on hits placed as children of `type: "grid"`.
 */
export type TableCellRef = {
  gridKey: string;
  row: number;
  col: number;
  nCols: number;
  nRows: number;
};

/**
 * Diff logical line for git-format selection copy + split mirror paint.
 *
 * Painted buffer may be a lie (▌, line numbers, soft-wrap).
 * `text` is the full source line — wrong-copy is impossible when serialize
 * rebuilds from this stamp (same class as tableCell).
 *
 * - `lineIndex` — document / git emission order (not split visual row order)
 * - `side` — split half; context L/R share lineIndex so copy dedups and
 *   paint can mirror; change lines do not share lineIndex across sides
 */
export type DiffLineRef = {
  diffKey: string;
  lineIndex: number;
  kind: "ctx" | "del" | "add";
  /** Full raw line (no git prefix). */
  text: string;
  /** Split only: which visual half this hit belongs to. */
  side?: "L" | "R";
  oldNo?: number | null;
  newNo?: number | null;
};

export type HitMeta = {
  key: string;
  hitRect: Rect;
  intent: Intent;
  userSelect: UserSelect;
  inert: boolean;
  onClick?: unknown;
  element?: {
    kind: string;
    /** Viewport: first visible content row after clamp. */
    scrollY?: number;
    /** Viewport: max first-visible row (`max(0, contentH - viewportH)`). */
    maxScroll?: number;
  };
  /** true for flex/gap phantom containers */
  phantom?: boolean;
  /**
   * Parent hit key (the enclosing node's key in {@link Frame.byKey}), or
   * undefined for the root. Used by `elementAtPath` to reconstruct the
   * root→leaf chain for structural selection (Phase 4): "expand selection
   * from this cell to its containing block."
   *
   * This is a key reference, not a pointer — resolve via `frame.byKey`.
   * Phantom containers (flex/gap, grid) carry parent too so a chain can
   * pass through them; admission gating in `elementAtPath` decides whether
   * they appear in the returned chain.
   */
  parent?: string;
  /**
   * When set, this hit is a grid cell — copy serializes to compact markdown
   * instead of the full terminal padding/separator run.
   */
  tableCell?: TableCellRef;
  /**
   * When set, this hit is a diff line (or fragment of a soft-wrapped line).
   * Copy rebuilds git-format lines; split context mirrors via shared lineIndex.
   */
  diffLine?: DiffLineRef;
};

export type PaintOp =
  | { kind: "text"; rect: Rect; lines: string[]; style: Style }
  | { kind: "border"; rect: Rect; style: Style }
  | { kind: "fill"; rect: Rect; style: Style }
  | { kind: "raw"; rect: Rect; paint: (rect: Rect, buf: Buffer) => void }
  /**
   * Live decoration — resolved at paintFrame(nowMs), not at layout.
   * Geometry is fixed; glyph/label is wall-clock pure. Present uses
   * Frame.liveDemand.maxHz for fps-on-demand.
   */
  | {
      kind: "live";
      rect: Rect;
      style: Style;
      live: LivePaint;
      /** Source text for `live.kind === "birth"` — paint applies the wavefront. */
      content?: string;
    };

export type Positioned = {
  key?: string;
  /** Allocation (wrap, birth, border, bgFx UV). */
  rect: Rect;
  paint: PaintOp[];
  /** Nested scissor. Paint writes `op.rect ∩ clip ∩ buffer`. Omitted ⇒ no extra scissor. */
  clip?: Rect;
};

export type Frame = {
  version: number;
  paintOrder: Positioned[];
  hitList: HitMeta[];
  /** Named geometry for hosts: `byKey.get(k)?.hitRect` (includes non-hittable chrome). */
  byKey: Map<string, HitMeta>;
  viewport: { w: number; h: number };
  /**
   * Present demand from live paint ops (spinners, elapsed labels).
   * maxHz === 0 → no live present needed for decoration.
   */
  liveDemand?: LiveDemand;
};

/**
 * Paint-time theme hook — always carries a ColorResolver.
 * Role/bgRole intent only becomes SGR fields through `resolveStyle`; there is
 * no identity fallback. Pass `attuneTheme(...).paint`, or omit the paintFrame
 * theme arg to use ambient `paintTheme()`. Empty `{}` is not assignable.
 */
export type Theme = {
  resolveStyle: (style: Style) => Style;
};

export type LayoutOpts = {
  /** injected text measure; default display columns via ../measure/index.js */
  measure?: (text: string) => number;
  frameVersion?: number;
};
