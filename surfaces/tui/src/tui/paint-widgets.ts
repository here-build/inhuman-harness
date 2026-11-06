/**
 * Harness adapters from Paint DOM nodes to retained Quickdraw widgets.
 * Quickdraw stays MST-free. Reactions mark dirty; prepare is untracked.
 *
 * The reaction data function is the dirty set. A JSON-pointer walk is not
 * a second one: it misses completion fields, fuse, collapse, and syntax
 * polarity, and a correct-looking "fix" will propose it. Ancestor rebuild
 * assembles the column; the leaf cache is the cut. Node identity is the
 * MST object (paint-replica); there is no replicated id.
 *
 * A paint_patch arms one tally until the paint source's prepare returns.
 * The line is `seq=<n> rebuilt=<kinds> cached=<kinds>` (`-` when empty).
 * A kind is rebuilt if any prepare of that kind rebuilt; otherwise cached.
 * paint_init is a remount and does not emit. see paint-source, CHANGE ONLY.
 */
import { isPathShapedName } from "@inhuman.tools/harness-sdk/text";
import { collectProgressSites, measureNode, type LayoutNode, type ProgressSite } from "@inhuman.tools/quickdraw/layout";
import { FgP } from "@inhuman.tools/quickdraw/lexicon";
import { collectBirthSites, type BirthSite, type PaintLocal, type PaintSink } from "@inhuman.tools/quickdraw/runtime";
import {
  ComposerFrame,
  completionSlots,
  createMarkdownExpandStream,
  expandWidgetPriors,
  hasThoughtRow,
  Recall,
  replaceSpeechBody,
  Speech,
  speechBodyNode,
  speechBodyWidth,
  syntaxPolarity as defaultSyntaxPolarity,
  syntaxWarm as defaultSyntaxWarm,
  Text,
  ThinkingStream,
  transcriptColumn,
  replySpeechRailWidth,
  userSpeechRailWidth,
  type ComposerCommandChoice,
  type ComposerCommandFallback,
  type SyntaxPolarity,
  type TranscriptPart,
} from "@inhuman.tools/quickdraw/widgets";
import { comparer, reaction, untracked, type IReactionDisposer } from "mobx";
import { getParent, hasParent, isStateTreeNode } from "mobx-state-tree";

import { prepareAgentsDrawer, type AgentsReplicaFace } from "./agents-drawer.js";
import {
  failureOf,
  paintChildrenOf,
  speechOf,
  thinkingOf,
  type AgentsPaintInstance,
  type CompletionPaintInstance,
  type ComposerPaintInstance,
  type FailurePaintInstance,
  type PaintNodeInstance,
  type RecallPaintInstance,
  type SpeechPaintInstance,
  type ThinkingPaintInstance,
  type WorkCellPaintInstance,
} from "./paint-dom.js";
import { clusterThoughtClock, filterFusedTools, groupTapeSpans, type TapeItem } from "./tape-spans.js";
import { WidgetHost, type PreparedSubtree, type RetainedWidget } from "./widget-host.js";
import { askPinNode, receiptFromReplica, workDisclosure, type WorkCellFace } from "./work-cells.js";

type PatchTally = { rebuilt: string[]; cached: string[] };

let patchTally: PatchTally | null = null;

export function armPatchTally(): void {
  patchTally ??= { rebuilt: [], cached: [] };
}

export function dropPatchTally(): void {
  patchTally = null;
}

export function takePatchTally(): PatchTally | null {
  const tally = patchTally;
  patchTally = null;
  return tally;
}

function recordPrepare(kind: string, cached: boolean): void {
  if (patchTally === null) return;
  (cached ? patchTally.cached : patchTally.rebuilt).push(kind);
}

export type PaintWidgetContext = {
  host: WidgetHost;
  sink: PaintSink;
  local: PaintLocal | null;
  /**
   * Ambient shiki polarity and warmth — both MobX-observable, read inside
   * each widget's `reaction` data function so a flip or warm-up marks the
   * baked-token subtree dirty. Not a counter: these are the actual inputs
   * `highlightCodeSync` derives token colors from.
   */
  syntaxPolarity: () => SyntaxPolarity;
  syntaxWarm: () => boolean;
};

export function createPaintWidgetHost(
  sink: PaintSink,
  syntaxPolarity: () => SyntaxPolarity = defaultSyntaxPolarity,
  syntaxWarm: () => boolean = defaultSyntaxWarm,
  local: PaintLocal | null = null,
): WidgetHost {
  const ctx = { sink, syntaxPolarity, syntaxWarm, local } as PaintWidgetContext;
  const host = new WidgetHost((node, parent) => createPaintWidget(node, parent, ctx));
  ctx.host = host;
  return host;
}

