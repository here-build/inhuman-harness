/**
 * Structural retained-paint seam. Quickdraw never imports MST or harness
 * node types. The host implements RetainedPaintSource.
 *
 * After bind, cadence reads {@link RetainedPaintSource.snapshot} — the live
 * projection. `prepare()` is the pull fallback (mailbox / tests). Do not
 * rebuild the tree from a timer; a `@computed` snapshot is the cache.
 */
import { observable, runInAction } from "mobx";

import { withAgentsPeek } from "./agents_peek.js";
import { APP_AGENTS_PREVIEW_VIEWPORT_KEY, withAgentsPreview } from "./agents_preview.js";
import type { BirthSite } from "./thought_birth.js";
import type { DraftState } from "../input/index.js";
import type { ProgressSite } from "../layout/progress.js";
import type { LayoutNode } from "../layout/types.js";
import { BgP, FgP } from "../lexicon/index.js";

export interface PaintSink {
  requestPaint(): void;
}

export interface EchoFace {
  predicted: DraftState | null;
  misaligned: boolean;
}

/**
 * One instance per TUI process. Cadence writes cols/rows. The harness
 * composer-echo reaction writes echo. Collapse/selection live on MountLocal.
 */
export interface PaintLocal {
  cols: number;
  rows: number;
  echo: EchoFace;
  /** Cmd/Ctrl is down — chrome hint shows the modifier layer. */
  modHeld: boolean;
  /** First visible transcript row when not following the tail. */
  tapeScroll: number;
  /**
   * Follow new tape rows iff true. Default true. Present-side flag —
   * the engine viewport stays `overflowAnchor: "none"`.
   */
  tapeAtBottom: boolean;
  /**
   * Compact (default): tool/scheme rows omitted (live included — a
   * one-frame live row that then seals is a flash). Loop pulse stays.
   * Expanded: identity rows sit after the glued thought span.
   */
  tapeExpanded: boolean;
  /** First visible sneak-peek tape row when not following the tail. */
  previewScroll: number;
  /** Follow new sneak-peek tape rows iff true. Default true. */
  previewAtBottom: boolean;
}

export function createPaintLocal(cols = 80, rows = 24): PaintLocal {
  return observable({
    cols,
    rows,
    echo: { predicted: null, misaligned: false },
    modHeld: false,
    tapeScroll: 0,
    tapeAtBottom: true,
    tapeExpanded: false,
    previewScroll: 0,
    previewAtBottom: true,
  });
}

export function writePaintEcho(local: PaintLocal, echo: EchoFace): void {
  runInAction(() => {
    local.echo = echo;
  });
}

export function writePaintModHeld(local: PaintLocal, modHeld: boolean): void {
  if (local.modHeld === modHeld) return;
  runInAction(() => {
    local.modHeld = modHeld;
  });
}

export function writePaintTapeExpanded(local: PaintLocal, tapeExpanded: boolean): void {
  if (local.tapeExpanded === tapeExpanded) return;
  runInAction(() => {
    local.tapeExpanded = tapeExpanded;
  });
}

export function writePaintTapeScroll(local: PaintLocal, tapeScroll: number, tapeAtBottom: boolean): void {
  if (local.tapeScroll === tapeScroll && local.tapeAtBottom === tapeAtBottom) return;
  runInAction(() => {
    local.tapeScroll = tapeScroll;
    local.tapeAtBottom = tapeAtBottom;
  });
}

export function writePaintPreviewScroll(local: PaintLocal, previewScroll: number, previewAtBottom: boolean): void {
  if (local.previewScroll === previewScroll && local.previewAtBottom === previewAtBottom) return;
  runInAction(() => {
    local.previewScroll = previewScroll;
    local.previewAtBottom = previewAtBottom;
  });
}

