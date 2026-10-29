/**
 * Walks the Paint DOM replica through WidgetHost. Representation (column
 * frame, picker hit-map) is Quickdraw. This file only keeps the tree and
 * offers prepared children.
 */
import { trace } from "@inhuman.tools/harness-diagnostics";
import { layoutChildren, mapLayoutChildren, measureNode, type LayoutNode } from "@inhuman.tools/quickdraw/layout";
import {
  agentsPanelWidth,
  agentsPreviewInnerWidth,
  assemblePaintFrame,
  EMPTY_PREPARED_COMPOSER,
  emptyPreparedPaint,
  pickerHostFromLayout,
  rootInnerWidth,
  ROOT_PAD_B,
  ROOT_PAD_T,
  STATUSLINE_GAP,
  TAPE_PAD_B,
  tapeInnerWidth,
  writePaintEcho,
  writePaintTapeScroll,
  type PaintLocal,
  type PaintSink,
  type PreparedComposer,
  type PreparedPaint,
  type RetainedPaintSource,
} from "@inhuman.tools/quickdraw/runtime";
import { type SyntaxPolarity } from "@inhuman.tools/quickdraw/widgets";
import { reaction, runInAction, type IReactionDisposer } from "mobx";

import { agentsPreviewTitle, prepareAgentsMeter, prepareAgentsPeek, type AgentsReplicaFace } from "./agents-drawer.js";
import {
  createWorkCell,
  isPaintRootChrome,
  paintChildrenOf,
  type AgentsPaintInstance,
  type ComposerPaintInstance,
  type PaintNodeInstance,
  type RewindPaintInstance,
  type RootPaintInstance,
  type StatuslinePaintInstance,
} from "./paint-dom.js";
import type { PaintReader } from "./paint-transport.js";
import { armPatchTally, createPaintWidgetHost, dropPatchTally, takePatchTally } from "./paint-widgets.js";
import {
  dropOldestPastThenFarthestFuture,
  neighborColumnHeight,
  prepareRewindNeighbors,
  REWIND_MIN_TAPE_ROWS,
  type RewindNeighbor,
} from "./rewind-chrome.js";
import type { PreparedSubtree, WidgetHost } from "./widget-host.js";

export type HarnessPaintSource = RetainedPaintSource & {
  noteReplica(kind: "paint_init" | "paint_patch"): void;
  toggleCollapsed(blockId: string): void;
  /**
   * Host stall copy on the wait pin. Empty restores the worker's status.
   * Survives paint patches — the worker does not know the swap is in flight.
   */
  setPhase(text: string): void;
  /** New worker epoch: drop collapse mounts and tape follow state. */
  resetChrome(): void;
};

/** Statusline is always one seated row. */
const STATUSLINE_ROWS = 1;

export type ReplicaRewindAssemble = {
  readonly atTip: boolean;
  readonly seatRim: boolean;
  readonly pastNeighbors: LayoutNode | null;
  readonly futureNeighbors: LayoutNode | null;
};

/**
 * Neighbor drop only. One tape; recap is an in-place speech face.
 */
export function packReplicaRewind(input: {
  readonly rewind: RewindPaintInstance | null;
  readonly tapeW: number;
  readonly rows: number;
  readonly composerH: number;
  readonly pinH: number;
  /** Top overview row. Not a bottom pin. */
  readonly overviewH?: number;
}): ReplicaRewindAssemble {
  const atTip = input.rewind == null || input.rewind.atTip;
  const seatRim = input.rewind == null ? true : input.rewind.seatRim;
  const fixedChrome =
    ROOT_PAD_T +
    ROOT_PAD_B +
    STATUSLINE_ROWS +
    STATUSLINE_GAP +
    (input.overviewH ?? 0) +
    TAPE_PAD_B +
    input.composerH +
    input.pinH;
  const pastRows: RewindNeighbor[] = [...(input.rewind?.past ?? [])];
  const futureRows: RewindNeighbor[] = atTip ? [] : [...(input.rewind?.future ?? [])];
  const dropped = dropOldestPastThenFarthestFuture(
    pastRows,
    futureRows,
    Math.max(0, input.rows - fixedChrome - REWIND_MIN_TAPE_ROWS),
  );
  return {
    atTip,
    seatRim,
    pastNeighbors: prepareRewindNeighbors(dropped.past, input.tapeW, "rewind:behind", {
      side: "behind",
      moreOuter: (input.rewind?.pastTotal ?? 0) > dropped.past.length,
    }),
    futureNeighbors: prepareRewindNeighbors(dropped.future, input.tapeW, "rewind:ahead", {
      side: "ahead",
      moreOuter: (input.rewind?.futureTotal ?? 0) > dropped.future.length,
    }),
  };
}

