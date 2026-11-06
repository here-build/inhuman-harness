/**
 * Worker write tree. Tea reactions call into this; declared MST actions
 * equality-before-write. Attach the writer after the first populate.
 */
import { DefaultedMap } from "@here.build/collections";
import { trace } from "@inhuman.tools/harness-diagnostics";
import {
  type BlobPeek,
  CallJob,
  AgentCallNotification,
  cacheStatusNote,
  CompactJob,
  CompletionExpectation,
  contextNeedFromChunks,
  debugMode,
  FileMutateToolJob,
  isNoteClaimed,
  type KernelRoot,
  ProgrammaticJob,
  reactChunks,
  SessionTurn,
  tapeCompletion,
  ToolCallJob,
  shellTailOf,
  TurnApprovalNoteChunk,
  TurnNotificationChunk,
  TurnSteerChunk,
  type SessionAdmission,
} from "@inhuman.tools/harness-model";
import {
  shellFormatGeneration,
  agentCallName,
  compactJobPaintText,
  notificationPaintText,
  askPaintHead,
  createAskTapeCut,
  type EmptyWaitChrome,
} from "@inhuman.tools/harness-sdk/text";
import type { ChromeHotkey, ChromeQuotaWindow, ChromeStatusItem } from "@inhuman.tools/quickdraw/layout";
import type { ComposerCommandChoice, ComposerCommandFallback } from "@inhuman.tools/quickdraw/widgets";
import { comparer, computed, reaction, type IComputedValue, type IReactionDisposer } from "mobx";
import { destroy, isAlive, isStateTreeNode } from "mobx-state-tree";

import type { AgentsReplicaFace } from "./agents-drawer.js";
import {
  createAgents,
  createCompletion,
  createComposer,
  createPaintRoot,
  createPreview,
  createRewind,
  createStatusline,
  createCompact,
  createRecall,
  createSpeech,
  createStack,
  createTurn,
  createWorkCell,
  failureOf,
  speechOf,
  thinkingOf,
  type AgentsPaintInstance,
  type CompletionPaintInstance,
  type ComposerPaintInstance,
  type PreviewPaintInstance,
  type RewindPaintInstance,
  type StatuslinePaintInstance,
  type RecallPaintInstance,
  type RootPaintInstance,
  type SpeechPaintInstance,
  type TurnPaintInstance,
  type WorkCellPaintInstance,
} from "./paint-dom.js";
import { createPaintWriter, type PaintDownMessage, type PaintWriter } from "./paint-transport.js";
import type { CompletionPaintState, ComposerPaintMode } from "./paint-types.js";
import { workCellFace, workCellFuse, type CallStatus, type ReceiptFace, type WorkCellFace } from "./work-cells.js";

export type ComposerErrorFace = {
  readonly level: "warning" | "error";
  readonly message: string;
};

export type ComposerFace = {
  readonly draft: string;
  readonly cursor: number;
  readonly mark: number | null;
  readonly interactive: boolean;
  readonly readOnly?: boolean;
  readonly mode: ComposerPaintMode;
  readonly placeholder: string | undefined;
  readonly annotation: string | undefined;
  readonly joinAnnotation: string | undefined;
  readonly hotkeys: readonly ChromeHotkey[] | undefined;
  readonly errorAnnotation: ComposerErrorFace | null;
  readonly statusItems: readonly ChromeStatusItem[] | undefined;
  readonly quotaWindows: readonly ChromeQuotaWindow[] | undefined;
  readonly contextUsed: number | undefined;
  readonly contextLimit: number | undefined;
  readonly contourRole: string | undefined;
  readonly progress: number | undefined;
  readonly progressColor: string | undefined;
  readonly progressGlowAt: number | undefined;
  readonly progressAnnotation: string | undefined;
  readonly commandChoices: readonly ComposerCommandChoice[] | undefined;
  readonly commandAction: ComposerCommandFallback | undefined;
  readonly selectedCommandKey: string | null;
  readonly scrollOffset: number;
  readonly stackedBody: string | undefined;
  readonly stackedViewport: number | undefined;
  readonly stackedNumbered: boolean | undefined;
  readonly stackedLang: string | undefined;
};

export type ComposerFaceInput = {
  readonly oauthWaiting: boolean;
  readonly busy: boolean;
  readonly inputting: boolean;
  readonly processing: boolean;
  readonly secret: boolean;
  readonly isolated: boolean;
  readonly readOnly?: boolean;
  readonly coverDraft: { draft: string; cursor: number; mark: number | null };
  readonly draft: { draft: string; cursor: number; mark: number | null };
  readonly overlayBody?: string;
  readonly placeholder?: string;
  readonly annotation?: string;
  readonly joinAnnotation?: string;
  readonly hotkeys?: readonly ChromeHotkey[];
  readonly errorAnnotation?: ComposerErrorFace | null;
  readonly statusItems?: readonly ChromeStatusItem[];
  readonly quotaWindows?: readonly ChromeQuotaWindow[];
  readonly contextUsed?: number;
  readonly contextLimit?: number;
  readonly contourRole?: string;
  readonly progress?: number;
  readonly progressColor?: string;
  readonly progressGlowAt?: number;
  readonly progressAnnotation?: string;
  readonly commandChoices?: readonly ComposerCommandChoice[];
  readonly commandAction?: ComposerCommandFallback;
  readonly selectedCommandKey?: string | null;
  readonly scrollOffset?: number;
  readonly stackedBody?: string;
  readonly stackedViewport?: number;
  readonly stackedNumbered?: boolean;
  readonly stackedLang?: string;
};

export type CompletionPaintFields = {
  readonly state: CompletionPaintState;
  readonly workerPresent: boolean;
  readonly model: string;
  readonly startedAt: number | null;
  readonly durationMs: number | null;
  /** Thought still streaming — false once speech has started. */
  readonly thoughtLive: boolean;
  readonly retryUntilMs: number | null;
  readonly text: string;
  readonly thought: string;
  readonly thoughtKind: string;
  readonly endDetail: string;
  readonly failReason: string;
  readonly debugNote: string;
  readonly atMs: number | null;
};

