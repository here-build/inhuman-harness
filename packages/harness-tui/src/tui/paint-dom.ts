/**
 * Paint DOM — recursive MST of serializable widget intent. Width-independent.
 * Writer and reader share these models. The TUI mutates the reader only through
 * applyPatch; declared actions are the worker write API.
 */
import type { ChromeHotkey, ChromeQuotaWindow, ChromeStatusItem } from "@inhuman.tools/quickdraw/layout";
import equal from "fast-deep-equal";
import { detach, types, type IAnyType, type Instance, type SnapshotOut } from "mobx-state-tree";

import type { AgentsReplicaFace } from "./agents-drawer.js";
import type {
  CompletionPaintState,
  ComposerErrorLevel,
  ComposerPaintMode,
  WorkCellPaintState,
  WorkReceiptKind,
} from "./paint-types.js";

function lateNode(): typeof PaintNode {
  return PaintNode;
}

/** Replica / identity can hand `null` on first paint. MST strings refuse it. */
function faceText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const paintChildren = types.array(types.late(lateNode));

export type SpeechVoice = "user" | "assistant";

const SpeechPaint = types
  .model("SpeechPaint", {
    kind: types.literal("speech"),
    text: types.optional(types.string, ""),
    voice: types.optional(types.enumeration<SpeechVoice>(["user", "assistant"]), "assistant"),
    atMs: types.optional(types.maybeNull(types.number), null),
    /** Selected pin: chrome_frame plus session-title annotation. */
    recap: types.optional(types.boolean, false),
    recapHotkeys: types.optional(types.frozen<readonly ChromeHotkey[]>(), []),
    annotation: types.optional(types.string, ""),
  })
  .actions((self) => ({
    updateText(next: string) {
      if (self.text === next) return;
      self.text = next;
    },
    setVoice(next: SpeechVoice) {
      if (self.voice === next) return;
      self.voice = next;
    },
    setAtMs(next: number | null) {
      if (self.atMs === next) return;
      self.atMs = next;
    },
    setRecap(next: boolean, annotation = "", hotkeys: readonly ChromeHotkey[] = []) {
      if (self.recap === next && self.annotation === annotation && equal(self.recapHotkeys, hotkeys)) return;
      self.recapHotkeys = next ? hotkeys : [];
      self.recap = next;
      self.annotation = next ? annotation : "";
    },
  }));

const ThinkingPaint = types
  .model("ThinkingPaint", {
    kind: types.literal("thinking"),
    text: types.optional(types.string, ""),
  })
  .actions((self) => ({
    updateText(next: string) {
      if (self.text === next) return;
      self.text = next;
    },
  }));

const FailurePaint = types
  .model("FailurePaint", {
    kind: types.literal("failure"),
    endDetail: types.optional(types.string, ""),
    failReason: types.optional(types.string, ""),
  })
  .actions((self) => ({
    updateEndDetail(next: string) {
      if (self.endDetail === next) return;
      self.endDetail = next;
    },
    updateFailReason(next: string) {
      if (self.failReason === next) return;
      self.failReason = next;
    },
  }));

const RecallPaint = types
  .model("RecallPaint", {
    kind: types.enumeration(["recall", "compact"]),
    text: types.optional(types.string, ""),
  })
  .actions((self) => ({
    updateText(next: string) {
      if (self.text === next) return;
      self.text = next;
    },
  }));

