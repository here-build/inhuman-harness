import { agentsRowKeyFromHit } from "./agents_keys.js";
import type { EchoState } from "./echo.js";
import { createBuffer, type Buffer } from "../buffer/index.js";
import {
  layout,
  layoutChildren,
  mapLayoutChildren,
  paintFrame,
  type ChromeHotkey,
  type Frame,
  type LayoutNode,
  type Theme as PaintTheme,
} from "../layout/index.js";
import { FgP } from "../lexicon/index.js";
import { expandWidgetPriors } from "../widgets/expand.js";

/**
 * Protocol-free paint view of the mirrors — not BoxMailbox (no structureGen / Map / protocol).
 *
 * `getBox` must be pure over the snapshot for one `renderFrame` call (I8 / F11).
 * The mailbox adapter projects a frozen Map view each tick.
 */
/**
 * Purity contract: an implementation must answer identically for the same
 * `id` for the snapshot's lifetime — a stateful `getBox` makes `renderFrame`
 * non-deterministic and no gate would see it. The mailbox adapter gets this
 * from `BoxMailbox`'s copy-on-write.
 */
export interface PaintSnapshot {
  readonly tree: unknown;
  getBox(id: number): unknown;
}

/** Terminal size — owned by the UI thread; read, never derived, here. */
export interface Geometry {
  readonly cols: number;
  readonly rows: number;
}

/**
 * Explicit state beside the mirrors. Anything else is mailbox-derived (worker)
 * or a phase (collapse) — anti-spec §4.5 to hold it here.
 */
export interface FrameState {
  readonly nowMs: number;
  readonly echo: EchoState;
  /** Passed in so this module stays free of theme/surface state (F11). */
  readonly theme?: PaintTheme;
  /**
   * Host lifecycle chrome (e.g. Ctrl+C exit) — overrides chrome_frame
   * hotkeys after substitution; must not wait for a worker round-trip.
   */
  readonly hostHotkeys?: readonly ChromeHotkey[] | null;
  /** Host-stepped birth wavefront W, keyed by live.siteId. */
  readonly birth?: ReadonlyMap<string, number>;
  /**
   * Host-eased progress (key → displayed 0..1 + role). Injected before
   * layout so the bar samples the interpolant, not the target jump.
   */
  readonly progress?: ReadonlyMap<string, { displayed: number; role?: string }>;
  /** Last mouse cell is over a chrome_frame progress hit — swap annotation. */
  readonly hoverProgress?: boolean;
  /**
   * Host pointer chrome for an already-windowed picker body.
   * Restyles hover/press only — does not re-window.
   */
  readonly pickerChrome?: {
    readonly hoverKey: string | null;
    readonly pressKey: string | null;
  };
  /** Host-local agents-row hover. Worker focus remains authoritative for actions. */
  readonly agentsChrome?: {
    readonly hoverKey: string;
  };
}

export interface FrameInputs {
  readonly snapshot: PaintSnapshot;
  readonly geometry: Geometry;
  readonly state: FrameState;
}

export interface FrameOutput {
  readonly buffer: Buffer;
  /**
   * Painted layout for click hit-testing (§1 admits only this to the UI thread
   * on performance grounds). `null` before first structure (boot frame).
   */
  readonly frame: Frame | null;
}

interface StructureTree {
  readonly root: LayoutNode;
  readonly boxes: Readonly<Record<string, number>>;
}

/**
 * Mailbox stores tree as `unknown` (protocol §4 opaque). Malformed → boot frame,
 * never throw: a paint loop that dies on a message stops repainting the last
 * good frame (F2 by another door).
 */
function asTree(value: unknown): StructureTree | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { root?: unknown; boxes?: unknown };
  if (typeof record.root !== "object" || record.root === null) return null;
  if (typeof record.boxes !== "object" || record.boxes === null) return null;
  return { root: record.root as LayoutNode, boxes: record.boxes as Record<string, number> };
}

function asNode(value: unknown): LayoutNode | null {
  if (typeof value !== "object" || value === null) return null;
  return typeof (value as { type?: unknown }).type === "string" ? (value as LayoutNode) : null;
}

function isPaintReady(node: LayoutNode): boolean {
  return node.paintReady === true;
}

/** Speculative draft overlay — inform paint; draft stays authoritative. */
function withEcho(node: LayoutNode, boxId: number, echo: EchoState): LayoutNode {
  if (isPaintReady(node)) return node;
  if (echo.predicted === null || echo.boxId !== boxId) return node;
  // Composer may be a stack (slash strip + chrome_frame) — walk children.
  if (node.type === "chrome_frame" && !Array.isArray(node.bodySegRows)) {
    const p = echo.predicted;
    return {
      ...node,
      speculativeDraft: p.draft,
      cursor: p.cursor,
      mark: p.mark,
    };
  }
  if (layoutChildren(node).length === 0) return node;
  return mapLayoutChildren(node, (child) => withEcho(child, boxId, echo));
}