type ChildHost = {
  readonly children: {
    readonly length: number;
    readonly [index: number]: object | undefined;
    indexOf(node: object): number;
  };
  insertChildAt(index: number, node: object): void;
  removeChildAt(index: number): void;
  placeChild(index: number, node: object): void;
};

type TurnHandle = {
  readonly node: TurnPaintInstance;
  prompt: SpeechPaintInstance | null;
  promptWatch: IReactionDisposer | null;
  spineSig: readonly unknown[] | null;
  expectedChildren: readonly object[] | null;
  /** Claimed `TurnSteerChunk` plus sitting `steerQueue` rows, in tape order. */
  readonly steers: DefaultedMap<TurnSteerChunk | SessionAdmission, SpeechPaintInstance>;
  readonly completions: DefaultedMap<CompletionExpectation, CompletionPaintInstance>;
  readonly notifications: DefaultedMap<TurnNotificationChunk, RecallPaintInstance>;
  readonly compact: DefaultedMap<CompactJob, RecallPaintInstance>;
  readonly liveNotifies: DefaultedMap<AgentCallNotification, RecallPaintInstance>;
  readonly tools: DefaultedMap<ToolCallJob, WorkCellPaintInstance>;
  readonly schemes: DefaultedMap<ProgrammaticJob, WorkCellPaintInstance>;
  readonly cellSig: WeakMap<object, readonly unknown[]>;
  readonly watches: Map<unknown, CellWatch>;
};

type CellWatch = {
  dispose: IReactionDisposer;
  cutOff: boolean;
  indent: boolean;
  nested: boolean;
  judge: boolean;
  glance?: (job: CallJob) => CallStatus;
  kernel?: KernelRoot | null;
  blobs?: BlobPeek;
};

export type PaintControllerOpts = {
  readonly agentGlance?: (job: CallJob) => CallStatus;
  readonly kernel?: KernelRoot | null;
  /**
   * Text behind a blob the document names, such as a file mutation's prior. `peek` has to be
   * reactive: a cell reaction that peeked re-runs when the text lands, and the cell repaints.
   */
  readonly blobs?: BlobPeek;
  /** A cancel this client asked for that the daemon has not stamped on the turn yet. Paints as cut off. */
  readonly cancelAsked?: (turn: SessionTurn) => boolean;
};

export function paintComposerFace(input: ComposerFaceInput): ComposerFace {
  const dropPicker = input.isolated;
  const chrome = {
    placeholder: input.placeholder,
    annotation: input.annotation,
    joinAnnotation: input.joinAnnotation,
    hotkeys: input.hotkeys,
    errorAnnotation: input.errorAnnotation ?? null,
    statusItems: input.statusItems,
    quotaWindows: input.quotaWindows,
    contextUsed: input.contextUsed,
    contextLimit: input.contextLimit,
    contourRole: input.contourRole,
    progress: input.progress,
    progressColor: input.progressColor,
    progressGlowAt: input.progressGlowAt,
    progressAnnotation: input.progressAnnotation,
    commandChoices: dropPicker ? undefined : input.commandChoices,
    commandAction: dropPicker ? undefined : input.commandAction,
    selectedCommandKey: dropPicker ? null : (input.selectedCommandKey ?? null),
    scrollOffset: input.scrollOffset ?? 0,
    stackedBody: input.stackedBody,
    stackedViewport: input.stackedViewport,
    stackedNumbered: input.stackedNumbered,
    stackedLang: input.stackedLang,
  };
  if (input.oauthWaiting) {
    return {
      mode: "waiting",
      interactive: false,
      draft: "Waiting for the browser…",
      cursor: 0,
      mark: null,
      ...chrome,
    };
  }
  if (input.readOnly === true) {
    return {
      mode: "normal",
      interactive: false,
      readOnly: true,
      draft: input.overlayBody ?? input.draft.draft,
      cursor: 0,
      mark: null,
      ...chrome,
    };
  }
  if ((input.busy && !input.inputting) || input.processing) {
    return {
      mode: "waiting",
      interactive: false,
      draft: input.overlayBody ?? input.draft.draft,
      cursor: input.draft.cursor,
      mark: input.draft.mark,
      ...chrome,
    };
  }
  if (input.secret) {
    return {
      mode: "secret",
      interactive: true,
      draft: "•".repeat(input.draft.draft.length),
      cursor: input.draft.cursor,
      mark: input.draft.mark,
      ...chrome,
    };
  }
  if (input.isolated) {
    return {
      mode: "isolated",
      interactive: true,
      draft: input.coverDraft.draft,
      cursor: input.coverDraft.cursor,
      mark: input.coverDraft.mark,
      ...chrome,
    };
  }
  return {
    mode: "normal",
    interactive: true,
    draft: input.overlayBody ?? input.draft.draft,
    cursor: input.draft.cursor,
    mark: input.draft.mark,
    ...chrome,
  };
}

/** User cutoff. `terminate` is the cancellation proposal, not a crash to paint. */
export function isCompletionCutoff(chunk: {
  readonly outcome: string | null;
  readonly endCause?: string | null;
  readonly endDetail?: string | null;
}): boolean {
  if (chunk.outcome !== "failed") return false;
  return chunk.endCause === "cancel" || (chunk.endDetail ?? "").trim() === "terminate";
}