/** Mailbox / retained tape site. Structure refers to this key; cadence substitutes. */
export const APP_TAPE_KEY = "transcript";
/** Product column viewport around {@link APP_TAPE_KEY}. */
export const APP_TAPE_VIEWPORT_KEY = "transcript:viewport";
/** Ask Diff seated as the viewport's last child (not `ask:pin`). */
export const APP_ASK_DIFF_KEY = "ask:diff";
/** Occupancy wait — outside the viewport, immediately above the omnibox. */
export const APP_WAIT_PIN_KEY = "wait:pin";
/** Mailbox / retained composer site. */
export const APP_COMPOSER_KEY = "composer";
/** Product statusline above the tape. Room identity, not “now.” */
export const APP_STATUSLINE_KEY = "statusline";
/** Outer stacking box around the product column. Overlay siblings sit here. */
export const APP_FRAME_KEY = "frame";
/** Agents drawer viewport id — not {@link APP_TAPE_KEY}. */
export const APP_AGENTS_KEY = "agents";
/** Hit key for the agents drawer viewport. */
export const APP_AGENTS_VIEWPORT_KEY = "agents:viewport";
/** Overlay sibling; backdrop hit is `${key}:backdrop`. */
export const APP_AGENTS_OVERLAY_KEY = "agents:overlay";
/** Compact live-agent meter, composer-adjacent. */
export const APP_AGENTS_METER_KEY = "agents:meter";

/** Floor under the composer. */
export const ROOT_PAD_B = 0;
/** Empty row between the statusline and the tape. */
export const STATUSLINE_GAP = 1;
/**
 * Draft-column inset inside the omnibox chrome: `│` + mark + gap on the left,
 * trailing `│` on the right.
 */
export const STATUSLINE_PAD_L = 3;
export const STATUSLINE_PAD_R = 1;

/** Product column left/right inset — omnibox and tape both squeeze. */
export const ROOT_PAD_X = 1;
/** Crown above the column. */
export const ROOT_PAD_T = 1;
/** Extra left/right on `transcript:frame` (on top of {@link ROOT_PAD_X}). */
export const TAPE_PAD_X = 0;
/** Empty row between the tape viewport and the rim. */
export const TAPE_PAD_B = 1;

/** Width offered to the omnibox (and identity ask pin). */
export function rootInnerWidth(cols: number): number {
  return Math.max(8, cols - ROOT_PAD_X * 2);
}

/** Width offered to the tape (and Diff ask). */
export function tapeInnerWidth(cols: number): number {
  return Math.max(8, rootInnerWidth(cols) - TAPE_PAD_X * 2);
}

/**
 * Present follow-tail: engine clamps this to maxScroll.
 * Not `overflowAnchor: "auto"` — that path ignores `scroll` every frame.
 */
const FOLLOW_TAIL_SCROLL = Number.MAX_SAFE_INTEGER;

/** Bench slack: at bottom iff within 1 row of maxScroll. */
export function tapeFollowsTail(scroll: number, maxScroll: number): boolean {
  return maxScroll <= 0 || scroll >= maxScroll - 1;
}

export function nextTapeScroll(
  scroll: number,
  delta: number,
  maxScroll: number,
): { scroll: number; atBottom: boolean } {
  const next = Math.min(maxScroll, Math.max(0, scroll + delta));
  // Exact end. The 1-row slack in tapeFollowsTail would swallow a 1-row wheel.
  return { scroll: next, atBottom: maxScroll <= 0 || next >= maxScroll };
}

export function tapeViewportMetrics(
  byKey: ReadonlyMap<
    string,
    {
      readonly hitRect: { x: number; y: number; w: number; h: number };
      readonly element?: { kind?: string; scrollY?: number; maxScroll?: number };
    }
  >,
): {
  scrollY: number;
  maxScroll: number;
  h: number;
  hitRect: { x: number; y: number; w: number; h: number };
} | null {
  return viewportMetrics(byKey, APP_TAPE_VIEWPORT_KEY);
}

export function agentsViewportMetrics(
  byKey: ReadonlyMap<
    string,
    {
      readonly hitRect: { x: number; y: number; w: number; h: number };
      readonly element?: { kind?: string; scrollY?: number; maxScroll?: number };
    }
  >,
): {
  scrollY: number;
  maxScroll: number;
  h: number;
  hitRect: { x: number; y: number; w: number; h: number };
} | null {
  return viewportMetrics(byKey, APP_AGENTS_VIEWPORT_KEY);
}

export function agentsPreviewViewportMetrics(
  byKey: ReadonlyMap<
    string,
    {
      readonly hitRect: { x: number; y: number; w: number; h: number };
      readonly element?: { kind?: string; scrollY?: number; maxScroll?: number };
    }
  >,
): {
  scrollY: number;
  maxScroll: number;
  h: number;
  hitRect: { x: number; y: number; w: number; h: number };
} | null {
  return viewportMetrics(byKey, APP_AGENTS_PREVIEW_VIEWPORT_KEY);
}