function createPaintWidget(
  node: PaintNodeInstance,
  parent: RetainedWidget | null,
  ctx: PaintWidgetContext,
): RetainedWidget {
  switch (node.kind) {
    case "speech":
      return new SpeechWidget(node, parent, ctx);
    case "thinking":
      return new ThinkingWidget(node, parent, ctx);
    case "failure":
      return new FailureWidget(node, parent, ctx);
    case "recall":
    case "compact":
      return new RecallWidget(node, parent, ctx);
    case "completion":
      return new CompletionWidget(node, parent, ctx);
    case "composer":
      return new ComposerWidget(node, parent, ctx);
    case "agents":
      return new AgentsWidget(node, parent, ctx);
    case "tool":
    case "scheme":
    case "loop":
    case "ask":
    case "wait":
      return new WorkCellWidget(node, parent, ctx);
    case "turn":
    case "stack":
    case "preview":
    case "root":
      return new StackWidget(node, parent, ctx);
    default:
      return new StackWidget(node, parent, ctx);
  }
}

abstract class RetainedAdapter implements RetainedWidget {
  readonly node: PaintNodeInstance;
  readonly parent: RetainedWidget | null;
  readonly ctx: PaintWidgetContext;
  #dirty = true;
  #cache: PreparedSubtree | null = null;
  #stops: IReactionDisposer[] = [];
  #birthSites: BirthSite[] = [];
  #progressSites: ProgressSite[] = [];
  disposed = false;

  constructor(node: PaintNodeInstance, parent: RetainedWidget | null, ctx: PaintWidgetContext) {
    this.node = node;
    this.parent = parent;
    this.ctx = ctx;
    this.watch();
  }

  protected observe(data: () => unknown): void {
    this.#stops.push(reaction(data, () => this.markDirty(), { fireImmediately: false, equals: comparer.shallow }));
  }

  protected abstract watch(): void;
  protected abstract rebuild(width: number): LayoutNode;

  markDirty(): void {
    if (this.disposed) return;
    this.#dirty = true;
    this.parent?.markDirty();
    this.ctx.sink.requestPaint();
  }

  prepare(width: number): PreparedSubtree {
    return untracked((): PreparedSubtree => {
      if (!this.#dirty && this.#cache !== null && this.#cache.width === width) {
        recordPrepare(this.node.kind, true);
        return this.#cache;
      }
      const rebuilt = this.rebuild(width);
      const measured = rebuilt.measured ?? measureNode(rebuilt, width, Number.POSITIVE_INFINITY);
      const stamp = { w: measured.w, h: measured.h, atW: width };
      const root: LayoutNode = { ...rebuilt, paintReady: true, measured: stamp };
      const sites = this.takeSites(root);
      this.#cache = {
        width,
        root,
        measured: stamp,
        birthSites: sites.birth,
        progressSites: sites.progress,
      };
      this.#dirty = false;
      recordPrepare(this.node.kind, false);
      return this.#cache;
    });
  }

  /** Stack/turn rebuild already asked child widgets; reuse their site lists. */
  protected takeSites(root: LayoutNode): { birth: readonly BirthSite[]; progress: readonly ProgressSite[] } {
    if (
      this.#birthSites.length > 0 ||
      this.#progressSites.length > 0 ||
      this.node.kind === "stack" ||
      this.node.kind === "turn" ||
      this.node.kind === "preview" ||
      this.node.kind === "root"
    ) {
      return { birth: this.#birthSites, progress: this.#progressSites };
    }
    return { birth: collectBirthSites(root), progress: collectProgressSites(root) };
  }

  protected keepSites(birth: BirthSite[], progress: ProgressSite[]): void {
    this.#birthSites = birth;
    this.#progressSites = progress;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of this.#stops) stop();
    this.#stops = [];
    this.ctx.host.forget(this.node);
  }
}

function completionOf(node: PaintNodeInstance): CompletionPaintInstance | null {
  if (!isStateTreeNode(node)) return null;
  let current: object = node;
  for (let depth = 0; depth < 4; depth++) {
    if (!hasParent(current)) return null;
    current = getParent(current);
    if ("kind" in current && current.kind === "completion") {
      return current as CompletionPaintInstance;
    }
  }
  return null;
}