export function createHarnessPaintSource(options: {
  reader: PaintReader;
  syntaxPolarity?: () => SyntaxPolarity;
  syntaxWarm?: () => boolean;
}): HarnessPaintSource {
  let sink: PaintSink | null = null;
  let local: PaintLocal | null = null;
  let widgets: WidgetHost | null = null;
  let dirty = false;
  let phase = "";
  let echoStop: IReactionDisposer | null = null;
  let assembled: PreparedPaint | null = null;
  let assembledFrom: unknown[] | null = null;
  let recapSnap = "";

  const composerFace = (root: RootPaintInstance | null): PreparedComposer => {
    const composer = composerOf(root);
    if (composer === null) return EMPTY_PREPARED_COMPOSER;
    return {
      draft: composer.draft,
      cursor: composer.cursor,
      mark: composer.mark,
      interactive: composer.interactive,
    };
  };

  const source: HarnessPaintSource = {
    bind(nextSink, nextLocal) {
      sink = nextSink;
      local = nextLocal;
      widgets = createPaintWidgetHost(nextSink, options.syntaxPolarity, options.syntaxWarm, nextLocal);
      assembled = null;
      assembledFrom = null;
      recapSnap = "";
      echoStop = reaction(
        () => {
          const composer = composerOf(options.reader.root);
          if (composer === null) return null;
          return [composer.draft, composer.cursor, composer.mark, composer.interactive] as const;
        },
        (triple) => {
          if (triple === null || nextLocal.echo.predicted === null) return;
          const [draft, cursor, mark, interactive] = triple;
          const predicted = nextLocal.echo.predicted;
          const same =
            predicted.draft === draft && predicted.cursor === cursor && (predicted.mark ?? null) === (mark ?? null);
          writePaintEcho(nextLocal, { predicted: null, misaligned: interactive && !same });
          nextSink.requestPaint();
        },
        { fireImmediately: false },
      );
      if (dirty || options.reader.root !== null) nextSink.requestPaint();
      return {
        [Symbol.dispose]() {
          echoStop?.();
          echoStop = null;
          sink = null;
          local = null;
          widgets = null;
          assembled = null;
          assembledFrom = null;
        },
      };
    },
    get snapshot() {
      return source.prepare();
    },
    prepare(): PreparedPaint {
      const root = options.reader.root;
      const composer = composerFace(root);
      if (local === null || root === null || widgets === null) {
        assembled = null;
        assembledFrom = null;
        return finish({
          ...emptyPreparedPaint(),
          composer,
        });
      }
      const frameW = rootInnerWidth(local.cols);
      const tapeW = tapeInnerWidth(local.cols);
      const composerNode = composerOf(root);
      const preparedComposer = composerNode === null ? null : widgets.widgetFor(composerNode).prepare(frameW);
      const tapeNode = tapeOf(root);
      const preparedTape: PreparedSubtree | null =
        tapeNode === null ? null : widgets.widgetFor(tapeNode).prepare(tapeW);
      const askNode = askOf(root);
      const askW = askSeatsInTape(askNode) ? tapeW : frameW;
      const preparedAsk: PreparedSubtree | null = askNode === null ? null : widgets.widgetFor(askNode).prepare(askW);
      const waitNode = phaseWait(root);
      const preparedWait: PreparedSubtree | null =
        waitNode === null ? null : widgets.widgetFor(waitNode).prepare(frameW);
      const statuslineNode = statuslineOf(root);
      const agentsNode = agentsOf(root);
      const drawerOpen = agentsNode?.open === true;
      const drawerW = agentsPanelWidth(local.cols);
      const preparedAgents = drawerOpen && agentsNode !== null ? widgets.widgetFor(agentsNode).prepare(drawerW) : null;
      const previewNode = previewOf(root);
      const previewW = agentsPreviewInnerWidth(local.cols);
      const preparedPreview = previewNode === null ? null : widgets.widgetFor(previewNode).prepare(previewW);
      const meterLeft = agentsNode?.meterLeft ?? "";
      const meterRight = agentsNode?.meterRight ?? "";
      const meter =
        agentsNode !== null && (meterLeft !== "" || meterRight !== "")
          ? prepareAgentsMeter(meterLeft, meterRight, frameW)
          : null;
      const overviewH = meter === null ? 0 : 1;
      const askPinH = askNode !== null && !askSeatsInTape(askNode) ? (preparedAsk?.measured.h ?? 0) : 0;
      const waitPinH = waitNode !== null && askNode === null ? (preparedWait?.measured.h ?? 0) : 0;
      const rewindNode = rewindOf(root);
      const seatRim = rewindNode == null ? true : rewindNode.seatRim;
      const rewind = packReplicaRewind({
        rewind: rewindNode,
        tapeW,
        rows: local.rows,
        composerH: seatRim ? (preparedComposer?.measured.h ?? 0) : 0,
        pinH: askPinH + waitPinH,
        overviewH,
      });
      if (preparedTape !== null && !rewind.atTip) {
        const recap = recapInTape(preparedTape.root);
        if (recap !== null && recap.key !== recapSnap) {
          recapSnap = recap.key;
          // Pin the active message on the viewport floor. `recap.y` is the
          // row where that block starts inside the tape; writing it as
          // scroll parks the block's top on the viewport's top and leaves
          // the rest of a short message, or all of a tall one, below the fold.
          const viewportH = tapeViewportRows(local.rows, {
            composerH: seatRim ? (preparedComposer?.measured.h ?? 0) : 0,
            pinH: askPinH + waitPinH,
            overviewH,
            pastH: neighborColumnHeight(rewind.pastNeighbors == null ? 0 : layoutChildren(rewind.pastNeighbors).length),
            futureH: neighborColumnHeight(
              rewind.futureNeighbors == null ? 0 : layoutChildren(rewind.futureNeighbors).length,
            ),
          });
          writePaintTapeScroll(local, scrollToShowBlock(recap.y, recap.h, viewportH), false);
        }
      } else if (rewind.atTip) {
        if (recapSnap !== "") writePaintTapeScroll(local, 0, true);
        recapSnap = "";
      }
      const from = [
        preparedTape?.root,
        preparedComposer?.root,
        preparedAsk?.root,
        preparedWait?.root,
        preparedAgents?.root,
        preparedPreview?.root,
        rewind.atTip,
        rewind.seatRim,
        rewind.pastNeighbors,
        rewind.futureNeighbors,
        local.cols,
        local.rows,
        local.tapeScroll,
        local.tapeAtBottom,
        local.tapeExpanded,
        local.previewScroll,
        local.previewAtBottom,
        phase,
        statuslineNode?.left ?? "",
        statuslineNode?.note ?? "",
        statuslineNode?.cwd ?? "",
        statuslineNode?.cwdRoot ?? "",
        meterLeft,
        meterRight,
        agentsNode?.open === true,
        agentsNode?.scroll ?? 0,
        agentsNode?.focusKey ?? "",
        agentsNode?.previewKey ?? "",
        composer.draft,
        composer.cursor,
        composer.mark,
        composer.interactive,
        composerNode?.readOnly === true,
      ];
      if (assembled !== null && assembledFrom !== null && sameAssemble(assembledFrom, from)) {
        return finish(assembled);
      }
      const agentsFace: AgentsReplicaFace | null =
        agentsNode === null
          ? null
          : {
              meterLeft,
              meterRight,
              open: agentsNode.open,
              focusKey: agentsNode.focusKey,
              scroll: agentsNode.scroll,
              rows: agentsNode.rows,
              previewKey: agentsNode.previewKey,
            };
      assembled = {
        root: assemblePaintFrame({
          tape:
            preparedTape == null
              ? emptySite("tape")
              : rewind.atTip
                ? preparedTape.root
                : dimOutsideRecap(preparedTape.root),
          composer: preparedComposer?.root ?? emptySite("composer"),
          ask: preparedAsk?.root ?? null,
          wait: preparedWait?.root ?? null,
          agentsMeter: meter,
          agents: preparedAgents?.root ?? null,
          agentsScroll: agentsNode?.scroll ?? 0,
          agentsPeek: agentsFace === null ? null : prepareAgentsPeek(agentsFace),
          agentsFocusKey: agentsNode?.focusKey ?? "",
          agentsPreview: preparedPreview?.root ?? null,
          agentsPreviewTitle: agentsFace === null ? "" : agentsPreviewTitle(agentsFace),
          agentsPreviewScroll: local.previewScroll,
          agentsPreviewAtBottom: local.previewAtBottom,
          statusline:
            statuslineNode === null
              ? null
              : {
                  left: statuslineNode.left,
                  note: statuslineNode.note,
                  cwd: statuslineNode.cwd,
                  cwdRoot: statuslineNode.cwdRoot,
                },
          cols: local.cols,
          rows: local.rows,
          scroll: local.tapeScroll,
          atBottom: local.tapeAtBottom,
          atTip: rewind.atTip,
          seatRim: rewind.seatRim,
          pastNeighbors: rewind.pastNeighbors,
          futureNeighbors: rewind.futureNeighbors,
        }),
        composer,
        birthSites: [
          ...(preparedTape?.birthSites ?? []),
          ...(preparedAsk?.birthSites ?? []),
          ...(preparedWait?.birthSites ?? []),
          ...(preparedComposer?.birthSites ?? []),
          ...(preparedPreview?.birthSites ?? []),
        ],
        progressSites: [
          ...(preparedTape?.progressSites ?? []),
          ...(preparedAsk?.progressSites ?? []),
          ...(preparedWait?.progressSites ?? []),
          ...(preparedComposer?.progressSites ?? []),
          ...(preparedPreview?.progressSites ?? []),
        ],
        picker: pickerHostFromLayout(preparedComposer?.root ?? null),
      };
      assembledFrom = from;
      return finish(assembled);

      function finish(prepared: PreparedPaint): PreparedPaint {
        const tally = takePatchTally();
        if (tally !== null) {
          // see paint-widgets preamble, CHANGE ONLY
          trace("harness:paint", formatPaintTally(options.reader.seq, tally));
        }
        return prepared;
      }
    },
    noteReplica(kind) {
      dirty = true;
      if (kind === "paint_patch") armPatchTally();
      else dropPatchTally();
      sink?.requestPaint();
    },
    setPhase(text) {
      if (text === phase) return;
      phase = text;
      assembled = null;
      assembledFrom = null;
      dirty = true;
      sink?.requestPaint();
    },
    toggleCollapsed(blockId) {
      widgets?.toggleCollapsed(blockId);
    },
    resetChrome() {
      const bound = local;
      const boundSink = sink;
      if (bound != null) {
        runInAction(() => {
          bound.echo = { predicted: null, misaligned: false };
          bound.tapeScroll = 0;
          bound.tapeAtBottom = true;
          bound.tapeExpanded = false;
          bound.previewScroll = 0;
          bound.previewAtBottom = true;
        });
      }
      if (boundSink != null && bound != null) {
        widgets = createPaintWidgetHost(boundSink, options.syntaxPolarity, options.syntaxWarm, bound);
      }
      assembled = null;
      assembledFrom = null;
      recapSnap = "";
      dirty = true;
      boundSink?.requestPaint();
    },
  };

  /**
   * Stall copy for this frame only. A fresh cell so the worker snapshot
   * stays the status to restore when the phase clears.
   */
  function phaseWait(root: RootPaintInstance): PaintNodeInstance | null {
    const cell = waitOf(root);
    if (phase === "" || cell === null || cell.kind !== "wait") return cell;
    const overlay = createWorkCell("wait");
    overlay.setFace({
      name: "waiting",
      object: "",
      status: phase,
      state: "live",
      indent: false,
      receiptKind: "none",
      receiptText: "",
      diffOld: "",
      diffNew: "",
      diffPath: "",
      startedAt: null,
    });
    return overlay;
  }

  return source;
}