const WorkCellPaint = types
  .model("WorkCellPaint", {
    kind: types.enumeration(["tool", "scheme", "loop", "ask", "wait"]),
    toolCallId: types.optional(types.string, ""),
    name: types.optional(types.string, ""),
    object: types.optional(types.string, ""),
    status: types.optional(types.string, ""),
    caption: types.optional(types.string, ""),
    state: types.optional(types.enumeration<WorkCellPaintState>(["live", "ok", "fail", "ask", "judging"]), "live"),
    indent: types.optional(types.boolean, false),
    split: types.optional(types.boolean, false),
    agent: types.optional(types.boolean, false),
    pretty: types.optional(types.boolean, false),
    prettyBlock: types.optional(types.string, ""),
    response: types.optional(types.string, ""),
    receiptKind: types.optional(
      types.enumeration<WorkReceiptKind>([
        "none",
        "text",
        "markdown",
        "diff",
        "stream",
        "syntax",
        "number",
        "boolean",
        "parts",
      ]),
      "none",
    ),
    receiptText: types.optional(types.string, ""),
    diffOld: types.optional(types.string, ""),
    diffNew: types.optional(types.string, ""),
    diffPath: types.optional(types.string, ""),
    diffLineStart: types.optional(types.number, 0),
    /** see tape-spans.ts preamble, CHANGE ONLY. */
    fuse: types.optional(types.boolean, false),
    /** Wait pin: epoch ms when this occupancy row first appeared. Write-once. */
    startedAt: types.optional(types.maybeNull(types.number), null),
    /** Live backoff until this epoch ms. Wait pin only. */
    retryUntilMs: types.optional(types.maybeNull(types.number), null),
    children: types.optional(paintChildren, []),
  })
  .actions((self) => ({
    setFace(next: {
      toolCallId?: string;
      name: string;
      object: string;
      status: string;
      caption?: string;
      state: WorkCellPaintState;
      indent: boolean;
      split?: boolean;
      agent?: boolean;
      pretty?: boolean;
      prettyBlock?: string;
      response?: string;
      receiptKind: WorkReceiptKind;
      receiptText: string;
      diffOld: string;
      diffNew: string;
      diffPath: string;
      diffLineStart?: number;
      fuse?: boolean;
      startedAt?: number | null;
      retryUntilMs?: number | null;
    }) {
      if (next.toolCallId !== undefined) {
        const toolCallId = faceText(next.toolCallId);
        if (self.toolCallId !== toolCallId) self.toolCallId = toolCallId;
      }
      const name = faceText(next.name);
      const object = faceText(next.object);
      const status = faceText(next.status);
      if (self.name !== name) self.name = name;
      if (self.object !== object) self.object = object;
      if (self.status !== status) self.status = status;
      if (next.caption !== undefined) {
        const caption = faceText(next.caption);
        if (self.caption !== caption) self.caption = caption;
      }
      if (self.state !== next.state) self.state = next.state;
      if (self.indent !== next.indent) self.indent = next.indent;
      if (next.split !== undefined && self.split !== next.split) self.split = next.split;
      if (next.agent !== undefined && self.agent !== next.agent) self.agent = next.agent;
      if (next.pretty !== undefined && self.pretty !== next.pretty) self.pretty = next.pretty;
      if (next.prettyBlock !== undefined) {
        const prettyBlock = faceText(next.prettyBlock);
        if (self.prettyBlock !== prettyBlock) self.prettyBlock = prettyBlock;
      }
      if (next.response !== undefined) {
        const response = faceText(next.response);
        if (self.response !== response) self.response = response;
      }
      if (self.receiptKind !== next.receiptKind) self.receiptKind = next.receiptKind;
      const receiptText = faceText(next.receiptText);
      const diffOld = faceText(next.diffOld);
      const diffNew = faceText(next.diffNew);
      const diffPath = faceText(next.diffPath);
      if (self.receiptText !== receiptText) self.receiptText = receiptText;
      if (self.diffOld !== diffOld) self.diffOld = diffOld;
      if (self.diffNew !== diffNew) self.diffNew = diffNew;
      if (self.diffPath !== diffPath) self.diffPath = diffPath;
      if (next.diffLineStart !== undefined && self.diffLineStart !== next.diffLineStart) {
        self.diffLineStart = next.diffLineStart;
      }
      if (next.fuse !== undefined && self.fuse !== next.fuse) self.fuse = next.fuse;
      if (next.startedAt != null && Number.isFinite(next.startedAt) && self.startedAt == null) {
        self.startedAt = next.startedAt;
      }
      if (next.retryUntilMs !== undefined) {
        const retryUntilMs = next.retryUntilMs != null && Number.isFinite(next.retryUntilMs) ? next.retryUntilMs : null;
        if (self.retryUntilMs !== retryUntilMs) self.retryUntilMs = retryUntilMs;
      }
    },
  }));