function viewportMetrics(
  byKey: ReadonlyMap<
    string,
    {
      readonly hitRect: { x: number; y: number; w: number; h: number };
      readonly element?: { kind?: string; scrollY?: number; maxScroll?: number };
    }
  >,
  key: string,
): {
  scrollY: number;
  maxScroll: number;
  h: number;
  hitRect: { x: number; y: number; w: number; h: number };
} | null {
  const hit = byKey.get(key);
  if (hit?.element?.kind !== "viewport") return null;
  return {
    scrollY: hit.element.scrollY ?? 0,
    maxScroll: hit.element.maxScroll ?? 0,
    h: hit.hitRect.h,
    hitRect: hit.hitRect,
  };
}

/** Flex product column inside {@link APP_FRAME_KEY}. */
export function productColumn(frame: LayoutNode): LayoutNode {
  if (frame.type === "box" && frame.key === APP_FRAME_KEY) {
    const column = frame.children?.find((child) => child.key === "root");
    if (column !== undefined) return column;
  }
  return frame;
}

/** Drawer panel width: ~½ inner. Overlay; tape wrap does not change. */
export function agentsPanelWidth(cols: number): number {
  return Math.max(16, Math.floor(rootInnerWidth(cols) * 0.5));
}

/** Last slash-complete payload — same shape as Renderer's picker last. */
export interface PickerHostState {
  readonly paintRowToKey: readonly (string | null)[];
  readonly n: number;
  readonly viewport: number;
  readonly scrollOffset: number;
}

export interface PreparedComposer {
  readonly draft: string;
  readonly cursor: number;
  readonly mark: number | null;
  readonly interactive: boolean;
}

export interface PreparedPaint {
  readonly root: LayoutNode | null;
  readonly composer: PreparedComposer;
  readonly birthSites: readonly BirthSite[];
  readonly progressSites: readonly ProgressSite[];
  readonly picker: PickerHostState | null;
  /**
   * When this string changes, cadence drops the live text selection.
   * Catalog uses it for story / filter / sample / focus; product omits it.
   */
  readonly contentIdentity?: string;
}

export const EMPTY_PREPARED_COMPOSER: PreparedComposer = {
  draft: "",
  cursor: 0,
  mark: null,
  interactive: true,
};

export function emptyPreparedPaint(): PreparedPaint {
  return {
    root: null,
    composer: EMPTY_PREPARED_COMPOSER,
    birthSites: [],
    progressSites: [],
    picker: null,
  };
}

export interface RetainedPaintSource {
  bind(sink: PaintSink, local: PaintLocal): Disposable;
  /**
   * Live projection after bind. Cadence reads this on every tick.
   * A computed returns the same object until its facts change.
   */
  readonly snapshot?: PreparedPaint;
  /** Pull fallback when `snapshot` is omitted (mailbox / test stubs). */
  prepare(): PreparedPaint;
  /** Flip present-side collapse for a disclosure `blockId`. No-op if unbound. */
  toggleCollapsed?(blockId: string): void;
}

function layoutHasDiff(node: unknown): boolean {
  if (typeof node !== "object" || node === null) return false;
  const rec = node as { type?: string; kind?: string; children?: unknown[] };
  if (rec.type === "diff") return true;
  if (rec.type === "indentation_exception" && rec.kind === "diff") return true;
  if (Array.isArray(rec.children)) return rec.children.some(layoutHasDiff);
  return false;
}

export function mailboxTapeSite(): LayoutNode {
  return { type: "box", key: APP_TAPE_KEY, children: [] };
}

export function mailboxComposerSite(): LayoutNode {
  return { type: "box", key: APP_COMPOSER_KEY, children: [] };
}

/** Keep the head of a clause. `…` is one cell. */
function elideClauseHead(text: string, width: number): string {
  const w = Math.max(0, Math.floor(width));
  if (w <= 0) return "";
  if (text.length <= w) return text;
  if (w === 1) return "…";
  return `${text.slice(0, w - 1)}…`;
}

/**
 * Branch wins the budget. The clause keeps its head.
 */