export class SpeechWidget extends RetainedAdapter {
  expands = 0;
  #stream = createMarkdownExpandStream();
  #expanded: {
    text: string;
    width: number;
    polarity: SyntaxPolarity;
    ended: boolean;
    node: LayoutNode;
  } | null = null;

  protected watch(): void {
    this.observe(() => {
      const speech = this.node as SpeechPaintInstance;
      const completion = completionOf(speech);
      return [
        speech.text,
        speech.voice,
        speech.atMs,
        speech.recap,
        speech.recapHotkeys,
        speech.annotation,
        completion?.state ?? "live",
        this.ctx.syntaxPolarity(),
        this.ctx.syntaxWarm(),
      ];
    });
  }

  protected rebuild(width: number): LayoutNode {
    const speech = this.node as SpeechPaintInstance;
    const key = this.ctx.host.localFor(speech).hitKey;
    if (speech.voice === "user" && speech.recap) {
      return ComposerFrame(
        {
          inputValue: speech.text,
          annotation: emptyToUndef(speech.annotation),
          hotkeys: speech.recapHotkeys,
          interactive: false,
          readOnly: true,
          selected: speech.recap === true,
        },
        { key: speech.recap ? `${key}:recap` : key, width, plainBottom: true },
      );
    }
    const completion = completionOf(speech);
    const live = completion?.state === "live";
    const failed = completion?.state === "failed";
    const contentW = speech.voice === "user" ? userSpeechRailWidth(width) : replySpeechRailWidth(width);
    const textW = speechBodyWidth(contentW);
    const node = Speech(
      { text: speech.text, voice: speech.voice, live, failed, atMs: speech.atMs },
      { key, width: contentW },
    );
    const prior = speechBodyNode(node);
    if (failed || prior === undefined) return node;
    const polarity = this.ctx.syntaxPolarity();
    const ended = !live;
    if (
      this.#expanded === null ||
      this.#expanded.text !== speech.text ||
      this.#expanded.width !== textW ||
      this.#expanded.polarity !== polarity ||
      this.#expanded.ended !== ended
    ) {
      this.expands += 1;
      if (this.#expanded !== null && this.#expanded.polarity !== polarity) {
        this.#stream = createMarkdownExpandStream();
      }
      this.#expanded = {
        text: speech.text,
        width: textW,
        polarity,
        ended,
        node:
          prior.type === "markdown"
            ? this.#stream.pull({
                content: prior.content,
                live,
                width: textW,
                key: prior.key,
                style: prior.style,
              })
            : prior,
      };
    }
    return replaceSpeechBody(node, this.#expanded.node);
  }
}

export class ThinkingWidget extends RetainedAdapter {
  protected watch(): void {
    this.observe(() => {
      const thinking = this.node as ThinkingPaintInstance;
      const completion = completionOf(thinking);
      return [
        thinking.text,
        completion?.state ?? "live",
        completion?.workerPresent ?? false,
        completion?.thoughtLive ?? false,
        completion?.retryUntilMs ?? null,
        completion?.thoughtKind ?? "",
        completion?.model ?? "",
        completion?.startedAt ?? null,
        completion?.durationMs ?? null,
        this.ctx.host.localFor(thinking).collapsed,
      ];
    });
  }

  protected rebuild(width: number): LayoutNode {
    const thinking = this.node as ThinkingPaintInstance;
    const completion = completionOf(thinking);
    const live = completion?.thoughtLive === true;
    const key = this.ctx.host.localFor(thinking).hitKey;
    return ThinkingStream(
      {
        text: thinking.text,
        live,
        collapsed: this.ctx.host.localFor(thinking).collapsed,
        seal: live ? "live" : "sealed",
        latest: completion?.state === "live",
        startedAt: completion?.startedAt ?? undefined,
        durationMs: completion?.durationMs ?? undefined,
        retryUntilMs: completion?.retryUntilMs ?? undefined,
        bootstrapping: live && !(completion?.workerPresent ?? false),
        thoughtKind: completion?.thoughtKind,
        agentLabel: completion?.model !== undefined && completion.model.trim() !== "" ? completion.model : undefined,
      },
      { key: `${key}:thought`, width },
    );
  }
}

export class FailureWidget extends RetainedAdapter {
  protected watch(): void {
    this.observe(() => {
      const failure = this.node as FailurePaintInstance;
      const completion = completionOf(failure);
      return [failure.endDetail, failure.failReason, completion == null ? null : speechOf(completion).atMs];
    });
  }