export function completionPaintFields(chunk: CompletionExpectation, cutOff = false): CompletionPaintFields {
  const pewCutoff = isCompletionCutoff(chunk);
  const live = chunk.outcome == null && !cutOff;
  const cutoff = pewCutoff || (cutOff && chunk.outcome == null);
  const failed = chunk.outcome === "failed" && !pewCutoff && !cutOff;
  const homed = chunk.plexus != null;
  const report = live && homed ? chunk.report : null;
  const text = live ? (typeof report?.text === "string" ? report.text : "") || chunk.responseText : chunk.responseText;
  const thought = live
    ? (typeof report?.thought === "string" ? report.thought : "") || chunk.responseThought
    : chunk.responseThought;
  const thoughtKind = live
    ? typeof report?.thoughtKind === "string"
      ? report.thoughtKind
      : (chunk.responseThoughtKind ?? "")
    : (chunk.responseThoughtKind ?? "");
  const startedAt =
    chunk.startedAtMs != null && Number.isFinite(chunk.startedAtMs)
      ? chunk.startedAtMs
      : live && typeof report?.startedAt === "number" && Number.isFinite(report.startedAt)
        ? report.startedAt
        : null;
  const thoughtLive = live && chunk.thoughtEndedAtMs == null && text.trim() === "";
  const retryUntilMs =
    live && typeof report?.retryUntilMs === "number" && Number.isFinite(report.retryUntilMs)
      ? report.retryUntilMs
      : null;
  return {
    state: failed ? "failed" : live ? "live" : "successful",
    workerPresent: live ? chunk.workerPresent : false,
    model: chunk.model,
    startedAt,
    durationMs: thoughtLive
      ? null
      : (chunk.thoughtDurationMs() ??
        (startedAt == null ? null : Math.max(0, (chunk.thoughtEndedAtMs ?? startedAt) - startedAt))),
    thoughtLive,
    retryUntilMs,
    text,
    thought,
    thoughtKind,
    endDetail: cutoff ? "" : (chunk.endDetail ?? ""),
    failReason: cutoff ? "" : (chunk.failReason ?? ""),
    debugNote: debugMode() ? cacheStatusNote(chunk) : "",
    atMs: speechAtMs(chunk, startedAt),
  };
}

function speechAtMs(chunk: CompletionExpectation, startedAt: number | null): number | null {
  if (chunk.thoughtEndedAtMs != null && Number.isFinite(chunk.thoughtEndedAtMs)) {
    return chunk.thoughtEndedAtMs;
  }
  if (chunk.endedAtMs != null && Number.isFinite(chunk.endedAtMs)) return chunk.endedAtMs;
  return startedAt;
}

function promptAtMs(turn: SessionTurn): number | null {
  if (turn.startedAtMs != null && Number.isFinite(turn.startedAtMs)) return turn.startedAtMs;
  for (const chunk of reactChunks(turn)) {
    const pew = tapeCompletion(chunk);
    if (pew == null) continue;
    if (pew.startedAtMs != null && Number.isFinite(pew.startedAtMs)) return pew.startedAtMs;
  }
  return null;
}

export type StatuslineFace = {
  readonly cwd: string;
  readonly cwdRoot: string;
  readonly left: string;
  /** Quiet clause: operation, dirt, local and remote commits. */
  readonly note: string;
};

export type WaitPinChrome = {
  readonly occupancy: EmptyWaitChrome | null;
  readonly error: string;
};

export type PaintController = Disposable & {
  readonly root: RootPaintInstance;
  readonly composer: ComposerPaintInstance;
  attach(): void;
  projectComposer(face: ComposerFace): void;
  projectAsk(face: WorkCellFace | null): void;
  projectWait(chrome: WaitPinChrome | null): void;
  projectStatusline(face: StatuslineFace): void;
  projectAgents(face: AgentsReplicaFace | null): void;
  projectRewind(face: {
    readonly atTip: boolean;
    readonly seatRim?: boolean;
    readonly past: readonly { key: string; text: string }[];
    readonly future: readonly { key: string; text: string }[];
    readonly pastTotal?: number;
    readonly futureTotal?: number;
  }): void;
  syncSpine(turns: readonly SessionTurn[], pendingSteers?: readonly SessionAdmission[]): void;
  projectPinRecap(turn: SessionTurn | null, title?: string, hotkeys?: readonly ChromeHotkey[]): void;
  /** Viewer tape for a peeked worker. `null` retracts the stack; `[]` keeps an empty modal. */
  syncPreviewSpine(turns: readonly SessionTurn[] | null, parentModel?: string): void;
  flush(): void;
};