/** Overlay host lifecycle bindings onto the strip (left), not the annotation. */
function withHostHotkeys(node: LayoutNode, hotkeys: readonly ChromeHotkey[]): LayoutNode {
  // paintReady skips mailbox/echo, not host chrome. Product stamps the
  // composer subtree ready; Ctrl+C: exit must still reach chrome_frame.
  if (node.type === "chrome_frame") {
    return { ...node, hotkeys };
  }
  if (layoutChildren(node).length === 0) return node;
  return mapLayoutChildren(node, (child) => withHostHotkeys(child, hotkeys));
}

function withProgressDisplay(
  node: LayoutNode,
  progress: ReadonlyMap<string, { displayed: number; role?: string }>,
): LayoutNode {
  if (isPaintReady(node)) return node;
  if (node.type === "chrome_frame") {
    const key = node.key;
    const shown = key ? progress.get(key) : undefined;
    if (!shown) return node;
    return {
      ...node,
      progress: shown.displayed,
      progressRole: shown.role,
    };
  }
  if (layoutChildren(node).length === 0) return node;
  return mapLayoutChildren(node, (child) => withProgressDisplay(child, progress));
}

function withHoverProgressAnnotation(node: LayoutNode): LayoutNode {
  if (isPaintReady(node)) return node;
  if (node.type === "chrome_frame") {
    const swap = (node.progressAnnotation ?? "").trim();
    if (!swap) return node;
    return { ...node, annotation: swap };
  }
  if (layoutChildren(node).length === 0) return node;
  return mapLayoutChildren(node, (child) => withHoverProgressAnnotation(child));
}

type PickerBodySeg = {
  text: string;
  role?: string;
  prominence?: number;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
  href?: string;
};

type PickerNameKind = "selected" | "press-full" | "half" | "idle";

/** Same matrix as paintPicker — restyle existing rows, never re-slice. */
function pickerNameKind(
  key: string | null,
  chrome: { hoverKey: string | null; pressKey: string | null },
  selectedKey: string | null,
): PickerNameKind {
  if (key != null && selectedKey != null && key === selectedKey) return "selected";
  if (key != null && chrome.pressKey != null && key === chrome.pressKey && chrome.hoverKey === chrome.pressKey) {
    return "press-full";
  }
  if (key != null && (key === chrome.hoverKey || key === chrome.pressKey)) return "half";
  return "idle";
}

function pickerNameStyle(kind: PickerNameKind): {
  role: string;
  prominence: number;
  bold?: boolean;
} {
  if (kind === "selected" || kind === "press-full") {
    return { role: "foreground", prominence: FgP.primary, bold: true };
  }
  if (kind === "half") {
    return { role: "muted", prominence: FgP.secondary };
  }
  return { role: "muted", prominence: FgP.ghost };
}

function pickerDescStyle(kind: PickerNameKind): { role: string; prominence: number } {
  if (kind === "idle") {
    return { role: "muted", prominence: FgP.ghost };
  }
  return { role: "muted", prominence: FgP.secondary };
}

function isPickerHrefRow(row: readonly PickerBodySeg[]): boolean {
  const first = row[0];
  if (!first) return false;
  if (typeof first.href === "string" && first.href.length > 0) return true;
  return first.underline === true && first.role === "accent";
}

function paintRowKeysFromPicker(
  picker: NonNullable<Extract<LayoutNode, { type: "chrome_frame" }>["picker"]>,
): readonly (string | null)[] {
  const n = picker.rows.length;
  const v = picker.viewport;
  const maxS = Math.max(0, n - v);
  const scroll = Math.min(maxS, Math.max(0, picker.scrollOffset));
  const visible = picker.rows.slice(scroll, scroll + v);
  const keys: Array<string | null> = [];
  for (const row of visible) {
    const key = row.key ?? null;
    keys.push(key);
    if ((row.href ?? "").trim().length > 0) keys.push(key);
  }
  return keys;
}

function restylePickerNameRow(row: PickerBodySeg[], kind: PickerNameKind): PickerBodySeg[] {
  const left = pickerNameStyle(kind);
  const right = pickerDescStyle(kind);
  return row.map((seg, i) => {
    if (i === 0) {
      const next: PickerBodySeg = {
        ...seg,
        role: left.role,
        prominence: left.prominence,
      };
      if (left.bold) next.bold = true;
      else delete next.bold;
      return next;
    }
    if (i === row.length - 1 && row.length >= 3) {
      return { ...seg, role: right.role, prominence: right.prominence };
    }
    return seg;
  });
}