  protected rebuild(width: number): LayoutNode {
    const failure = this.node as FailurePaintInstance;
    const text = failure.endDetail.trim() || failure.failReason.trim() || "turn failed";
    const key = this.ctx.host.localFor(failure).hitKey;
    const completion = completionOf(failure);
    const contentW = replySpeechRailWidth(width);
    return Speech(
      { text, failed: true, atMs: completion == null ? null : speechOf(completion).atMs },
      { key, width: contentW },
    );
  }
}

export class RecallWidget extends RetainedAdapter {
  protected watch(): void {
    this.observe(() => (this.node as RecallPaintInstance).text);
  }

  protected rebuild(_width: number): LayoutNode {
    const recall = this.node as RecallPaintInstance;
    const key = this.ctx.host.localFor(recall).hitKey;
    return Recall(recall.text, { key });
  }
}

export class CompletionWidget extends RetainedAdapter {
  protected watch(): void {
    this.observe(() => {
      const completion = this.node as CompletionPaintInstance;
      return [
        completion.state,
        completion.workerPresent,
        completion.thoughtLive,
        completion.retryUntilMs,
        completion.thoughtKind,
        completion.startedAt,
        completion.durationMs,
        speechOf(completion).text,
        thinkingOf(completion).text,
        failureOf(completion).endDetail,
        failureOf(completion).failReason,
        completion.debugNote,
      ];
    });
  }

  protected rebuild(width: number): LayoutNode {
    const completion = this.node as CompletionPaintInstance;
    const speech = speechOf(completion);
    const thinking = thinkingOf(completion);
    const failure = failureOf(completion);
    const speechWidget = this.ctx.host.widgetFor(speech, this);
    this.ctx.host.widgetFor(thinking, this);
    const failureWidget = this.ctx.host.widgetFor(failure, this);

    const failed = completion.state === "failed";
    const live = completion.state === "live";
    const slots = completionSlots({
      live,
      failed,
      workerPresent: completion.workerPresent,
      speech: speech.text,
      thought: thinking.text,
      failure: failure.endDetail.trim() || failure.failReason.trim(),
    });
    const key = this.ctx.host.localFor(completion).hitKey;
    const speechNode = slots.showFailure
      ? failureWidget.prepare(width).root
      : slots.showSpeech
        ? speechWidget.prepare(width).root
        : undefined;
    return (
      speechNode ?? {
        type: "box",
        key,
        children: [],
      }
    );
  }
}

export class WorkCellWidget extends RetainedAdapter {
  protected watch(): void {
    this.observe(() => {
      const cell = this.node as WorkCellPaintInstance;
      const local = this.ctx.host.localFor(cell);
      return [
        cell.kind,
        cell.name,
        cell.object,
        cell.status,
        cell.caption,
        cell.state,
        cell.indent,
        cell.split,
        cell.agent,
        cell.pretty,
        cell.prettyBlock,
        cell.response,
        cell.receiptKind,
        cell.receiptText,
        cell.diffOld,
        cell.diffNew,
        cell.diffPath,
        cell.diffLineStart,
        cell.startedAt,
        cell.retryUntilMs,
        local.collapsed,
        this.ctx.syntaxPolarity(),
        this.ctx.syntaxWarm(),
      ];
    });
  }

  protected rebuild(width: number): LayoutNode {
    const cell = this.node as WorkCellPaintInstance;
    const key = this.ctx.host.localFor(cell).hitKey;
    if (cell.kind === "wait") {
      return waitPinNode(cell, key, width);
    }
    if (cell.kind === "ask") {
      const node = askPinNode(faceFromCell(cell, key, false), width);
      if (cell.receiptKind !== "diff") return node;
      // prepare() tree. The terminal expands the same face in qd.
      return expandWidgetPriors(node, { width });
    }
    const node = workDisclosure(faceFromCell(cell, key, this.ctx.host.localFor(cell).collapsed), width);
    // This tree is for prepare(). The terminal expands the same face in qd.
    if (cell.receiptKind !== "diff") return node;
    return expandWidgetPriors(node, { width });
  }
}

function waitErrorText(error: string, key: string): LayoutNode {
  return Text(error, {
    key,
    whiteSpace: "nowrap",
    ellipsis: true,
    lineClamp: 1,
    style: { role: "error", prominence: FgP.primary },
  });
}