export function createPaintController(
  post: (message: PaintDownMessage) => void,
  epoch = "paint",
  opts: PaintControllerOpts = {},
): PaintController {
  const root = createPaintRoot();
  const tape = createStack();
  const composer = createComposer();
  const statusline: StatuslinePaintInstance = createStatusline();
  root.appendChild(tape);
  root.appendChild(composer);
  root.appendChild(statusline);
  const writer: PaintWriter = createPaintWriter(epoch, post);
  const turns = new DefaultedMap<SessionTurn, TurnHandle>(mintTurnHandle);
  const previewTurns = new DefaultedMap<SessionTurn, TurnHandle>(mintTurnHandle);
  let attached = false;
  let ask: WorkCellPaintInstance | null = null;
  let wait: WorkCellPaintInstance | null = null;
  let agents: AgentsPaintInstance | null = null;
  let preview: PreviewPaintInstance | null = null;
  let rewind: RewindPaintInstance | null = null;
  let recappedSpeech: SpeechPaintInstance | null = null;

  return {
    root,
    composer,
    attach() {
      if (attached) return;
      attached = true;
      writer.attach(root);
    },
    projectAsk(face) {
      if (face === null) {
        if (ask === null) return;
        const at = root.children.indexOf(ask);
        if (at !== -1) root.removeChildAt(at);
        ask = null;
        return;
      }
      if (ask === null) {
        ask = createWorkCell("ask");
        const composerAt = root.children.indexOf(composer);
        root.insertChildAt(composerAt === -1 ? root.children.length : composerAt, ask);
      }
      applyWorkCell(ask, face, face.key.startsWith("ask:") ? face.key.slice(4) : face.key);
    },
    projectWait(chrome) {
      trace(
        "harness:paint",
        chrome === null
          ? "projectWait clear"
          : `projectWait ${chrome.occupancy == null ? "error" : chrome.occupancy.kind}`,
      );
      if (chrome === null) {
        if (wait === null) return;
        const at = root.children.indexOf(wait);
        if (at !== -1) root.removeChildAt(at);
        wait = null;
        return;
      }
      if (wait === null) {
        wait = createWorkCell("wait");
        const composerAt = root.children.indexOf(composer);
        root.insertChildAt(composerAt === -1 ? root.children.length : composerAt, wait);
      }
      const occupancy = chrome.occupancy;
      wait.setFace({
        name: occupancy == null ? "error" : occupancy.kind,
        object: chrome.error,
        status: occupancy?.label ?? "",
        state: occupancy == null ? "fail" : "live",
        indent: false,
        receiptKind: "none",
        receiptText: "",
        diffOld: "",
        diffNew: "",
        diffPath: "",
        startedAt: occupancy == null || occupancy.elapsed !== true ? null : (occupancy.startedAt ?? Date.now()),
        retryUntilMs: occupancy?.retryUntilMs,
      });
    },
    projectStatusline(face) {
      statusline.setCwd(face.cwd);
      statusline.setCwdRoot(face.cwdRoot);
      statusline.setLeft(face.left);
      statusline.setNote(face.note);
    },
    projectAgents(face: AgentsReplicaFace | null): void {
      if (face == null) {
        if (agents === null) return;
        const at = root.children.indexOf(agents);
        if (at !== -1) root.removeChildAt(at);
        agents = null;
        return;
      }
      if (agents === null) {
        agents = createAgents();
        root.appendChild(agents);
      }
      agents.setFace(face);
    },
    projectRewind(face) {
      if (rewind === null) {
        rewind = createRewind();
        root.appendChild(rewind);
      }
      rewind.setFace(face.atTip, face.past, face.future, face.pastTotal, face.futureTotal, face.seatRim);
    },
    projectComposer(face) {
      composer.setDraft(face.draft);
      composer.setCursor(face.cursor);
      composer.setMark(face.mark);
      composer.setInteractive(face.interactive);
      composer.setReadOnly(face.readOnly === true);
      composer.setMode(face.mode);
      composer.setPlaceholder(face.placeholder ?? "");
      composer.setAnnotation(face.annotation ?? "");
      composer.setJoinAnnotation(face.joinAnnotation ?? "");
      composer.setHotkeys(face.hotkeys ?? []);
      composer.setError(face.errorAnnotation?.level ?? null, face.errorAnnotation?.message ?? "");
      composer.setStatusItems(face.statusItems ?? []);
      composer.setQuotaWindows(face.quotaWindows ?? []);
      composer.setContextUsed(face.contextUsed ?? 0);
      composer.setContextLimit(face.contextLimit ?? 0);
      composer.setContourRole(face.contourRole ?? "");
      composer.setProgress(face.progress ?? null);
      composer.setProgressColor(face.progressColor ?? "");
      composer.setProgressGlowAt(face.progressGlowAt ?? null);
      composer.setProgressAnnotation(face.progressAnnotation ?? "");
      composer.setCommandChoices(face.commandChoices === undefined ? null : face.commandChoices);
      composer.setCommandAction(face.commandAction === undefined ? null : face.commandAction);
      composer.setSelectedCommandKey(face.selectedCommandKey);
      composer.setScrollOffset(face.scrollOffset);
      composer.setStackedBody(face.stackedBody ?? "");
      composer.setStackedViewport(face.stackedViewport ?? 0);
      composer.setStackedNumbered(face.stackedNumbered === true);
      composer.setStackedLang(face.stackedLang ?? "");
    },
    flush() {
      writer.flush();
    },
    syncSpine(nextTurns, pendingSteers = []) {
      syncSpineInto(
        tape as ChildHost,
        turns,
        nextTurns,
        opts.agentGlance,
        opts.kernel,
        pendingSteers,
        opts.cancelAsked,
        opts.blobs,
      );
    },
    projectPinRecap(turn, title = "", hotkeys = []) {
      const nextSpeech = turn !== null && turns.has(turn) ? turns.get(turn).prompt : null;
      if (
        recappedSpeech !== null &&
        recappedSpeech !== nextSpeech &&
        (!isStateTreeNode(recappedSpeech) || isAlive(recappedSpeech))
      ) {
        recappedSpeech.setRecap(false, "", []);
      }
      if (nextSpeech !== null && (!isStateTreeNode(nextSpeech) || isAlive(nextSpeech))) {
        nextSpeech.setRecap(true, title, hotkeys);
      }
      recappedSpeech = nextSpeech;
    },
    syncPreviewSpine(nextTurns, parentModel) {
      if (nextTurns === null) {
        if (preview === null) return;
        const at = root.children.indexOf(preview);
        if (at !== -1) root.removeChildAt(at);
        preview = null;
        for (const handle of previewTurns.values()) disposeHandle(handle);
        previewTurns.clear();
        return;
      }
      if (preview === null) {
        preview = createPreview();
        root.appendChild(preview);
      }
      const glance =
        parentModel === undefined
          ? opts.agentGlance
          : (job: CallJob) => {
              const base = opts.agentGlance?.(job);
              if (base == null) return { status: "", model: parentModel };
              return { status: base.status, model: (base.model ?? "").trim() || parentModel };
            };
      syncSpineInto(preview as ChildHost, previewTurns, nextTurns, glance, opts.kernel, [], undefined, opts.blobs);
    },
    [Symbol.dispose]() {
      writer.dispose();
      for (const handle of turns.values()) disposeHandle(handle);
      for (const handle of previewTurns.values()) disposeHandle(handle);
      turns.clear();
      previewTurns.clear();
      destroy(root);
    },
  };
}

function pushLeftoverJudgeCompletions(
  handle: TurnHandle,
  work: ToolCallJob,
  livingCompletions: Set<CompletionExpectation>,
  wanted: object[],
  cutOff: boolean,
): void {
  for (const child of work.children) {
    const pew = tapeCompletion(child);
    if (pew == null || livingCompletions.has(pew)) continue;
    livingCompletions.add(pew);
    const node = handle.completions.get(pew);
    watchCompletion(handle, pew, node, cutOff, true);
    wanted.push(node);
  }
}