function withPickerChrome(node: LayoutNode, chrome: { hoverKey: string | null; pressKey: string | null }): LayoutNode {
  if (isPaintReady(node)) return node;
  if (node.type === "chrome_frame" && (node.key === "slash-complete" || node.picker)) {
    const bodySegRows = node.bodySegRows;
    if (!bodySegRows || bodySegRows.length === 0 || !node.picker) return node;
    const keys = paintRowKeysFromPicker(node.picker);
    const selectedKey = node.picker.selectedKey;
    const nextSegs = bodySegRows.map((row, i) => {
      if (isPickerHrefRow(row)) return row;
      const kind = pickerNameKind(keys[i] ?? null, chrome, selectedKey);
      return restylePickerNameRow(row, kind);
    });
    const glyphs = node.bodyGlyphs ?? bodySegRows.map(() => " ");
    const nextGlyphs = glyphs.map((glyph, i) => {
      if (isPickerHrefRow(bodySegRows[i] ?? [])) return glyph;
      const kind = pickerNameKind(keys[i] ?? null, chrome, selectedKey);
      return kind === "selected" ? "›" : " ";
    });
    return { ...node, bodySegRows: nextSegs, bodyGlyphs: nextGlyphs };
  }
  if (layoutChildren(node).length === 0) return node;
  return mapLayoutChildren(node, (child) => withPickerChrome(child, chrome));
}

/** Restyle session names from pointer state without waiting for a worker paint patch. */
function withAgentsChrome(node: LayoutNode, hoverKey: string): LayoutNode {
  const key = "key" in node && typeof node.key === "string" ? node.key : "";
  let next = node;
  if (node.type === "text" && key.endsWith(":name")) {
    const rowKey = agentsRowKeyFromHit(key);
    if (rowKey !== null) {
      next = {
        ...node,
        style: {
          ...node.style,
          role: "foreground",
          prominence: rowKey === hoverKey ? FgP.primary : FgP.rising,
        },
      };
    }
  }
  return mapLayoutChildren(next, (child) => withAgentsChrome(child, hoverKey));
}

/**
 * Splice mirror values into named content sites.
 * Recursion, not mutation: mailbox tree is re-rendered every frame the worker
 * does not replace it; in-place edit would introduce the memory F11 guards against.
 */
function substitute(
  node: LayoutNode,
  boxes: Readonly<Record<string, number>>,
  getBox: (id: number) => unknown,
  echo: EchoState,
): LayoutNode {
  if (isPaintReady(node)) return node;
  const key = "key" in node ? node.key : undefined;
  const boxId = typeof key === "string" ? boxes[key] : undefined;
  if (boxId !== undefined) {
    const value = asNode(getBox(boxId));
    // Unfilled site → empty children (structure reserved space; one-batch-behind
    // box_set must not make layout jump).
    return { ...node, children: value === null ? [] : [withEcho(value, boxId, echo)] } as LayoutNode;
  }
  return mapLayoutChildren(node, (child) => substitute(child, boxes, getBox, echo));
}

/** Mirrors + geometry + state → painted buffer. */
export function renderFrame(inputs: FrameInputs): FrameOutput {
  const { snapshot, geometry, state } = inputs;
  const cols = Math.max(1, Math.floor(geometry.cols));
  const rows = Math.max(1, Math.floor(geometry.rows));
  const buffer = createBuffer(cols, rows);

  const tree = asTree(snapshot.tree);
  if (tree === null) return { buffer, frame: null };

  let root = substitute(tree.root, tree.boxes, (id) => snapshot.getBox(id), state.echo);
  if (state.hostHotkeys && state.hostHotkeys.length > 0) {
    root = withHostHotkeys(root, state.hostHotkeys);
  }
  if (state.progress && state.progress.size > 0) {
    root = withProgressDisplay(root, state.progress);
  }
  if (state.hoverProgress) root = withHoverProgressAnnotation(root);
  if (state.pickerChrome) root = withPickerChrome(root, state.pickerChrome);
  if (state.agentsChrome) root = withAgentsChrome(root, state.agentsChrome.hoverKey);
  root = expandWidgetPriors(root, { width: cols });
  const frame = layout(root, { w: cols, h: rows });
  // Omit theme → ambient paintTheme(); production passes explicit binding.
  paintFrame(frame, buffer, state.theme, {
    nowMs: state.nowMs,
    birth: state.birth,
  });
  return { buffer, frame };
}