function waitPinNode(cell: WorkCellPaintInstance, key: string, width: number): LayoutNode {
  const error = cell.object.trim();
  if (cell.name === "error") {
    return {
      type: "flex",
      key: `${key}:row`,
      style: { direction: "row", width, justifyContent: "space_between", alignItems: "center" },
      children: [
        { type: "box", key: `${key}:lead`, style: { flex: 1, height: 1 } },
        waitErrorText(error, `${key}:err`),
      ],
    };
  }
  const stream = ThinkingStream(
    {
      text: "",
      live: true,
      seal: "live",
      startedAt: cell.startedAt ?? undefined,
      retryUntilMs: cell.retryUntilMs ?? undefined,
      bootstrapping: cell.startedAt == null && cell.retryUntilMs == null,
      occupancyLabel: cell.status.trim() === "" ? undefined : cell.status.trim(),
    },
    { key, width },
  );
  if (error === "") return stream;
  return {
    type: "flex",
    key: `${key}:row`,
    style: { direction: "row", width, justifyContent: "space_between", alignItems: "center" },
    children: [stream, waitErrorText(error, `${key}:err`)],
  };
}

function faceFromCell(cell: WorkCellPaintInstance, key: string, collapsed: boolean): WorkCellFace {
  const receipt = receiptFromReplica(cell.receiptKind, cell.receiptText, {
    old: cell.diffOld,
    new: cell.diffNew,
    path: cell.diffPath,
    lineStart: cell.diffLineStart > 1 ? cell.diffLineStart : undefined,
  });
  return {
    key,
    state: cell.state,
    name: cell.name,
    object: cell.object,
    status: cell.status,
    caption: cell.caption,
    pathShaped: !cell.pretty && isPathShapedName(cell.name),
    split: cell.split,
    agent: cell.agent,
    pretty: cell.pretty,
    prettyBlock: cell.prettyBlock,
    response: cell.response,
    indent: cell.indent,
    collapsed,
    receipt,
    rimNamed:
      cell.split ||
      cell.agent ||
      cell.name === "edit_file" ||
      cell.name === "write_file" ||
      cell.name === "read_file" ||
      cell.name === "list_dir" ||
      cell.name === "grep" ||
      cell.name === "glob" ||
      cell.name === "fff_search",
  };
}

export class ComposerWidget extends RetainedAdapter {
  protected watch(): void {
    this.observe(() => {
      const composer = this.node as ComposerPaintInstance;
      const echo = this.ctx.local?.echo;
      return [
        composer.draft,
        composer.cursor,
        composer.mark,
        composer.interactive,
        composer.readOnly,
        composer.mode,
        composer.placeholder,
        composer.annotation,
        composer.joinAnnotation,
        composer.hotkeys,
        composer.errorLevel,
        composer.errorMessage,
        composer.statusItems,
        composer.quotaWindows,
        composer.contextUsed,
        composer.contextLimit,
        composer.contourRole,
        composer.progress,
        composer.progressColor,
        composer.progressGlowAt,
        composer.progressAnnotation,
        composer.commandChoices,
        composer.commandAction,
        composer.selectedCommandKey,
        composer.scrollOffset,
        composer.stackedBody,
        composer.stackedViewport,
        composer.stackedNumbered,
        composer.stackedLang,
        this.ctx.syntaxPolarity(),
        this.ctx.syntaxWarm(),
        echo?.predicted?.draft ?? null,
        echo?.predicted?.cursor ?? null,
        echo?.predicted?.mark ?? null,
        this.ctx.local?.modHeld ?? false,
      ];
    });
  }