function fitClause(branch: string, note: string, budget: number): { readonly branch: string; readonly note: string } {
  const gap = branch !== "" && note !== "" ? 1 : 0;
  if (branch.length + gap + note.length <= budget) return { branch, note };
  if (branch.length >= budget) return { branch: elidePathLeft(branch, budget), note: "" };
  const noteBudget = budget - branch.length - gap;
  if (noteBudget <= 0) return { branch, note: "" };
  return { branch, note: elideClauseHead(note, noteBudget) };
}

/** Keep the tail of a path. `…` is one cell. */
export function elidePathLeft(path: string, width: number): string {
  const w = Math.max(0, Math.floor(width));
  if (w <= 0) return "";
  if (path.length <= w) return path;
  if (w === 1) return "…";
  return `…${path.slice(-(w - 1))}`;
}

export function elideCwdParts(
  root: string,
  rest: string,
  budget: number,
): { readonly root: string; readonly rest: string } {
  const total = root + rest;
  if (total.length <= budget) return { root, rest };
  if (rest.length + 1 >= budget) return { root: "", rest: elidePathLeft(total, budget) };
  return { root: elidePathLeft(root, budget - rest.length), rest };
}

function cwdSpans(cwd: string, cwdRoot: string): { readonly root: string; readonly rest: string } {
  if (cwdRoot !== "" && cwd === cwdRoot) return { root: cwdRoot, rest: "" };
  if (cwdRoot !== "" && cwd.startsWith(`${cwdRoot}/`)) {
    return { root: cwdRoot, rest: cwd.slice(cwdRoot.length) };
  }
  return { root: cwd, rest: "" };
}

function statuslineRow(input: {
  readonly left: string;
  readonly note?: string;
  readonly cwd: string;
  readonly cwdRoot?: string;
  readonly width: number;
}): LayoutNode {
  const inner = Math.max(0, input.width - STATUSLINE_PAD_L - STATUSLINE_PAD_R);
  const split = cwdSpans(input.cwd, input.cwdRoot ?? "");
  const cwdBudget = Math.min(
    split.root.length + split.rest.length,
    Math.max(input.cwd === "" ? 0 : 8, Math.floor(inner / 2)),
  );
  const cwd = elideCwdParts(split.root, split.rest, cwdBudget);
  const cwdWidth = cwd.root.length + cwd.rest.length;
  const gap = (input.left !== "" || (input.note ?? "") !== "") && cwdWidth > 0 ? 1 : 0;
  const clause = fitClause(input.left, input.note ?? "", Math.max(0, inner - cwdWidth - gap));
  const clauseChildren: LayoutNode[] = [];
  if (clause.branch !== "") {
    clauseChildren.push({
      type: "text",
      key: "statusline:left:text",
      content: clause.branch,
      whiteSpace: "nowrap",
      ellipsis: true,
      style: { role: "foreground", prominence: FgP.secondary },
    });
  }
  if (clause.note !== "") {
    clauseChildren.push({
      type: "text",
      key: "statusline:note",
      content: clause.note,
      whiteSpace: "nowrap",
      ellipsis: true,
      style: { role: "foreground", prominence: FgP.rising },
    });
  }
  const children: LayoutNode[] = [
    {
      type: "box",
      key: "statusline:left",
      style: { flex: 1 },
      children:
        clauseChildren.length === 0
          ? []
          : [
              {
                type: "flex",
                key: "statusline:clause",
                style: { direction: "row", gap: 1 },
                children: clauseChildren,
              },
            ],
    },
  ];
  const path: LayoutNode[] = [];
  if (cwd.root !== "") {
    path.push({
      type: "text",
      key: "statusline:cwd",
      content: cwd.root,
      whiteSpace: "nowrap",
      style: { role: "foreground", prominence: FgP.secondary },
    });
  }
  if (cwd.rest !== "") {
    path.push({
      type: "text",
      key: "statusline:cwd:rest",
      content: cwd.rest,
      whiteSpace: "nowrap",
      style: { role: "foreground", prominence: FgP.ghost },
    });
  }
  if (path.length > 0) {
    children.push({
      type: "flex",
      key: "statusline:path",
      style: { direction: "row", gap: 0 },
      children: path,
    });
  }
  return {
    type: "flex",
    key: APP_STATUSLINE_KEY,
    style: {
      direction: "row",
      gap: 1,
      padding: { l: STATUSLINE_PAD_L, r: STATUSLINE_PAD_R },
      width: input.width,
    },
    children,
  };
}