function compactFocus(turn: SessionTurn, job: CompactJob): string {
  if (job.reason === "user") {
    const prompt = turn.prompt.trim();
    if (prompt !== "") return prompt;
  }
  const chunks = reactChunks(turn);
  const index = chunks.indexOf(job);
  const before = index === -1 ? chunks : chunks.slice(0, index);
  const tail = turn.turnTail instanceof SessionTurn ? turn.turnTail.contextNeed : null;
  return contextNeedFromChunks(before, tail)?.focus ?? "";
}

function childrenIntact(node: ChildHost, expected: readonly object[] | null): boolean {
  if (expected === null || node.children.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    const child = expected[i]!;
    if (node.children[i] !== child) return false;
    if (isStateTreeNode(child) && !isAlive(child)) return false;
  }
  return true;
}

function syncTurn(
  handle: TurnHandle,
  turn: SessionTurn,
  pendingSteers: readonly SessionAdmission[],
  agentGlance?: (job: CallJob) => CallStatus,
  kernel?: KernelRoot | null,
  cancelAsked = false,
  blobs?: BlobPeek,
): void {
  const sig = [
    trackTurn(turn),
    cancelAsked,
    pendingSteers.map((row) => [row, row.text.trim() === ""]),
    agentGlance,
    kernel?.hideFloorTools,
  ];
  if (
    handle.spineSig !== null &&
    trackEqual(handle.spineSig, sig) &&
    (!isStateTreeNode(handle.node) || isAlive(handle.node)) &&
    (handle.prompt === null || !isStateTreeNode(handle.prompt) || isAlive(handle.prompt)) &&
    childrenIntact(handle.node as ChildHost, handle.expectedChildren)
  ) {
    return;
  }
  const wanted: object[] = [];
  watchPrompt(handle, turn);
  if (handle.prompt != null) wanted.push(handle.prompt);
  const livingSteers = new Set<TurnSteerChunk | SessionAdmission>();
  const livingCompletions = new Set<CompletionExpectation>();
  const livingNotifications = new Set<TurnNotificationChunk>();
  const livingCompact = new Set<CompactJob>();
  const livingTools = new Set<ToolCallJob>();
  const livingSchemes = new Set<ProgrammaticJob>();
  const askCut = createAskTapeCut(turn);
  const cutOff = turn.cutOff || cancelAsked;
  for (const chunk of reactChunks(turn)) {
    if (chunk instanceof TurnSteerChunk) {
      livingSteers.add(chunk);
      const node = handle.steers.get(chunk);
      watchSteer(handle, chunk, node, () => [chunk.steerText(), chunk.composedAtMs] as const);
      wanted.push(node);
      continue;
    }
    const pew = tapeCompletion(chunk);
    if (pew != null) {
      livingCompletions.add(pew);
      const node = handle.completions.get(pew);
      watchCompletion(handle, pew, node, cutOff, false);
      wanted.push(node);
    } else if (chunk instanceof TurnNotificationChunk) {
      livingNotifications.add(chunk);
      const node = handle.notifications.get(chunk);
      watchRecall(handle, chunk, node, () => notificationPaintText(chunk));
      wanted.push(node);
    } else if (chunk instanceof CompactJob) {
      if (!chunk.cutoff && !chunk.failed) continue;
      livingCompact.add(chunk);
      const node = handle.compact.get(chunk);
      watchRecall(handle, chunk, node, () =>
        compactJobPaintText(chunk.notice, compactFocus(turn, chunk), chunk.failed),
      );
      wanted.push(node);
    } else if (chunk instanceof ToolCallJob) {
      if (chunk.tapeHidden) continue;
      if (askCut.skipTool(chunk)) continue;
      livingTools.add(chunk);
      wanted.push(retainWorkCell(handle, handle.tools, chunk, false, agentGlance, cutOff, kernel, false, blobs));
      pushLeftoverJudgeCompletions(handle, chunk, livingCompletions, wanted, cutOff);
    } else if (chunk instanceof ProgrammaticJob) {
      if (askCut.skipScheme()) continue;
      livingSchemes.add(chunk);
      wanted.push(retainWorkCell(handle, handle.schemes, chunk, false, agentGlance, cutOff, kernel, false, blobs));
      for (const inner of chunk.toolCalls) {
        if (inner.tapeHidden) continue;
        if (askCut.skipTool(inner)) continue;
        livingTools.add(inner);
        wanted.push(retainWorkCell(handle, handle.tools, inner, true, agentGlance, cutOff, kernel, true, blobs));
        pushLeftoverJudgeCompletions(handle, inner, livingCompletions, wanted, cutOff);
      }
    }
  }
  // Sitting steers are the next user prompt, not queue rows. Claim removes
  // the admission and the chunk above takes the same seat.
  for (const row of pendingSteers) {
    const text = row.text.trim();
    if (text === "") continue;
    livingSteers.add(row);
    const node = handle.steers.get(row);
    watchSteer(handle, row, node, () => [row.text, row.composedAtMs] as const);
    wanted.push(node);
  }
  for (const key of handle.steers.keys()) {
    if (livingSteers.has(key)) continue;
    forgetWatch(handle, key);
    handle.steers.delete(key);
  }
  const livingNotifyKeys = new Set<AgentCallNotification>();
  for (const work of livingTools) {
    if (!(work instanceof CallJob)) continue;
    for (const note of work.notifications) {
      if (isNoteClaimed(note) || note.message.trim() === "") continue;
      livingNotifyKeys.add(note);
      const node = handle.liveNotifies.get(note);
      watchText(handle, note, node, () => `from ${agentCallName(work)}: ${note.message}`);
      wanted.push(node);
    }
  }
  for (const note of handle.liveNotifies.keys()) {
    if (livingNotifyKeys.has(note)) continue;
    forgetWatch(handle, note);
    handle.liveNotifies.delete(note);
  }
  for (const chunk of handle.completions.keys()) {
    if (!livingCompletions.has(chunk)) {
      forgetWatch(handle, chunk);
      handle.completions.delete(chunk);
    }
  }
  for (const chunk of handle.notifications.keys()) {
    if (!livingNotifications.has(chunk)) {
      forgetWatch(handle, chunk);
      handle.notifications.delete(chunk);
    }
  }
  for (const chunk of handle.compact.keys()) {
    if (!livingCompact.has(chunk)) {
      forgetWatch(handle, chunk);
      handle.compact.delete(chunk);
    }
  }
  for (const chunk of handle.tools.keys()) {
    if (!livingTools.has(chunk)) {
      forgetWatch(handle, chunk);
      handle.cellSig.delete(chunk);
      handle.tools.delete(chunk);
    }
  }
  for (const chunk of handle.schemes.keys()) {
    if (!livingSchemes.has(chunk)) {
      forgetWatch(handle, chunk);
      handle.cellSig.delete(chunk);
      handle.schemes.delete(chunk);
    }
  }
  syncChildren(handle.node as ChildHost, wanted);
  handle.spineSig = sig;
  handle.expectedChildren = wanted;
}