const CompletionPaint = types
  .model("CompletionPaint", {
    kind: types.literal("completion"),
    state: types.optional(types.enumeration<CompletionPaintState>(["live", "successful", "failed"]), "live"),
    workerPresent: types.optional(types.boolean, false),
    model: types.optional(types.string, ""),
    startedAt: types.optional(types.maybeNull(types.number), null),
    durationMs: types.optional(types.maybeNull(types.number), null),
    thoughtLive: types.optional(types.boolean, false),
    /** Live backoff until this epoch ms. Null when not waiting to retry. */
    retryUntilMs: types.optional(types.maybeNull(types.number), null),
    /** `summary` when the visible thought is a provider summary, not CoT. */
    thoughtKind: types.optional(types.string, ""),
    /** DEBUG=* cache-invariant mark. Empty when aligned or not debug. */
    debugNote: types.optional(types.string, ""),
    children: types.optional(paintChildren, []),
  })
  .actions((self) => ({
    setState(next: CompletionPaintState) {
      if (self.state === next) return;
      self.state = next;
    },
    setWorkerPresent(next: boolean) {
      if (self.workerPresent === next) return;
      self.workerPresent = next;
    },
    setModel(next: string) {
      if (self.model === next) return;
      self.model = next;
    },
    setStartedAt(next: number | null) {
      if (self.startedAt === next) return;
      self.startedAt = next;
    },
    setDurationMs(next: number | null) {
      if (self.durationMs === next) return;
      self.durationMs = next;
    },
    setThoughtLive(next: boolean) {
      if (self.thoughtLive === next) return;
      self.thoughtLive = next;
    },
    setRetryUntilMs(next: number | null) {
      if (self.retryUntilMs === next) return;
      self.retryUntilMs = next;
    },
    setThoughtKind(next: string) {
      if (self.thoughtKind === next) return;
      self.thoughtKind = next;
    },
    setDebugNote(next: string) {
      if (self.debugNote === next) return;
      self.debugNote = next;
    },
  }));

function childHostActions(self: { children: object[] }) {
  return {
    appendChild(node: object) {
      self.children.push(node);
    },
    insertChildAt(index: number, node: object) {
      self.children.splice(index, 0, node);
    },
    removeChildAt(index: number) {
      self.children.splice(index, 1);
    },
    /** Reorder without MST-killing the node. splice-remove destroys; detach does not. */
    placeChild(index: number, node: object) {
      if (self.children[index] === node) return;
      const at = self.children.indexOf(node);
      if (at !== -1) detach(self.children[at] as never);
      self.children.splice(index, 0, node);
    },
  };
}

const TurnPaint = types
  .model("TurnPaint", {
    kind: types.literal("turn"),
    children: types.optional(paintChildren, []),
  })
  .actions((self) => childHostActions(self));

const StackPaint = types
  .model("StackPaint", {
    kind: types.literal("stack"),
    children: types.optional(paintChildren, []),
  })
  .actions((self) => childHostActions(self));

const PreviewPaint = types
  .model("PreviewPaint", {
    kind: types.literal("preview"),
    children: types.optional(paintChildren, []),
  })
  .actions((self) => childHostActions(self));