function tapeViewportFrame(input: {
  readonly frameKey: string;
  readonly viewportKey: string;
  readonly viewportId: string;
  readonly children: readonly LayoutNode[];
  readonly flex?: number;
  readonly height?: number;
  readonly padding: { l?: number; r?: number; t?: number; b?: number };
  readonly scroll: number;
}): LayoutNode {
  return {
    type: "box",
    key: input.frameKey,
    style: {
      ...(input.flex === undefined ? {} : { flex: input.flex }),
      ...(input.height === undefined ? {} : { height: input.height }),
      padding: input.padding,
    },
    children: [
      {
        type: "viewport",
        id: input.viewportId,
        key: input.viewportKey,
        overflowY: "scroll",
        overflowAnchor: "none",
        scroll: input.scroll,
        children: [...input.children],
      },
    ],
  };
}

/**
 * Product frame. Outer box is the stacking context; the flex column
 * (`key: "root"`) is unchanged. An agents overlay is a last sibling —
 * never a flex child. Preview seats after that so its scrim compounds
 * over the drawer. Harness only supplies the tape / composer / agents
 * subtrees.
 *
 * Follow-tail (`atBottom`, default on): see FOLLOW_TAIL_SCROLL.
 * Rim (`seatRim`, default `atTip`): off-tip hides the omnibox unless intern
 * steal (ask / overlay / auth) passes seatRim true.
 */