  protected rebuild(width: number): LayoutNode {
    const composer = this.node as ComposerPaintInstance;
    const predicted = composer.interactive ? (this.ctx.local?.echo.predicted ?? null) : null;
    const draft = predicted?.draft ?? composer.draft;
    const cursor = predicted?.cursor ?? composer.cursor;
    const mark = predicted === null ? composer.mark : predicted.mark;
    return ComposerFrame(
      {
        inputValue: draft,
        cursor,
        mark,
        interactive: composer.interactive,
        readOnly: composer.readOnly === true ? true : undefined,
        placeholder: emptyToUndef(composer.placeholder),
        annotation: emptyToUndef(composer.annotation),
        joinAnnotation: emptyToUndef(composer.joinAnnotation),
        hotkeys: composer.hotkeys.length > 0 ? composer.hotkeys : undefined,
        errorAnnotation:
          composer.errorLevel !== null && composer.errorMessage !== ""
            ? { level: composer.errorLevel, message: composer.errorMessage }
            : undefined,
        statusItems: composer.statusItems.length > 0 ? composer.statusItems : undefined,
        quotaWindows: composer.quotaWindows.length > 0 ? composer.quotaWindows : undefined,
        contextUsed: composer.contextLimit > 0 || composer.contextUsed > 0 ? composer.contextUsed : undefined,
        contextLimit: composer.contextLimit > 0 ? composer.contextLimit : undefined,
        contourRole: composer.contourRole === "" ? undefined : composer.contourRole,
        progress: composer.progress ?? undefined,
        progressColor: composer.progressColor === "" ? undefined : composer.progressColor,
        progressGlowAt: composer.progressGlowAt ?? undefined,
        progressAnnotation: composer.progressAnnotation === "" ? undefined : composer.progressAnnotation,
        commandChoices: (composer.commandChoices ?? undefined) as readonly ComposerCommandChoice[] | undefined,
        commandAction: (composer.commandAction ?? undefined) as ComposerCommandFallback | undefined,
        selectedCommandKey: composer.selectedCommandKey,
        scrollOffset: composer.scrollOffset,
        stackedBody: emptyToUndef(composer.stackedBody),
        stackedViewport: composer.stackedViewport > 0 ? composer.stackedViewport : undefined,
        stackedNumbered: composer.stackedNumbered === true ? true : undefined,
        stackedLang: emptyToUndef(composer.stackedLang),
        modHeld: this.ctx.local?.modHeld === true,
      },
      { key: "composer:frame", width },
    );
  }
}

function emptyToUndef(value: string): string | undefined {
  return value === "" ? undefined : value;
}

export class AgentsWidget extends RetainedAdapter {
  protected watch(): void {
    this.observe(() => {
      const agents = this.node as AgentsPaintInstance;
      return [agents.open, agents.focusKey, agents.scroll, agents.rows, agents.previewKey];
    });
  }

  protected rebuild(width: number): LayoutNode {
    const agents = this.node as AgentsPaintInstance;
    const face: AgentsReplicaFace = {
      meterLeft: agents.meterLeft,
      meterRight: agents.meterRight,
      open: agents.open,
      focusKey: agents.focusKey,
      scroll: agents.scroll,
      rows: agents.rows,
      previewKey: agents.previewKey,
    };
    return prepareAgentsDrawer(face, width);
  }
}

export class StackWidget extends RetainedAdapter {
  #partsCache: { width: number; collect: TapeCollect } | null = null;

  protected watch(): void {
    this.observe(() => paintChildrenOf(this.node).map((child) => child));
    this.observe(() => this.ctx.local?.tapeExpanded === true);
    // Fuse is a filter, not a child identity. A floor row appears and
    // disappears without the node being replaced.
    this.observe(() =>
      paintChildrenOf(this.node).map((child) =>
        child.kind === "tool" || child.kind === "scheme" ? (child as WorkCellPaintInstance).fuse : false,
      ),
    );
  }

  override markDirty(): void {
    this.#partsCache = null;
    super.markDirty();
  }

  collectParts(width: number): TapeCollect {
    return untracked((): TapeCollect => {
      if (this.#partsCache !== null && this.#partsCache.width === width) {
        recordPrepare(this.node.kind, true);
        return this.#partsCache.collect;
      }
      const collect =
        this.node.kind === "turn"
          ? partsForTurnPaint(this.node, this, width)
          : collectTapeParts(this.node, this, width);
      this.#partsCache = { width, collect };
      recordPrepare(this.node.kind, false);
      return collect;
    });
  }

  protected rebuild(width: number): LayoutNode {
    if (this.node.kind === "root") {
      const children: LayoutNode[] = [];
      const birth: BirthSite[] = [];
      const progress: ProgressSite[] = [];
      for (const child of paintChildrenOf(this.node)) {
        if (
          child.kind === "composer" ||
          child.kind === "ask" ||
          child.kind === "wait" ||
          child.kind === "statusline" ||
          child.kind === "agents" ||
          child.kind === "preview" ||
          child.kind === "rewind"
        ) {
          continue;
        }
        children.push(takePrepared(child, this, width, birth, progress));
      }
      this.keepSites(birth, progress);
      const key = this.ctx.host.localFor(this.node).hitKey;
      return { type: "box", key, children };
    }
    const collected = collectTapeParts(this.node, this, width);
    this.keepSites(collected.birth, collected.progress);
    return transcriptColumn(collected.parts, width);
  }
}