const RewindPaint = types
  .model("RewindPaint", {
    kind: types.literal("rewind"),
    atTip: types.optional(types.boolean, true),
    seatRim: types.optional(types.boolean, true),
    past: types.optional(types.frozen<readonly { key: string; text: string }[]>(), []),
    future: types.optional(types.frozen<readonly { key: string; text: string }[]>(), []),
    pastTotal: types.optional(types.number, 0),
    futureTotal: types.optional(types.number, 0),
  })
  .actions((self) => ({
    setFace(
      atTip: boolean,
      past: readonly { key: string; text: string }[],
      future: readonly { key: string; text: string }[],
      pastTotal = past.length,
      futureTotal = future.length,
      seatRim = atTip,
    ) {
      if (
        self.atTip === atTip &&
        self.seatRim === seatRim &&
        self.pastTotal === pastTotal &&
        self.futureTotal === futureTotal &&
        equal(self.past, past) &&
        equal(self.future, future)
      ) {
        return;
      }
      self.atTip = atTip;
      self.seatRim = seatRim;
      self.past = past;
      self.future = future;
      self.pastTotal = pastTotal;
      self.futureTotal = futureTotal;
    },
  }));

export const RootPaint = types
  .model("RootPaint", {
    kind: types.literal("root"),
    children: types.optional(paintChildren, []),
  })
  .actions((self) => childHostActions(self));

const StatuslinePaint = types
  .model("StatuslinePaint", {
    kind: types.literal("statusline"),
    cwd: types.optional(types.string, ""),
    /** Bright prefix of `cwd` (git root). Empty = paint `cwd` as one span. */
    cwdRoot: types.optional(types.string, ""),
    left: types.optional(types.string, ""),
    /** Checkout clause, quieter than `left`. Empty omits it. */
    note: types.optional(types.string, ""),
  })
  .actions((self) => ({
    setCwd(next: string) {
      if (self.cwd === next) return;
      self.cwd = next;
    },
    setCwdRoot(next: string) {
      if (self.cwdRoot === next) return;
      self.cwdRoot = next;
    },
    setLeft(next: string) {
      if (self.left === next) return;
      self.left = next;
    },
    setNote(next: string) {
      if (self.note === next) return;
      self.note = next;
    },
  }));

const AgentsPaint = types
  .model("AgentsPaint", {
    kind: types.literal("agents"),
    meterLeft: types.optional(types.string, ""),
    meterRight: types.optional(types.string, ""),
    open: types.optional(types.boolean, false),
    focusKey: types.optional(types.string, ""),
    scroll: types.optional(types.number, 0),
    rows: types.optional(types.frozen<AgentsReplicaFace["rows"]>(), []),
    previewKey: types.optional(types.string, ""),
  })
  .actions((self) => ({
    setFace(next: AgentsReplicaFace) {
      const meterLeft = faceText(next.meterLeft);
      const meterRight = faceText(next.meterRight);
      const focusKey = faceText(next.focusKey);
      const previewKey = faceText(next.previewKey);
      if (self.meterLeft !== meterLeft) self.meterLeft = meterLeft;
      if (self.meterRight !== meterRight) self.meterRight = meterRight;
      if (self.open !== next.open) self.open = next.open;
      if (self.focusKey !== focusKey) self.focusKey = focusKey;
      if (self.scroll !== next.scroll) self.scroll = next.scroll;
      if (!equal(self.rows, next.rows)) self.rows = next.rows;
      if (self.previewKey !== previewKey) self.previewKey = previewKey;
    },
  }));