export function assemblePaintFrame(input: {
  readonly tape: LayoutNode;
  readonly composer: LayoutNode;
  readonly ask?: LayoutNode | null;
  readonly wait?: LayoutNode | null;
  readonly agentsMeter?: LayoutNode | null;
  /** Drawer body. Overlay + viewport wrap lives here, not in the widget. */
  readonly agents?: LayoutNode | null;
  /** Tea-owned drawer scroll. Independent of tape follow-tail. */
  readonly agentsScroll?: number;
  /** Same-fill peek next to the focused drawer row. */
  readonly agentsPeek?: LayoutNode | null;
  readonly agentsFocusKey?: string;
  readonly agentsPreview?: LayoutNode | null;
  /** Process name for sneak-peek ╭╮ annotation. */
  readonly agentsPreviewTitle?: string;
  readonly agentsPreviewScroll?: number;
  readonly agentsPreviewAtBottom?: boolean;
  /** Left program string + cwd. Always seated; empty left is valid. */
  readonly statusline?: {
    readonly left?: string;
    /** Quiet checkout clause. Rising, beside the branch. */
    readonly note?: string;
    readonly cwd?: string;
    readonly cwdRoot?: string;
  } | null;
  readonly cols: number;
  readonly rows: number;
  readonly scroll?: number;
  readonly atBottom?: boolean;
  readonly atTip?: boolean;
  /** Compact rows above the tape. Absent = no slot. */
  readonly pastNeighbors?: LayoutNode | null;
  /** Compact rows below the tape. Off-tip only. */
  readonly futureNeighbors?: LayoutNode | null;
  readonly seatRim?: boolean;
}): LayoutNode {
  const ask = input.ask ?? null;
  const askIsDiff = ask !== null && layoutHasDiff(ask);
  const viewportChildren: LayoutNode[] = [input.tape];
  if (askIsDiff && ask !== null) {
    viewportChildren.push({
      type: "box",
      key: APP_ASK_DIFF_KEY,
      children: [ask],
    });
  }
  const innerWidth = Math.max(0, input.cols - ROOT_PAD_X * 2);
  const atTip = input.atTip !== false;
  const seatRim = input.seatRim ?? atTip;
  const column: LayoutNode[] = [
    statuslineRow({
      left: input.statusline?.left ?? "",
      note: input.statusline?.note ?? "",
      cwd: input.statusline?.cwd ?? "",
      cwdRoot: input.statusline?.cwdRoot ?? "",
      width: innerWidth,
    }),
  ];
  if (input.agentsMeter != null) {
    column.push({
      type: "box",
      key: APP_AGENTS_METER_KEY,
      children: [input.agentsMeter],
    });
  }
  column.push({
    type: "box",
    key: "statusline:gap",
    style: { height: STATUSLINE_GAP, width: innerWidth },
    children: [],
  });
  if (input.pastNeighbors != null) column.push(input.pastNeighbors);
  column.push(
    tapeViewportFrame({
      frameKey: "transcript:frame",
      viewportKey: APP_TAPE_VIEWPORT_KEY,
      viewportId: APP_TAPE_KEY,
      children: viewportChildren,
      flex: 1,
      padding: { l: TAPE_PAD_X, r: TAPE_PAD_X, b: TAPE_PAD_B },
      scroll: input.atBottom === false ? Math.max(0, input.scroll ?? 0) : FOLLOW_TAIL_SCROLL,
    }),
  );
  if (ask !== null && !askIsDiff) {
    column.push({
      type: "box",
      key: "ask:pin",
      children: [ask],
    });
  }
  if (input.wait != null && ask === null) {
    column.push({
      type: "box",
      key: APP_WAIT_PIN_KEY,
      children: [input.wait],
    });
  }
  if (seatRim) {
    column.push({
      type: "box",
      key: "rim",
      children: [input.composer],
    });
  }
  if (!atTip && input.futureNeighbors != null) column.push(input.futureNeighbors);
  const product: LayoutNode = {
    type: "flex",
    key: "root",
    style: {
      direction: "column",
      width: input.cols,
      height: input.rows,
      padding: { l: ROOT_PAD_X, t: ROOT_PAD_T, r: ROOT_PAD_X, b: ROOT_PAD_B },
    },
    children: column,
  };
  const shell: LayoutNode[] = [product];
  if (input.agents != null) {
    const panelW = agentsPanelWidth(input.cols);
    shell.push({
      type: "overlay",
      key: APP_AGENTS_OVERLAY_KEY,
      center: false,
      backdrop: true,
      children: [
        {
          type: "box",
          key: "agents:panel",
          style: {
            width: panelW,
            height: input.rows,
            padding: { l: 1, r: 1, t: 1 },
            background: { bgRole: "surface", bgProminence: BgP.panel },
          },
          children: [
            {
              type: "viewport",
              id: APP_AGENTS_KEY,
              key: APP_AGENTS_VIEWPORT_KEY,
              overflowY: "scroll",
              overflowAnchor: "none",
              scroll: Math.max(0, input.agentsScroll ?? 0),
              children: [input.agents],
            },
          ],
        },
      ],
    });
  }
  const frame: LayoutNode = {
    type: "box",
    key: APP_FRAME_KEY,
    style: { width: input.cols, height: input.rows },
    children: shell,
  };
  const peek = input.agentsPeek ?? null;
  const focusKey = input.agentsFocusKey ?? "";
  const seated =
    input.agents == null || peek == null || focusKey === ""
      ? frame
      : withAgentsPeek({
          root: frame,
          peek,
          focusKey,
          cols: input.cols,
          rows: input.rows,
        });
  const preview = input.agentsPreview ?? null;
  if (preview == null) return seated;
  return withAgentsPreview({
    root: seated,
    tape: preview,
    cols: input.cols,
    rows: input.rows,
    title: input.agentsPreviewTitle,
    scroll: input.agentsPreviewScroll,
    atBottom: input.agentsPreviewAtBottom,
  });
}

/** Walk a prepared composer (or frame) for slash-complete hit rows. */
export function pickerHostFromLayout(node: unknown): PickerHostState | null {
  if (typeof node !== "object" || node === null) return null;
  const rec = node as {
    type?: string;
    picker?: {
      rows: readonly { key?: string; href?: string }[];
      scrollOffset: number;
      viewport: number;
    };
    children?: unknown[];
  };
  if (rec.type === "chrome_frame" && rec.picker) {
    const { rows, scrollOffset, viewport } = rec.picker;
    const n = rows.length;
    const maxS = Math.max(0, n - viewport);
    const scroll = Math.min(maxS, Math.max(0, scrollOffset));
    const visible = rows.slice(scroll, scroll + viewport);
    const paintRowToKey: Array<string | null> = [];
    for (const row of visible) {
      const key = row.key ?? null;
      paintRowToKey.push(key);
      if ((row.href ?? "").trim().length > 0) paintRowToKey.push(key);
    }
    return { paintRowToKey, n, viewport, scrollOffset: scroll };
  }
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) {
      const hit = pickerHostFromLayout(child);
      if (hit !== null) return hit;
    }
  }
  return null;
}