function bandOf(node: PaintNodeInstance): TranscriptPart["band"] {
  return node.kind === "speech" && node.voice === "user" ? "input" : "work";
}

type TapeCollect = {
  parts: TranscriptPart[];
  birth: BirthSite[];
  progress: ProgressSite[];
};

function takePrepared(
  child: PaintNodeInstance,
  parent: RetainedAdapter,
  width: number,
  birth: BirthSite[],
  progress: ProgressSite[],
): LayoutNode {
  const prepared = parent.ctx.host.widgetFor(child, parent).prepare(width);
  birth.push(...prepared.birthSites);
  progress.push(...prepared.progressSites);
  return prepared.root;
}

function collectTapeParts(node: PaintNodeInstance, parent: RetainedAdapter, width: number): TapeCollect {
  if (node.kind === "turn") return partsForTurnPaint(node, parent, width);
  const parts: TranscriptPart[] = [];
  const birth: BirthSite[] = [];
  const progress: ProgressSite[] = [];
  for (const child of paintChildrenOf(node)) {
    if (
      child.kind === "composer" ||
      child.kind === "ask" ||
      child.kind === "wait" ||
      child.kind === "agents" ||
      child.kind === "preview" ||
      child.kind === "rewind"
    ) {
      continue;
    }
    if (child.kind === "turn" || child.kind === "stack") {
      const childWidget = parent.ctx.host.widgetFor(child, parent) as StackWidget;
      const inner = childWidget.collectParts(width);
      parts.push(...inner.parts);
      birth.push(...inner.birth);
      progress.push(...inner.progress);
      continue;
    }
    parts.push({
      band: bandOf(child),
      key: parent.ctx.host.localFor(child).hitKey,
      node: takePrepared(child, parent, width, birth, progress),
    });
  }
  return { parts, birth, progress };
}

function partsForTurnPaint(turn: PaintNodeInstance, parent: RetainedAdapter, width: number): TapeCollect {
  const items: TapeItem<PaintNodeInstance>[] = [];
  for (const child of paintChildrenOf(turn)) {
    if (child.kind === "composer" || child.kind === "ask" || child.kind === "wait" || child.kind === "agents") {
      continue;
    }
    if (child.kind === "speech" && child.voice === "user") {
      items.push({ kind: "user", node: child });
      continue;
    }
    if (child.kind === "recall" || child.kind === "compact") {
      items.push({ kind: "recall", node: child });
      continue;
    }
    if (child.kind === "tool" || child.kind === "scheme" || child.kind === "loop") {
      items.push({ kind: "tool", node: child });
      continue;
    }
    if (child.kind !== "completion") continue;
    const completion = child as CompletionPaintInstance;
    parent.ctx.host.widgetFor(completion, parent);
    const slots = slotsOf(completion);
    const hasThought = hasThoughtRow(slots);
    const hasSpeech = slots.showSpeech || slots.showFailure;
    if (hasSpeech) {
      items.push({
        kind: "speech",
        node: completion,
        thought: hasThought ? completion : null,
      });
    } else if (hasThought) {
      items.push({ kind: "thought-only", node: completion });
    } else if (completion.debugNote.trim() !== "") {
      // Tool-only ReACT round: no speech/thought row, still a cache mark.
      items.push({ kind: "recall", node: completion });
    }
  }
  // Peek is a viewer: identity rows stay, independent of host Ctrl-O.
  let expanded = parent.ctx.local?.tapeExpanded === true;
  if (!expanded) {
    for (
      let cur: RetainedAdapter | null = parent;
      cur !== null;
      cur = cur.parent instanceof RetainedAdapter ? cur.parent : null
    ) {
      if (cur.node.kind === "preview") {
        expanded = true;
        break;
      }
    }
  }
  const density = expanded ? items : filterFusedTools(items, cellFuses);
  const spans = groupTapeSpans(density);
  let lastThought = -1;
  for (const [i, span] of spans.entries()) {
    if (span!.kind === "thoughts") lastThought = i;
  }
  const parts: TranscriptPart[] = [];
  const birth: BirthSite[] = [];
  const progress: ProgressSite[] = [];
  for (const [i, span_] of spans.entries()) {
    const span = span_!;
    if (span.kind === "user" || span.kind === "recall" || span.kind === "speech") {
      if (span.kind === "recall" && span.node.kind === "completion") {
        pushCacheMark(parts, span.node as CompletionPaintInstance, parent);
        continue;
      }
      parts.push({
        band: bandOf(span.node),
        slot: span.kind === "speech" ? "speech" : undefined,
        key: parent.ctx.host.localFor(span.node).hitKey,
        node: takePrepared(span.node, parent, width, birth, progress),
      });
      if (span.kind === "speech") {
        pushCacheMark(parts, span.node as CompletionPaintInstance, parent);
      }
      continue;
    }
    if (span.kind === "tools") {
      for (const cell of span.nodes) {
        parts.push({
          band: "work",
          slot: "tool",
          key: parent.ctx.host.localFor(cell).hitKey,
          node: takePrepared(cell, parent, width, birth, progress),
        });
      }
      continue;
    }
    const node = thoughtSpanNode(span.nodes as CompletionPaintInstance[], parent, width, i === lastThought);
    if (node !== undefined) {
      parts.push({
        band: "work",
        slot: "thought",
        key: node.key ?? parent.ctx.host.localFor(span.nodes[0]!).hitKey,
        node,
      });
      birth.push(...collectBirthSites(node));
      progress.push(...collectProgressSites(node));
    }
    for (const completion of span.nodes as CompletionPaintInstance[]) {
      const slots = slotsOf(completion);
      if (slots.showSpeech || slots.showFailure) continue;
      pushCacheMark(parts, completion, parent);
    }
  }
  return { parts, birth, progress };
}