function sameSig(a: readonly unknown[] | undefined, b: readonly unknown[]): boolean {
  if (a?.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (Array.isArray(x) && Array.isArray(y) && sameSig(x, y)) continue;
    return false;
  }
  return true;
}

function liveShellTail(work: ToolCallJob): string {
  if (work.name !== "shell" || work.completed) return "";
  return shellTailOf(work)?.text ?? "";
}

/** The face differs before and after the text behind a blob prior is in hand. */
function priorBlobResolved(work: FileMutateToolJob, blobs: BlobPeek | undefined): boolean {
  const prior = work.prior;
  return blobs !== undefined && prior?.kind === "blob" && blobs.peek(prior.blob.sha256) !== null;
}

function workCellSig(
  work: ToolCallJob | ProgrammaticJob,
  indent: boolean,
  nested: boolean,
  kernel: KernelRoot | null | undefined,
  glance: CallStatus,
  cutOff: boolean,
  blobs?: BlobPeek,
): unknown[] {
  const fuse = workCellFuse(work, nested, kernel?.hideFloorTools === true);
  const agent = work instanceof CallJob ? [glance.status ?? "", glance.model ?? ""] : [];
  if (work instanceof ProgrammaticJob) {
    return [
      "scheme",
      work.toolCallId,
      work.args,
      work.receiptJson,
      work.completed,
      work.cancelled,
      indent,
      fuse,
      cutOff,
      work.toolCalls.map((inner) => [
        inner.toolCallId,
        inner.args,
        inner.receiptJson,
        inner.completed,
        inner.cancelled,
        inner.policyResult,
        inner.humanApprove,
        inner.classifierResult,
      ]),
    ];
  }
  const mutate =
    work instanceof FileMutateToolJob
      ? [
          work.priorContent ?? "",
          work.priorBlobJson ?? "",
          priorBlobResolved(work, blobs),
          work.existed,
          work.priorLineStart,
        ]
      : [];
  return [
    work.toolCallId,
    work.name,
    work.args,
    work.receiptJson,
    work.completed,
    work.cancelled,
    work.policyResult,
    work.policyMessage,
    work.classifierResult,
    work.classifierAbstain,
    work.humanApprove,
    work.approvalComment,
    indent,
    nested,
    fuse,
    cutOff,
    work.name === "shell" ? shellFormatGeneration() : 0,
    work.name === "shell" ? liveShellTail(work) : "",
    mutate,
    agent,
  ];
}

function retainWorkCell<T extends ToolCallJob | ProgrammaticJob>(
  handle: TurnHandle,
  map: DefaultedMap<T, WorkCellPaintInstance>,
  work: T,
  indent: boolean,
  agentGlance?: (job: CallJob) => CallStatus,
  cutOff = false,
  kernel?: KernelRoot | null,
  nested = false,
  blobs?: BlobPeek,
): WorkCellPaintInstance {
  let node = map.get(work);
  if (isStateTreeNode(node) && !isAlive(node)) {
    map.delete(work);
    handle.cellSig.delete(work);
    forgetWatch(handle, work);
    node = map.get(work);
  }
  const glance = work instanceof CallJob ? (agentGlance?.(work) ?? {}) : {};
  const existing = handle.watches.get(work);
  if (existing == null) {
    const created: CellWatch = {
      dispose: (() => undefined) as IReactionDisposer,
      cutOff,
      indent,
      nested,
      judge: false,
      glance: agentGlance,
      kernel,
      blobs,
    };
    const apply = (): void => {
      const nextGlance = work instanceof CallJob ? (created.glance?.(work) ?? {}) : {};
      applyWorkCellFromSig(
        handle,
        node,
        work,
        created.indent,
        created.nested,
        created.kernel,
        nextGlance,
        created.cutOff,
        created.blobs,
      );
    };
    created.dispose = reaction(
      () => {
        const nextGlance = work instanceof CallJob ? (created.glance?.(work) ?? {}) : {};
        return workCellSig(
          work,
          created.indent,
          created.nested,
          created.kernel,
          nextGlance,
          created.cutOff,
          created.blobs,
        );
      },
      () => apply(),
      {
        equals: (a, b) => sameSig(a as readonly unknown[], b as readonly unknown[]),
      },
    );
    apply();
    handle.watches.set(work, created);
    return node;
  }
  existing.indent = indent;
  existing.nested = nested;
  existing.cutOff = cutOff;
  existing.glance = agentGlance;
  existing.kernel = kernel;
  existing.blobs = blobs;
  applyWorkCellFromSig(handle, node, work, indent, nested, kernel, glance, cutOff, blobs);
  return node;
}