const ComposerPaint = types
  .model("ComposerPaint", {
    kind: types.literal("composer"),
    /** Painted face. Secret mode is already masked; raw secret never lives here. */
    draft: types.optional(types.string, ""),
    cursor: types.optional(types.number, 0),
    mark: types.optional(types.maybeNull(types.number), null),
    interactive: types.optional(types.boolean, true),
    readOnly: types.optional(types.boolean, false),
    mode: types.optional(types.enumeration<ComposerPaintMode>(["normal", "secret", "isolated", "waiting"]), "normal"),
    placeholder: types.optional(types.string, ""),
    annotation: types.optional(types.string, ""),
    joinAnnotation: types.optional(types.string, ""),
    hotkeys: types.optional(types.frozen<readonly ChromeHotkey[]>(), []),
    errorLevel: types.optional(types.maybeNull(types.enumeration<ComposerErrorLevel>(["warning", "error"])), null),
    errorMessage: types.optional(types.string, ""),
    statusItems: types.optional(types.frozen<readonly ChromeStatusItem[]>(), []),
    quotaWindows: types.optional(types.frozen<readonly ChromeQuotaWindow[]>(), []),
    contextUsed: types.optional(types.number, 0),
    contextLimit: types.optional(types.number, 0),
    contourRole: types.optional(types.string, ""),
    progress: types.optional(types.maybeNull(types.number), null),
    progressColor: types.optional(types.string, ""),
    progressGlowAt: types.optional(types.maybeNull(types.number), null),
    progressAnnotation: types.optional(types.string, ""),
    commandChoices: types.optional(types.maybeNull(types.frozen()), null),
    commandAction: types.optional(types.maybeNull(types.frozen()), null),
    selectedCommandKey: types.optional(types.maybeNull(types.string), null),
    scrollOffset: types.optional(types.number, 0),
    stackedBody: types.optional(types.string, ""),
    stackedViewport: types.optional(types.number, 0),
    stackedNumbered: types.optional(types.boolean, false),
    stackedLang: types.optional(types.string, ""),
    children: types.optional(paintChildren, []),
  })
  .actions((self) => ({
    setDraft(next: string) {
      if (self.draft === next) return;
      self.draft = next;
    },
    setCursor(next: number) {
      if (self.cursor === next) return;
      self.cursor = next;
    },
    setMark(next: number | null) {
      if (self.mark === next) return;
      self.mark = next;
    },
    setInteractive(next: boolean) {
      if (self.interactive === next) return;
      self.interactive = next;
    },
    setReadOnly(next: boolean) {
      if (self.readOnly === next) return;
      self.readOnly = next;
    },
    setMode(next: ComposerPaintMode) {
      if (self.mode === next) return;
      self.mode = next;
    },
    setPlaceholder(next: string) {
      if (self.placeholder === next) return;
      self.placeholder = next;
    },
    setAnnotation(next: string) {
      if (self.annotation === next) return;
      self.annotation = next;
    },
    setJoinAnnotation(next: string) {
      if (self.joinAnnotation === next) return;
      self.joinAnnotation = next;
    },
    setHotkeys(next: readonly ChromeHotkey[]) {
      if (equal(self.hotkeys, next)) return;
      self.hotkeys = next;
    },
    setError(level: ComposerErrorLevel | null, message: string) {
      if (self.errorLevel === level && self.errorMessage === message) return;
      self.errorLevel = level;
      self.errorMessage = message;
    },
    setStatusItems(next: readonly ChromeStatusItem[]) {
      if (equal(self.statusItems, next)) return;
      self.statusItems = next;
    },
    setQuotaWindows(next: readonly ChromeQuotaWindow[]) {
      if (equal(self.quotaWindows, next)) return;
      self.quotaWindows = next;
    },
    setContextUsed(next: number) {
      if (self.contextUsed === next) return;
      self.contextUsed = next;
    },
    setContextLimit(next: number) {
      if (self.contextLimit === next) return;
      self.contextLimit = next;
    },
    setContourRole(next: string) {
      if (self.contourRole === next) return;
      self.contourRole = next;
    },
    setProgress(next: number | null) {
      if (self.progress === next) return;
      self.progress = next;
    },
    setProgressColor(next: string) {
      if (self.progressColor === next) return;
      self.progressColor = next;
    },
    setProgressGlowAt(next: number | null) {
      if (self.progressGlowAt === next) return;
      self.progressGlowAt = next;
    },
    setProgressAnnotation(next: string) {
      if (self.progressAnnotation === next) return;
      self.progressAnnotation = next;
    },
    setCommandChoices(next: unknown) {
      if (equal(self.commandChoices, next)) return;
      self.commandChoices = next;
    },
    setCommandAction(next: unknown) {
      if (equal(self.commandAction, next)) return;
      self.commandAction = next;
    },
    setSelectedCommandKey(next: string | null) {
      if (self.selectedCommandKey === next) return;
      self.selectedCommandKey = next;
    },
    setScrollOffset(next: number) {
      if (self.scrollOffset === next) return;
      self.scrollOffset = next;
    },
    setStackedBody(next: string) {
      if (self.stackedBody === next) return;
      self.stackedBody = next;
    },
    setStackedViewport(next: number) {
      if (self.stackedViewport === next) return;
      self.stackedViewport = next;
    },
    setStackedNumbered(next: boolean) {
      if (self.stackedNumbered === next) return;
      self.stackedNumbered = next;
    },
    setStackedLang(next: string) {
      if (self.stackedLang === next) return;
      self.stackedLang = next;
    },
    appendChild(node: object) {
      self.children.push(node);
    },
    removeChildAt(index: number) {
      self.children.splice(index, 1);
    },
  }));