function pushCacheMark(parts: TranscriptPart[], completion: CompletionPaintInstance, parent: RetainedAdapter): void {
  const note = completion.debugNote.trim();
  if (note === "") return;
  const key = `${parent.ctx.host.localFor(completion).hitKey}:cache`;
  parts.push({
    band: "work",
    key,
    node: Recall(note, { key }),
  });
}

function cellFuses(node: PaintNodeInstance): boolean {
  if (node.kind === "loop") return false;
  if (node.kind !== "tool" && node.kind !== "scheme") return false;
  return (node as WorkCellPaintInstance).fuse === true;
}

function slotsOf(completion: CompletionPaintInstance) {
  const speech = speechOf(completion);
  const thinking = thinkingOf(completion);
  const failure = failureOf(completion);
  return completionSlots({
    live: completion.state === "live",
    failed: completion.state === "failed",
    workerPresent: completion.workerPresent,
    speech: speech.text,
    thought: thinking.text,
    failure: failure.endDetail.trim() || failure.failReason.trim(),
  });
}

function thoughtSpanNode(
  completions: readonly CompletionPaintInstance[],
  parent: RetainedAdapter,
  width: number,
  latestSpan: boolean,
): LayoutNode | undefined {
  const first = completions[0];
  if (first === undefined) return undefined;
  const texts: string[] = [];
  let agentLabel: string | undefined;
  const kinds: string[] = [];
  const clockMembers: { live: boolean; startedAt: number | null; durationMs: number | null }[] = [];
  let retryUntilMs: number | undefined;
  for (const completion of completions) {
    const thinking = thinkingOf(completion);
    parent.ctx.host.widgetFor(thinking, parent.ctx.host.widgetFor(completion, parent));
    const body = thinking.text.replaceAll(/^\s+|\s+$/gu, "");
    if (body !== "") texts.push(body);
    kinds.push(completion.thoughtKind);
    clockMembers.push({
      live: completion.thoughtLive,
      startedAt: completion.startedAt,
      durationMs: completion.durationMs,
    });
    if (completion.retryUntilMs != null && Number.isFinite(completion.retryUntilMs)) {
      retryUntilMs = completion.retryUntilMs;
    }
    if (agentLabel === undefined && completion.model.trim() !== "") agentLabel = completion.model;
  }
  const clock = clusterThoughtClock(clockMembers);
  const thinking = thinkingOf(first);
  const local = parent.ctx.host.localFor(thinking);
  const latest = clock.live || latestSpan;
  const bootstrapping =
    clock.live &&
    completions.some((completion) => completion.thoughtLive && !completion.workerPresent) &&
    !completions.some((completion) => completion.thoughtLive && completion.workerPresent);
  return ThinkingStream(
    {
      text: texts.join("\n\n"),
      live: clock.live,
      collapsed: local.collapsed,
      seal: clock.live ? "live" : "sealed",
      latest,
      startedAt: clock.startedAt,
      durationMs: clock.durationMs,
      retryUntilMs,
      bootstrapping,
      thoughtKind: kinds.includes("raw") ? "raw" : kinds.includes("summary") ? "summary" : "",
      agentLabel,
    },
    { key: `${local.hitKey}:thought`, width },
  );
}