function applyWorkCellFromSig(
  handle: TurnHandle,
  node: WorkCellPaintInstance,
  work: ToolCallJob | ProgrammaticJob,
  indent: boolean,
  nested: boolean,
  kernel: KernelRoot | null | undefined,
  glance: CallStatus,
  cutOff: boolean,
  blobs?: BlobPeek,
): void {
  const sig = workCellSig(work, indent, nested, kernel, glance, cutOff, blobs);
  if (node.name !== "" && sameSig(handle.cellSig.get(work), sig)) return;
  handle.cellSig.set(work, sig);
  const face = workCellFace(work, work.toolCallId, indent, true, glance, kernel, blobs);
  applyWorkCell(
    node,
    cutOff && face.state === "live" ? { ...face, state: "fail" } : face,
    work.toolCallId,
    workCellFuse(work, nested, kernel?.hideFloorTools === true),
  );
}

function receiptTextForReplica(receipt: ReceiptFace): string {
  if (receipt.kind === "none" || receipt.kind === "diff") return "";
  if (receipt.kind === "parts") return JSON.stringify(receipt.parts);
  return receipt.text;
}

function applyWorkCell(node: WorkCellPaintInstance, face: WorkCellFace, toolCallId: string, fuse = false): void {
  const receipt = face.receipt;
  node.setFace({
    toolCallId,
    name: face.name,
    object: face.object,
    status: face.status,
    caption: face.caption,
    state: face.state,
    indent: face.indent,
    split: face.split,
    agent: face.agent,
    pretty: face.pretty,
    prettyBlock: face.prettyBlock,
    response: face.response,
    receiptKind: receipt.kind,
    receiptText: receiptTextForReplica(receipt),
    diffOld: receipt.kind === "diff" ? receipt.old : "",
    diffNew: receipt.kind === "diff" ? receipt.new : "",
    diffPath: receipt.kind === "diff" ? receipt.path : "",
    diffLineStart: receipt.kind === "diff" ? (receipt.lineStart ?? 0) : 0,
    fuse,
  });
}

/**
 * Remainder-classifier PEWs hang on the leaf tool. Their sealed `responseText`
 * is the vote JSON (`{decision, uncertainty, severity, retrieve}`) — machine
 * output, not a message, so it never paints as speech. Liveness, thought, and
 * failure still paint; the leaf tool already holds the judging spinner.
 */
function judgeCompletionPaintFields(pew: CompletionExpectation, cutOff: boolean): CompletionPaintFields {
  const fields = completionPaintFields(pew, cutOff);
  return fields.text === "" ? fields : { ...fields, text: "" };
}

function applyCompletion(node: CompletionPaintInstance, fields: CompletionPaintFields): void {
  node.setState(fields.state);
  node.setWorkerPresent(fields.workerPresent);
  node.setModel(fields.model);
  node.setStartedAt(fields.startedAt);
  node.setDurationMs(fields.durationMs);
  node.setThoughtLive(fields.thoughtLive);
  node.setRetryUntilMs(fields.retryUntilMs);
  node.setThoughtKind(fields.thoughtKind);
  speechOf(node).updateText(fields.text);
  speechOf(node).setAtMs(fields.atMs);
  thinkingOf(node).updateText(fields.thought);
  failureOf(node).updateEndDetail(fields.endDetail);
  failureOf(node).updateFailReason(fields.failReason);
  node.setDebugNote(fields.debugNote);
}

function mintTurnHandle(): TurnHandle {
  return {
    node: createTurn(),
    prompt: null,
    promptWatch: null,
    spineSig: null,
    expectedChildren: null,
    steers: new DefaultedMap(() => createSpeech("", "user")),
    completions: new DefaultedMap(() => createCompletion()),
    notifications: new DefaultedMap(() => createRecall()),
    compact: new DefaultedMap(() => createCompact()),
    liveNotifies: new DefaultedMap(() => createRecall()),
    tools: new DefaultedMap(() => createWorkCell("tool")),
    schemes: new DefaultedMap(() => createWorkCell("scheme")),
    cellSig: new WeakMap(),
    watches: new Map(),
  };
}

function forgetWatch(handle: TurnHandle, key: unknown): void {
  const watch = handle.watches.get(key);
  if (watch == null) return;
  watch.dispose();
  handle.watches.delete(key);
}

function disposeHandle(handle: TurnHandle): void {
  handle.promptWatch?.();
  handle.promptWatch = null;
  for (const watch of handle.watches.values()) watch.dispose();
  handle.watches.clear();
}

function watchPrompt(handle: TurnHandle, turn: SessionTurn): void {
  if (turn.prompt === "") {
    handle.promptWatch?.();
    handle.promptWatch = null;
    handle.prompt = null;
    return;
  }
  const apply = (text: string, atMs: number | null): void => {
    if (handle.prompt === null || (isStateTreeNode(handle.prompt) && !isAlive(handle.prompt))) {
      handle.prompt = createSpeech(text, "user", atMs);
    } else {
      handle.prompt.updateText(text);
      handle.prompt.setAtMs(atMs);
    }
  };
  if (handle.promptWatch != null) {
    if (handle.prompt === null || (isStateTreeNode(handle.prompt) && !isAlive(handle.prompt))) {
      apply(turn.prompt, promptAtMs(turn));
    }
    return;
  }
  // Apply before returning so syncTurn can place the node. Nested
  // `fireImmediately` reactions stay queued until the outer spine
  // reaction finishes, which left the tape with no user speech.
  handle.promptWatch = reaction(
    () => [turn.prompt, promptAtMs(turn)] as const,
    ([text, atMs]) => apply(text, atMs),
    { equals: comparer.shallow },
  );
  apply(turn.prompt, promptAtMs(turn));
}