function formatPaintTally(
  seq: number,
  tally: { readonly rebuilt: readonly string[]; readonly cached: readonly string[] },
): string {
  const rebuilt = uniqueKinds(tally.rebuilt);
  const rebuiltSet = new Set(rebuilt);
  const cached = uniqueKinds(tally.cached).filter((kind) => !rebuiltSet.has(kind));
  return `seq=${seq} rebuilt=${kindList(rebuilt)} cached=${kindList(cached)}`;
}

function uniqueKinds(kinds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const kind of kinds) {
    if (seen.has(kind)) continue;
    seen.add(kind);
    out.push(kind);
  }
  return out;
}

function kindList(kinds: readonly string[]): string {
  return kinds.length === 0 ? "-" : kinds.join(",");
}

function sameAssemble(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function emptySite(key: string): LayoutNode {
  return { type: "box", key, children: [] };
}

function composerOf(root: RootPaintInstance | null): ComposerPaintInstance | null {
  if (root === null) return null;
  for (const child of paintChildrenOf(root)) {
    if (child.kind === "composer") return child;
  }
  return null;
}

function tapeOf(root: RootPaintInstance): PaintNodeInstance | null {
  for (const child of paintChildrenOf(root)) {
    if (!isPaintRootChrome(child.kind)) return child;
  }
  return null;
}

function previewOf(root: RootPaintInstance): PaintNodeInstance | null {
  for (const child of paintChildrenOf(root)) {
    if (child.kind === "preview") return child;
  }
  return null;
}

function agentsOf(root: RootPaintInstance): AgentsPaintInstance | null {
  for (const child of paintChildrenOf(root)) {
    if (child.kind === "agents") return child;
  }
  return null;
}

function askOf(root: RootPaintInstance | null): PaintNodeInstance | null {
  if (root === null) return null;
  for (const child of paintChildrenOf(root)) {
    if (child.kind === "ask") return child;
  }
  return null;
}

function waitOf(root: RootPaintInstance | null): PaintNodeInstance | null {
  if (root === null) return null;
  for (const child of paintChildrenOf(root)) {
    if (child.kind === "wait") return child;
  }
  return null;
}

/** Diff ask lives in the viewport; identity pin sits at column width. */
function askSeatsInTape(node: PaintNodeInstance | null): boolean {
  return node !== null && node.kind === "ask" && node.receiptKind === "diff";
}

function statuslineOf(root: RootPaintInstance | null): StatuslinePaintInstance | null {
  if (root === null) return null;
  for (const child of paintChildrenOf(root)) {
    if (child.kind === "statusline") return child;
  }
  return null;
}

function rewindOf(root: RootPaintInstance): RewindPaintInstance | null {
  for (const child of paintChildrenOf(root)) {
    if (child.kind === "rewind") return child;
  }
  return null;
}

/**
 * Rows the transcript viewport can show. Same chrome the column seats
 * around it: pads, statusline, neighbors, optional rim and pins.
 */
export function tapeViewportRows(
  rows: number,
  chrome: { composerH: number; pinH: number; pastH: number; futureH: number; overviewH?: number },
): number {
  const taken =
    ROOT_PAD_T +
    ROOT_PAD_B +
    STATUSLINE_ROWS +
    STATUSLINE_GAP +
    (chrome.overviewH ?? 0) +
    TAPE_PAD_B +
    chrome.composerH +
    chrome.pinH +
    chrome.pastH +
    chrome.futureH;
  return Math.max(1, rows - taken);
}

/**
 * Scroll that centers a block in the viewport. `height` is the whole block,
 * not its first row. A block taller than the viewport keeps its top on the
 * first row so the start stays readable.
 */
export function scrollToShowBlock(y: number, height: number, viewportH: number): number {
  const h = Math.max(1, height);
  const view = Math.max(1, viewportH);
  if (h >= view) return Math.max(0, y);
  return Math.max(0, y - Math.floor((view - h) / 2));
}

function recapInTape(tape: LayoutNode): { key: string; y: number; h: number } | null {
  const body = tape.key === "transcript:body" ? tape : (findLayoutKey(tape, "transcript:body") ?? tape);
  let y = 0;
  let fallback: { key: string; y: number; h: number } | null = null;
  for (const child of layoutChildren(body)) {
    const pin = findPinRecap(child);
    if (pin !== null) {
      // The pin is the message block, not the whole turn. A long reply
      // after it must not pull the scroll down until the prompt leaves
      // the viewport.
      const before = layoutOffset(child, pin);
      return { key: pin.key ?? "", y: y + before, h: layoutHeight(pin) };
    }
    const h = layoutHeight(child);
    if (fallback === null && isReadOnlyChrome(child)) fallback = { key: child.key ?? "", y, h };
    y += h;
  }
  return fallback;
}

/** Rows from `root`'s top to `target`. Row flex does not add height. -1 if absent. */
function layoutOffset(root: LayoutNode, target: LayoutNode): number {
  if (root === target) return 0;
  const kids = layoutChildren(root);
  const row = root.type === "flex" && root.style?.direction !== "column";
  let y = 0;
  for (const child of kids) {
    if (child === target) return y;
    const inner = layoutOffset(child, target);
    if (inner !== -1) return y + inner;
    if (!row) y += layoutHeight(child);
  }
  return -1;
}

function findPinRecap(node: LayoutNode): LayoutNode | null {
  if (isPinRecap(node)) return node;
  for (const child of layoutChildren(node)) {
    const hit = findPinRecap(child);
    if (hit !== null) return hit;
  }
  return null;
}

function isPinRecap(node: LayoutNode): boolean {
  return isReadOnlyChrome(node) && typeof node.key === "string" && node.key.endsWith(":recap");
}

function findLayoutKey(node: LayoutNode, key: string): LayoutNode | null {
  if (node.key === key) return node;
  for (const child of layoutChildren(node)) {
    const hit = findLayoutKey(child, key);
    if (hit !== null) return hit;
  }
  return null;
}

function isReadOnlyChrome(node: LayoutNode): boolean {
  return node.type === "chrome_frame" && node.readOnly === true;
}

function layoutHeight(node: LayoutNode): number {
  if (node.measured != null) return node.measured.h;
  const style = "style" in node ? node.style : undefined;
  const height = style != null && typeof style === "object" && "height" in style ? style.height : undefined;
  if (typeof height === "number") return height;
  // Widget prepare stamps measured on its root only. A recap frame and the
  // rows around it have no stamp, and a missing height scrolls to row 0.
  return measureNode(node, 10_000, 10_000).h;
}

/** Keep the target at full prominence; fade sibling subtrees without changing layout. */
function dimOutsideRecap(node: LayoutNode): LayoutNode {
  if (isPinRecap(node)) return node;
  if (findPinRecap(node) === null) return { ...node, regionProminence: 0.45 };
  return mapLayoutChildren(node, dimOutsideRecap);
}