const KIND: Record<string, IAnyType> = {
  speech: SpeechPaint,
  thinking: ThinkingPaint,
  failure: FailurePaint,
  recall: RecallPaint,
  compact: RecallPaint,
  completion: CompletionPaint,
  tool: WorkCellPaint,
  scheme: WorkCellPaint,
  loop: WorkCellPaint,
  ask: WorkCellPaint,
  wait: WorkCellPaint,
  turn: TurnPaint,
  stack: StackPaint,
  preview: PreviewPaint,
  rewind: RewindPaint,
  root: RootPaint,
  composer: ComposerPaint,
  statusline: StatuslinePaint,
  agents: AgentsPaint,
};

function dispatchPaint(snapshot: unknown): IAnyType {
  const kind =
    snapshot !== null && typeof snapshot === "object" && "kind" in snapshot
      ? String((snapshot as { kind: unknown }).kind)
      : "";
  const model = KIND[kind];
  if (model === undefined) {
    throw new Error(`unknown paint kind ${kind === "" ? "<missing>" : kind}`);
  }
  return model;
}

export const PaintNode = types.union({ dispatcher: dispatchPaint }, ...new Set(Object.values(KIND)));

export type SpeechPaintInstance = Instance<typeof SpeechPaint>;
export type ThinkingPaintInstance = Instance<typeof ThinkingPaint>;
export type FailurePaintInstance = Instance<typeof FailurePaint>;
export type RecallPaintInstance = Instance<typeof RecallPaint>;
export type CompletionPaintInstance = Instance<typeof CompletionPaint>;
export type TurnPaintInstance = Instance<typeof TurnPaint>;
export type StackPaintInstance = Instance<typeof StackPaint>;
export type PreviewPaintInstance = Instance<typeof PreviewPaint>;
export type RewindPaintInstance = Instance<typeof RewindPaint>;
export type RootPaintInstance = Instance<typeof RootPaint>;
export type ComposerPaintInstance = Instance<typeof ComposerPaint>;
export type StatuslinePaintInstance = Instance<typeof StatuslinePaint>;
export type AgentsPaintInstance = Instance<typeof AgentsPaint>;
export type WorkCellPaintInstance = Instance<typeof WorkCellPaint>;
export type PaintNodeInstance =
  | SpeechPaintInstance
  | ThinkingPaintInstance
  | FailurePaintInstance
  | RecallPaintInstance
  | CompletionPaintInstance
  | TurnPaintInstance
  | StackPaintInstance
  | PreviewPaintInstance
  | RewindPaintInstance
  | RootPaintInstance
  | ComposerPaintInstance
  | StatuslinePaintInstance
  | AgentsPaintInstance
  | WorkCellPaintInstance;
export type PaintRootSnapshot = SnapshotOut<typeof RootPaint>;