/** Upcoming or claimed steer. Same user floor as the turn prompt. */
function watchSteer(
  handle: TurnHandle,
  key: TurnSteerChunk | SessionAdmission,
  node: SpeechPaintInstance,
  read: () => readonly [string, number],
): void {
  const apply = (text: string, atMs: number): void => {
    node.updateText(text);
    node.setAtMs(Number.isFinite(atMs) && atMs > 0 ? atMs : null);
  };
  if (handle.watches.has(key)) {
    const [text, atMs] = read();
    apply(text, atMs);
    return;
  }
  const dispose = reaction(read, ([text, atMs]) => apply(text, atMs), { equals: comparer.shallow });
  const [text, atMs] = read();
  apply(text, atMs);
  handle.watches.set(key, {
    dispose,
    cutOff: false,
    indent: false,
    nested: false,
    judge: false,
  });
}

function watchCompletion(
  handle: TurnHandle,
  pew: CompletionExpectation,
  node: CompletionPaintInstance,
  cutOff: boolean,
  judge: boolean,
): void {
  const existing = handle.watches.get(pew);
  if (existing == null) {
    const created: CellWatch = {
      dispose: (() => undefined) as IReactionDisposer,
      cutOff,
      indent: false,
      nested: false,
      judge,
    };
    created.dispose = reaction(
      () =>
        created.judge ? judgeCompletionPaintFields(pew, created.cutOff) : completionPaintFields(pew, created.cutOff),
      (fields) => applyCompletion(node, fields),
      { equals: comparer.shallow },
    );
    applyCompletion(
      node,
      created.judge ? judgeCompletionPaintFields(pew, created.cutOff) : completionPaintFields(pew, created.cutOff),
    );
    handle.watches.set(pew, created);
    return;
  }
  if (existing.cutOff === cutOff && existing.judge === judge) return;
  existing.cutOff = cutOff;
  existing.judge = judge;
  applyCompletion(node, judge ? judgeCompletionPaintFields(pew, cutOff) : completionPaintFields(pew, cutOff));
}

function watchRecall(handle: TurnHandle, key: object, node: RecallPaintInstance, text: () => string): void {
  watchText(handle, key, node, text);
}

function watchText(handle: TurnHandle, key: unknown, node: RecallPaintInstance, text: () => string): void {
  if (handle.watches.has(key)) return;
  const apply = (next: string): void => {
    node.updateText(next);
  };
  const dispose = reaction(text, apply);
  apply(text());
  handle.watches.set(key, {
    dispose,
    cutOff: false,
    indent: false,
    nested: false,
    judge: false,
  });
}

function syncSpineInto(
  host: ChildHost,
  handles: DefaultedMap<SessionTurn, TurnHandle>,
  nextTurns: readonly SessionTurn[],
  agentGlance?: (job: CallJob) => CallStatus,
  kernel?: KernelRoot | null,
  pendingSteers: readonly SessionAdmission[] = [],
  cancelAsked?: (turn: SessionTurn) => boolean,
  blobs?: BlobPeek,
): void {
  const wanted: TurnPaintInstance[] = [];
  const living = new Set<SessionTurn>();
  const head = nextTurns.at(-1);
  for (const turn of nextTurns) {
    living.add(turn);
    const handle = handles.get(turn);
    syncTurn(
      handle,
      turn,
      turn === head ? pendingSteers : [],
      agentGlance,
      kernel,
      cancelAsked?.(turn) === true,
      blobs,
    );
    wanted.push(handle.node);
  }
  for (const [turn, handle] of handles.entries()) {
    if (living.has(turn)) continue;
    disposeHandle(handle);
    handles.delete(turn);
  }
  syncChildren(host, wanted);
}

function syncChildren(parent: ChildHost, wanted: object[]): void {
  for (const [i, element] of wanted.entries()) {
    const node = element!;
    if (isStateTreeNode(node) && !isAlive(node)) continue;
    parent.placeChild(i, node);
  }
  while (parent.children.length > wanted.length) {
    parent.removeChildAt(parent.children.length - 1);
  }
}

const turnTrackCache = new WeakMap<SessionTurn, IComputedValue<readonly unknown[]>>();

/**
 * Structure only — turn/chunk identity, cutoff, ask pin, hidden tools.
 * PEW field values belong to per-cell reactions in PaintController.
 */
export function trackTurn(turn: SessionTurn): readonly unknown[] {
  let box = turnTrackCache.get(turn);
  if (box === undefined) {
    box = computed(
      () => [
        turn,
        turn.reducerExited,
        turn.cancelled,
        turn.cancelRequested,
        turn.prompt === "",
        askPaintHead(turn),
        reactChunks(turn).map((chunk) => trackChunk(chunk)),
      ],
      { equals: trackEqual },
    );
    turnTrackCache.set(turn, box);
  }
  return box.get();
}

function leftoverIdentities(chunk: ToolCallJob): unknown {
  return chunk.children.map((child) => tapeCompletion(child) ?? child);
}

function trackTool(chunk: ToolCallJob): unknown {
  return [
    chunk,
    leftoverIdentities(chunk),
    chunk instanceof CallJob
      ? chunk.notifications.map((note) => [note, isNoteClaimed(note), note.message.trim() === ""])
      : null,
  ];
}

function trackChunk(chunk: object): unknown {
  const pew = tapeCompletion(chunk);
  if (pew != null) return pew;
  if (chunk instanceof TurnNotificationChunk) return chunk;
  if (chunk instanceof TurnSteerChunk) return [chunk, chunk.text];
  if (chunk instanceof TurnApprovalNoteChunk) return null;
  if (chunk instanceof CompactJob) return [chunk, chunk.cutoff, chunk.failed];
  if (chunk instanceof ToolCallJob) {
    if (chunk.tapeHidden) return null;
    return trackTool(chunk);
  }
  if (chunk instanceof ProgrammaticJob) {
    return [chunk, chunk.toolCalls.map((inner) => (inner.tapeHidden ? null : trackTool(inner)))];
  }
  return chunk;
}

/** Identity-deep for arrays; `===` for turns, chunks, and primitives. */
export function trackEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!trackEqual(a[i], b[i])) return false;
    }
    return true;
  }
  return false;
}