/** MST `types.late` cannot name the recursive union; the dispatcher already minted each child. */
export function paintChildrenOf(node: object): readonly PaintNodeInstance[] {
  if (!("children" in node)) return [];
  const { children } = node;
  if (!Array.isArray(children)) return [];
  return children as readonly PaintNodeInstance[];
}

export function createPaintRoot(): RootPaintInstance {
  return RootPaint.create({ kind: "root", children: [] });
}

export function createCompletion(
  fields: {
    state?: CompletionPaintState;
    workerPresent?: boolean;
    model?: string;
    startedAt?: number | null;
    durationMs?: number | null;
    thoughtLive?: boolean;
    retryUntilMs?: number | null;
    thoughtKind?: string;
  } = {},
): CompletionPaintInstance {
  return CompletionPaint.create({
    kind: "completion",
    state: fields.state ?? "live",
    workerPresent: fields.workerPresent ?? false,
    model: fields.model ?? "",
    startedAt: fields.startedAt ?? null,
    durationMs: fields.durationMs ?? null,
    thoughtLive: fields.thoughtLive ?? false,
    retryUntilMs: fields.retryUntilMs ?? null,
    thoughtKind: fields.thoughtKind ?? "",
    children: [
      { kind: "speech", text: "" },
      { kind: "thinking", text: "" },
      { kind: "failure", endDetail: "", failReason: "" },
    ],
  });
}

export function createTurn(): TurnPaintInstance {
  return TurnPaint.create({ kind: "turn", children: [] });
}

export function createStack(): StackPaintInstance {
  return StackPaint.create({ kind: "stack", children: [] });
}

export function createPreview(): PreviewPaintInstance {
  return PreviewPaint.create({ kind: "preview", children: [] });
}

export function createRewind(): RewindPaintInstance {
  return RewindPaint.create({ kind: "rewind" });
}

export function createComposer(): ComposerPaintInstance {
  return ComposerPaint.create({ kind: "composer" });
}

export function createStatusline(): StatuslinePaintInstance {
  return StatuslinePaint.create({ kind: "statusline" });
}

export function createAgents(): AgentsPaintInstance {
  return AgentsPaint.create({ kind: "agents" });
}

export function createRecall(text = ""): RecallPaintInstance {
  return RecallPaint.create({ kind: "recall", text });
}

export function createCompact(text = ""): RecallPaintInstance {
  return RecallPaint.create({ kind: "compact", text });
}

export function createSpeech(
  text = "",
  voice: SpeechVoice = "assistant",
  atMs: number | null = null,
): SpeechPaintInstance {
  return SpeechPaint.create({ kind: "speech", text, voice, atMs });
}

export function createWorkCell(kind: "tool" | "scheme" | "loop" | "ask" | "wait"): WorkCellPaintInstance {
  return WorkCellPaint.create({ kind });
}

export function isPaintRootChrome(kind: string): boolean {
  return (
    kind === "composer" ||
    kind === "ask" ||
    kind === "wait" ||
    kind === "statusline" ||
    kind === "agents" ||
    kind === "preview" ||
    kind === "rewind"
  );
}

export function speechOf(node: CompletionPaintInstance): SpeechPaintInstance {
  const child = paintChildrenOf(node).at(0);
  if (child === undefined || child.kind !== "speech") {
    throw new Error("completion missing speech child");
  }
  return child;
}

export function thinkingOf(node: CompletionPaintInstance): ThinkingPaintInstance {
  const child = paintChildrenOf(node).at(1);
  if (child === undefined || child.kind !== "thinking") {
    throw new Error("completion missing thinking child");
  }
  return child;
}

export function failureOf(node: CompletionPaintInstance): FailurePaintInstance {
  const child = paintChildrenOf(node).at(2);
  if (child === undefined || child.kind !== "failure") {
    throw new Error("completion missing failure child");
  }
  return child;
}
