/**
 * Completion input projection: history, compact lead, notifications, tool results.
 * Vendor Chat Completions / Responses encoding stays in the protocol actor.
 *
 * Model input is a pure projection of the graph; nothing is deleted. What an
 * earlier item leaves behind is decided by the recorded retention facts
 * (R1 turn policy, R2 job rule, R3 clock) — see `./retention`.
 */
import {
  CallJob,
  CompactJob,
  CompletionExpectation,
  type CompletionMessage,
  ContextNeedToolJob,
  latestCompactCutoff,
  owningTurn,
  ProgrammaticJob,
  PromptMessage,
  ReACTChunk,
  SessionRoot,
  type StoredText,
  systemPartsOf,
  tapeCompletion,
  ToolCallJob,
  type ToolTextPart,
  TurnApprovalNoteChunk,
  TurnNotificationChunk,
  TurnPromptChunk,
  TurnSteerChunk,
  type UserVisualIdentity,
} from "@inhuman.tools/harness-model";
import invariant from "tiny-invariant";

import { usesGenericSilentProjection } from "./delivery.js";
import { BACKGROUND_TOOL, IN_FLIGHT_TOOL, NO_TOOLS_SYSTEM } from "./observations.js";
import { elideArgs, refOfNode, textRemainder, toolRemainder, visualRef, type StubFacts } from "./retention/render.js";
import { effectiveRule, kindRule } from "./retention/resolve.js";
import { parseJobStamp } from "./retention/stamp.js";
import { buildView, horizonExpired, newestOf, type RetentionView, type ViewOptions } from "./retention/view.js";
import {
  liftToolImages,
  paintObservation,
  squeezeProgrammaticText,
  squeezeToolCall,
  toolImageLine,
  type ToolImage,
} from "./squeeze.js";
import { liveCatalogOf, selectCompletionTools, type ContextTool } from "./tools.js";
import { compactLeadRows } from "./transcript.js";
import type { KernelToolCatalog } from "../tool-catalog/index.js";

export type HistoryToolCall = {
  readonly id: string;
  readonly name: string;
  readonly argsJson: string;
};

export type HistoryUserPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly id: string;
      readonly mime: string;
      readonly width: number;
      readonly height: number;
      readonly resizedFrom: { readonly width: number; readonly height: number } | null;
      readonly sourcePath: string | null;
      readonly bytes: Uint8Array | null;
    };

export type HistoryMessage = {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null | readonly ToolTextPart[] | readonly HistoryUserPart[];
  readonly toolCallId?: string;
  readonly toolCalls?: readonly HistoryToolCall[];
  readonly thought?: string;
  readonly thoughtEncrypted?: string;
};

export type ProjectHistoryOptions = {
  readonly catalog?: KernelToolCatalog;
  /** Emit an empty assistant shell when the dialect echoes empty thought. */
  readonly echoEmptyThought?: boolean;
  /** Bytes for a seated picture. Missing reader or missing blob omits that picture by name. */
  readonly readVisual?: (id: string) => Uint8Array | null;
  /**
   * Bytes of a body stored beside the document, by content hash (an isolated completion's prompt message, a
   * session round's stored line). A missing reader or a missing blob falls back to the head the document kept.
   */
  readonly readBlob?: (sha256: string) => Uint8Array | null;
  /** Key into `contextRetention.dialects` (e.g. `anthropic`). Defaults from the tip's model id. */
  readonly dialect?: string;
} & Pick<ViewOptions, "clockAt">;

/** Context shared by every completion emitted in one projection. */
type Projection = {
  readonly catalog: KernelToolCatalog | undefined;
  readonly echoEmptyThought: boolean;
  readonly readVisual: ProjectHistoryOptions["readVisual"];
  readonly readBlob: ProjectHistoryOptions["readBlob"];
  readonly view: RetentionView;
  readonly images: ImagePlan;
};

// --- stored bodies --------------------------------------------------------------------------

/** Keeps a leading byte-order mark: the text is what was stored, character for character. */
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * The text a stored body stands for: the inline text, the blob's bytes read as UTF-8, or the head the document
 * kept when the blob cannot be read. The model sees a truncated prompt rather than a failed round; the daemon
 * that binds the reader is the one that can say a blob is missing.
 */
function bodyText(body: StoredText, readBlob: ProjectHistoryOptions["readBlob"]): string {
  if (body.kind === "inline") return body.text;
  const bytes = readBlob?.(body.blob.sha256) ?? null;
  return bytes === null ? body.blob.head : UTF8.decode(bytes);
}

/**
 * {@link CompletionExpectation.userPrompt} with every body read in full: the same rule (authored user messages
 * win; with none, the stored line), but a body stored beside the document comes back through `readBlob`
 * instead of as its head.
 */
function userPromptOf(expectation: CompletionExpectation, readBlob: ProjectHistoryOptions["readBlob"]): string {
  const users = expectation.promptMessages.filter((row) => row.role === "user");
  if (users.length === 0) return bodyText(expectation.promptTextBody, readBlob);
  return users.map((row) => bodyText(row.body, readBlob)).join("\n\n");
}

// --- prelude --------------------------------------------------------------------------------

function completionOfCell(cell: unknown): CompletionExpectation | null {
  return tapeCompletion(cell) ?? (cell instanceof CompletionExpectation ? cell : null);
}

/**
 * A round's prelude: the cells in its `messages` after the last completion
 * ref. `messages` is cumulative (every earlier round's cells ride in it), so
 * anything before that ref belongs to an earlier round and was emitted there.
 */
export function preludeCells(expectation: CompletionExpectation): CompletionMessage[] {
  const messages = expectation.messages;
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (completionOfCell(messages[index]) != null) {
      start = index + 1;
      break;
    }
  }
  return messages.slice(start);
}

export function notificationMessagesOf(expectation: CompletionExpectation): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const cell of preludeCells(expectation)) {
    if (!(cell instanceof TurnNotificationChunk)) continue;
    const content = cell.notificationText();
    if (content !== "") out.push({ role: "system", content });
  }
  return out;
}

export function approvalNoteMessagesOf(expectation: CompletionExpectation): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const cell of preludeCells(expectation)) {
    if (!(cell instanceof TurnApprovalNoteChunk)) continue;
    const content = cell.approvalNoteText();
    if (content !== "") out.push({ role: "user", content });
  }
  return out;
}

export function steerMessagesOf(expectation: CompletionExpectation): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const cell of preludeCells(expectation)) {
    if (!(cell instanceof TurnSteerChunk)) continue;
    const content = cell.completionMessage;
    if (content !== "") out.push({ role: "user", content });
  }
  return out;
}

/** A prelude cell's text, or what it leaves once its horizon has passed. `null` leaves nothing. */
function retainedText(kind: string, text: string, completion: CompletionExpectation, ctx: Projection): string | null {
  const rule = kindRule(ctx.view.policyOf(completion), kind);
  if (text.length < rule.minChars) return text;
  if (!horizonExpired(rule.keep, ctx.view, { consumer: completion, owner: completion })) return text;
  return textRemainder(rule.leave, kind, text);
}

// --- tool results ---------------------------------------------------------------------------

type Round = {
  readonly tools: Array<ToolCallJob | ProgrammaticJob>;
  readonly suppressed: Set<string>;
  readonly silent: Set<string>;
};

/** The tool jobs on the tape between `completion` and the next completion or cutoff. */
function roundOf(completion: CompletionExpectation, catalog: KernelToolCatalog | undefined): Round {
  const turn = owningTurn(completion);
  const tape = turn == null ? [] : [...turn.doneWork, ...turn.queue];
  const start = tapeIndexOf(tape, completion);
  const round: Round = { tools: [], suppressed: new Set(), silent: new Set() };
  if (start === -1) return round;
  for (let index = start + 1; index < tape.length; index += 1) {
    const cell = tape[index];
    if (tapeCompletion(cell) != null || cell instanceof CompactJob) break;
    if (!(cell instanceof ToolCallJob || cell instanceof ProgrammaticJob)) continue;
    if (cell instanceof ContextNeedToolJob) {
      round.suppressed.add(cell.toolCallId);
      continue;
    }
    if (cell instanceof CallJob && catalog != null && usesGenericSilentProjection(cell, catalog)) {
      round.silent.add(cell.toolCallId);
    }
    round.tools.push(cell);
  }
  return round;
}

function sealedText(job: ToolCallJob | ProgrammaticJob): string {
  if (job instanceof ToolCallJob) return paintObservation(liftToolImages(job.observationPayload()).payload);
  const text = job.resultText();
  return text !== "" ? text : (job.receiptJson ?? "");
}

function stubFacts(
  job: ToolCallJob | ProgrammaticJob,
  kind: string,
  snap: { readonly ok: boolean; readonly value?: unknown; readonly code?: string } | undefined,
): StubFacts {
  return {
    tool: job instanceof ToolCallJob ? job.name : job.toolName,
    kind,
    ref: refOfNode(job) ?? "job:?",
    args: job.args,
    full: sealedText(job),
    ok: snap?.ok !== false,
    value: job instanceof ToolCallJob ? job.observationPayload() : snap?.value,
    code: snap?.code,
  };
}

function toolContent(
  job: ToolCallJob | ProgrammaticJob,
  silentResult: boolean,
  producer: CompletionExpectation,
  ctx: Projection,
): string | readonly ToolTextPart[] {
  if (silentResult) return "";
  if (!job.completed) return job.background ? BACKGROUND_TOOL : IN_FLIGHT_TOOL;
  const stamp = parseJobStamp(job.retentionJson);
  const consumer = ctx.view.nextOf(producer);
  const snap = job.outcomeSnap;
  const failed = snap?.ok === false;
  if (stamp !== null && consumer !== null) {
    const rule = effectiveRule(stamp.rule, failed);
    const text = sealedText(job);
    if (text.length >= rule.minChars && horizonExpired(rule.keep, ctx.view, { consumer, owner: producer })) {
      return toolRemainder(rule.leave, stubFacts(job, stamp.kind, snap), failed);
    }
  }
  if (job instanceof ToolCallJob) {
    const visible = imageVisible(ctx.images, producer, job.toolCallId);
    return squeezeToolCall(job, "compact", (image) =>
      visible.has(image.index)
        ? toolImageLine(image, "shown")
        : toolImageLine(image, "elided", refOfNode(job) ?? "job:?"),
    );
  }
  const parts = job.resultParts();
  if (parts !== undefined)
    return parts.length === 0 ? "" : parts.map((part) => ({ ...part, text: squeezeProgrammaticText(job, part.text) }));
  const text = job.resultText();
  if (text !== "") return squeezeProgrammaticText(job, text);
  const receipt = job.receiptJson;
  return receipt == null ? IN_FLIGHT_TOOL : squeezeProgrammaticText(job, receipt);
}

// --- pictures -------------------------------------------------------------------------------

function tapeIndexOf(tape: readonly unknown[], pew: CompletionExpectation): number {
  for (let i = 0; i < tape.length; i += 1) {
    const cell = tape[i];
    if (cell === pew || tapeCompletion(cell) === pew) return i;
  }
  return -1;
}

function pictureLine(index: number, visual: UserVisualIdentity, omitted: boolean): string {
  if (omitted) return `[Image #${index} omitted: ${visual.mime}, ${visual.width}x${visual.height}]`;
  const resized =
    visual.resizedFrom == null ? "" : `, resized from ${visual.resizedFrom.width}x${visual.resizedFrom.height}`;
  const path = visual.sourcePath == null || visual.sourcePath === "" ? "" : `, ${visual.sourcePath}`;
  return `[Image #${index}: ${visual.mime}, ${visual.width}x${visual.height}${resized}${path}]`;
}

function elidedPictureLine(index: number, visual: UserVisualIdentity): string {
  const path = visual.sourcePath == null || visual.sourcePath === "" ? "" : `, ${visual.sourcePath}`;
  return `[Image #${index} elided: ${visual.mime} ${visual.width}x${visual.height}${path} — recall ${visualRef(visual.id)}]`;
}

function picturedPrompt(expectation: CompletionExpectation): boolean {
  const turn = owningTurn(expectation);
  if (turn == null || turn.visuals.length === 0) return false;
  const tape = [...turn.doneWork, ...turn.queue];
  const index = tapeIndexOf(tape, expectation);
  if (index < 0) return false;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const cell = tape[cursor];
    if (cell instanceof TurnPromptChunk) return true;
    if (cell instanceof ReACTChunk || tapeCompletion(cell) != null) return false;
  }
  return false;
}

/**
 * Which pictures the model sees in this projection. Pictures live only within
 * their own turn (`turn` evaluated against the tip, not the clock) and at most
 * `newest` per kind survive, counted newest first across the whole projection.
 */
type ImagePlan = {
  /** `${completion uuid}` → visibility per user picture index. */
  readonly user: ReadonlyMap<CompletionExpectation, readonly boolean[]>;
  /** Producer completion → tool call id → visible 1-based image indexes. */
  readonly tool: ReadonlyMap<CompletionExpectation, ReadonlyMap<string, ReadonlySet<number>>>;
};

type ImageItem =
  | { readonly kind: "image.user"; readonly completion: CompletionExpectation; readonly index: number }
  | {
      readonly kind: "image.tool";
      readonly completion: CompletionExpectation;
      readonly callId: string;
      readonly index: number;
    };

function planImages(
  view: RetentionView,
  catalog: KernelToolCatalog | undefined,
  readVisual: ProjectHistoryOptions["readVisual"],
): ImagePlan {
  const items: ImageItem[] = [];
  for (const completion of view.order) {
    if (completion === view.tip && !picturedPrompt(completion)) continue;
    const turn = owningTurn(completion);
    if (turn != null && picturedPrompt(completion)) {
      for (let index = 0; index < turn.visuals.length; index += 1) {
        items.push({ kind: "image.user", completion, index });
      }
    }
    if (completion === view.tip) continue;
    for (const job of roundOf(completion, catalog).tools) {
      if (!(job instanceof ToolCallJob) || !job.completed) continue;
      for (const image of liftToolImages(job.observationPayload()).images) {
        if (image.bytes !== null) {
          items.push({ kind: "image.tool", completion, callId: job.toolCallId, index: image.index });
        }
      }
    }
  }
  const survivors = new Map<string, number>();
  const user = new Map<CompletionExpectation, boolean[]>();
  const tool = new Map<CompletionExpectation, Map<string, Set<number>>>();
  for (let cursor = items.length - 1; cursor >= 0; cursor -= 1) {
    const item = items[cursor]!;
    const rule = kindRule(view.policyOf(item.completion), item.kind);
    const consumer = item.kind === "image.user" ? item.completion : view.nextOf(item.completion);
    let visible =
      consumer === null || !horizonExpired(rule.keep, view, { consumer, owner: item.completion, againstTip: true });
    if (visible && item.kind === "image.user" && readVisual == null) visible = true;
    const cap = newestOf(rule.keep);
    if (visible && cap !== null) {
      const seen = survivors.get(item.kind) ?? 0;
      survivors.set(item.kind, seen + 1);
      if (seen >= cap) visible = false;
    }
    if (item.kind === "image.user") {
      const flags = user.get(item.completion) ?? [];
      flags[item.index] = visible;
      user.set(item.completion, flags);
    } else if (visible) {
      const calls = tool.get(item.completion) ?? new Map<string, Set<number>>();
      const set = calls.get(item.callId) ?? new Set<number>();
      set.add(item.index);
      calls.set(item.callId, set);
      tool.set(item.completion, calls);
    }
  }
  return { user, tool };
}

const NO_INDEXES: ReadonlySet<number> = new Set();

function imageVisible(plan: ImagePlan, producer: CompletionExpectation, callId: string): ReadonlySet<number> {
  return plan.tool.get(producer)?.get(callId) ?? NO_INDEXES;
}

function userPictureParts(
  text: string,
  visuals: readonly UserVisualIdentity[],
  visible: readonly boolean[],
  readVisual: ProjectHistoryOptions["readVisual"],
): readonly HistoryUserPart[] {
  const parts: HistoryUserPart[] = [];
  if (text !== "") parts.push({ type: "text", text });
  for (let index = 0; index < visuals.length; index += 1) {
    const visual = visuals[index];
    if (visual == null) continue;
    const number = index + 1;
    if (visible[index] === false) {
      parts.push({ type: "text", text: elidedPictureLine(number, visual) });
      continue;
    }
    const bytes = readVisual == null ? null : readVisual(visual.id);
    // One line per picture: the descriptive line when the bytes ride, the omitted line when they cannot.
    if (bytes == null) {
      parts.push({ type: "text", text: pictureLine(number, visual, true) });
      continue;
    }
    parts.push(
      { type: "text", text: pictureLine(number, visual, false) },
      {
        type: "image",
        id: visual.id,
        mime: visual.mime,
        width: visual.width,
        height: visual.height,
        resizedFrom: visual.resizedFrom,
        sourcePath: visual.sourcePath,
        bytes,
      },
    );
  }
  return parts;
}

function toolImageRow(
  job: ToolCallJob,
  images: readonly ToolImage[],
  visible: ReadonlySet<number>,
): HistoryMessage | null {
  const parts: HistoryUserPart[] = [];
  for (const image of images) {
    if (!visible.has(image.index) || image.bytes === null) continue;
    parts.push({ type: "text", text: `[Image ${image.index} from ${job.name} ${refOfNode(job) ?? "job:?"}]` });
    parts.push({
      type: "image",
      id: `${refOfNode(job) ?? "job:?"}:${image.index}`,
      mime: image.mime,
      width: 0,
      height: 0,
      resizedFrom: null,
      sourcePath: null,
      bytes: image.bytes,
    });
  }
  return parts.length === 0 ? null : { role: "user", content: parts };
}

/** A `context_recall visual:<id>` result: the bytes ride in a user row (Chat tool rows are text-only). */
function recalledVisual(job: ToolCallJob, ctx: Projection): HistoryMessage | null {
  if (job.name !== "context_recall" || ctx.readVisual == null) return null;
  const json = job.outcomeSnap?.json;
  const id = json != null && typeof json === "object" ? (json as { visualId?: unknown }).visualId : undefined;
  if (typeof id !== "string") return null;
  const bytes = ctx.readVisual(id);
  if (bytes == null) return null;
  const visual = owningTurnVisuals(ctx, id);
  return {
    role: "user",
    content: [
      { type: "text", text: `[Image recalled: ${visualRef(id)}]` },
      {
        type: "image",
        id,
        mime: visual?.mime ?? "image/png",
        width: visual?.width ?? 0,
        height: visual?.height ?? 0,
        resizedFrom: visual?.resizedFrom ?? null,
        sourcePath: visual?.sourcePath ?? null,
        bytes,
      },
    ],
  };
}

function owningTurnVisuals(ctx: Projection, id: string): UserVisualIdentity | undefined {
  for (const c of ctx.view.order) {
    const found = owningTurn(c)?.visuals.find((v) => v.id === id);
    if (found !== undefined) return found;
  }
  return undefined;
}

// --- one completion -------------------------------------------------------------------------

function promptMessages(expectation: CompletionExpectation, ctx: Projection): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  const note = expectation.systemNote?.trim() ?? "";
  if (note !== "") {
    const kept = retainedText("system-note", note, expectation, ctx);
    if (kept !== null) messages.push({ role: "system", content: kept });
  }
  const rules: Array<[kind: string, rows: HistoryMessage[]]> = [
    ["notification", notificationMessagesOf(expectation)],
    ["approval-note", approvalNoteMessagesOf(expectation)],
    ["steer", steerMessagesOf(expectation)],
  ];
  for (const [kind, rows] of rules) {
    for (const row of rows) {
      const text = typeof row.content === "string" ? row.content : "";
      const kept = retainedText(kind, text, expectation, ctx);
      if (kept !== null) messages.push({ ...row, content: kept });
    }
  }
  const text = userPromptOf(expectation, ctx.readBlob);
  const turn = owningTurn(expectation);
  const visuals = turn != null && picturedPrompt(expectation) ? turn.visuals : [];
  if (text === "" && visuals.length === 0) return messages;
  messages.push({
    role: "user",
    content:
      visuals.length === 0
        ? text
        : userPictureParts(text, visuals, ctx.images.user.get(expectation) ?? [], ctx.readVisual),
  });
  return messages;
}

function historyToolCall(
  call: {
    readonly toolCallId: string;
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>> | null;
  },
  job: ToolCallJob | ProgrammaticJob | undefined,
  producer: CompletionExpectation,
  ctx: Projection,
): HistoryToolCall {
  const base = { id: call.toolCallId, name: call.name };
  const args = call.args ?? {};
  const stamp = job === undefined ? null : parseJobStamp(job.retentionJson);
  const consumer = ctx.view.nextOf(producer);
  if (
    job !== undefined &&
    stamp?.args !== undefined &&
    consumer !== null &&
    horizonExpired(stamp.args.keep, ctx.view, { consumer, owner: producer })
  ) {
    const elided = elideArgs(args, `${refOfNode(job) ?? "job:?"}#args`, stamp.args.minChars);
    if (elided.elided) return { ...base, argsJson: elided.json };
  }
  return { ...base, argsJson: JSON.stringify(args) };
}

function thinkingExpired(completion: CompletionExpectation, ctx: Projection): boolean {
  const rule = kindRule(ctx.view.policyOf(completion), "thinking", ctx.view.dialect);
  return horizonExpired(rule.keep, ctx.view, { consumer: completion, owner: completion });
}

function* emitCompletionOnTape(completion: CompletionExpectation, ctx: Projection): Generator<HistoryMessage> {
  const round = roundOf(completion, ctx.catalog);
  const prior = promptMessages(completion, ctx);
  const byId = new Map(round.tools.filter((job) => job.toolCallId !== "").map((job) => [job.toolCallId, job]));
  const stored = completion.responseCalls.map((call) =>
    historyToolCall(
      { toolCallId: call.toolCallId, name: call.name, args: call.args },
      byId.get(call.toolCallId),
      completion,
      ctx,
    ),
  );
  const calls = stored.filter((call) => !round.suppressed.has(call.id));
  const allSuppressed = stored.length > 0 && calls.length === 0;
  const dropThinking = thinkingExpired(completion, ctx);
  const thought = dropThinking ? "" : completion.responseThought;
  const encrypted = dropThinking ? "" : (completion.responseReasoningEncrypted?.trim() ?? "");
  if (
    completion.responseText !== "" ||
    calls.length > 0 ||
    thought !== "" ||
    encrypted !== "" ||
    allSuppressed ||
    ctx.echoEmptyThought
  ) {
    prior.push({
      role: "assistant",
      // Strict OpenAI-compatible providers reject null content without tool calls.
      content: completion.responseText === "" ? (calls.length > 0 ? null : "") : completion.responseText,
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
      thought,
      ...(encrypted === "" ? {} : { thoughtEncrypted: encrypted }),
    });
  }
  // A tool row answers a call in this same projection, or it is not emitted: no orphan results.
  const imageRows: HistoryMessage[] = [];
  for (const call of calls) {
    const job = byId.get(call.id);
    prior.push({
      role: "tool",
      toolCallId: call.id,
      content: job === undefined ? IN_FLIGHT_TOOL : toolContent(job, round.silent.has(call.id), completion, ctx),
    });
    if (job instanceof ToolCallJob && job.completed) {
      const row = toolImageRow(
        job,
        liftToolImages(job.observationPayload()).images,
        imageVisible(ctx.images, completion, call.id),
      );
      if (row !== null) imageRows.push(row);
      const recalled = recalledVisual(job, ctx);
      if (recalled !== null) imageRows.push(recalled);
    }
  }
  prior.push(...imageRows);
  for (const row of prior) yield row;
}

function dialectOf(tip: CompletionExpectation, given: string | undefined): string | undefined {
  if (given !== undefined) return given;
  return /claude|anthropic/i.test(tip.model) ? "anthropic" : undefined;
}

/** History before vendor wire encoding. */
export function* projectHistory(
  tip: CompletionExpectation,
  options: ProjectHistoryOptions = {},
): Generator<HistoryMessage> {
  if (tip.completionMode === "isolated") {
    for (const message of tip.promptMessages) {
      invariant(message instanceof PromptMessage, "invalid isolated prompt message");
      yield {
        role: message.role,
        content: bodyText(message.body, options.readBlob),
        ...(message.role === "assistant" ? { thought: "" } : {}),
      };
    }
    return;
  }
  const catalog = liveCatalogOf(tip, options.catalog);
  const tools: readonly ContextTool[] = selectCompletionTools(tip, catalog);
  const echoEmptyThought = options.echoEmptyThought === true;
  const tipTurn = owningTurn(tip);
  const parts = tipTurn === null ? null : systemPartsOf(tipTurn);
  // The addendum frozen with the turn's tool set wins over the live catalog: a catalog edit
  // between rounds must not rewrite the cached prefix.
  const frozenAddendum = tipTurn?.tools.addendum ?? "";
  yield {
    role: "system",
    content: [
      parts?.constitution ?? "",
      tools.length === 0
        ? NO_TOOLS_SYSTEM
        : frozenAddendum !== ""
          ? frozenAddendum
          : (catalog?.TOOLS_SYSTEM_ADDENDUM ?? NO_TOOLS_SYSTEM),
    ]
      .filter((part) => part !== "")
      .join("\n\n"),
  };
  const root = tip.plexus?.root;
  const env = parts?.env ?? {};
  const envLines: string[] = [];
  if (root instanceof SessionRoot && root.path !== "") envLines.push(`Workspace: ${root.path}`);
  for (const key of Object.keys(env).toSorted()) {
    const value = env[key] ?? "";
    if (value !== "") envLines.push(`${key}: ${value}`);
  }
  if (envLines.length > 0) yield { role: "system", content: envLines.join("\n") };
  const note = tipTurn?.derivation?.note.trim() ?? "";
  if (note !== "") yield { role: "system", content: note };
  const cutoff = tipTurn == null ? null : latestCompactCutoff(tipTurn);
  const leadRows = [];
  if (cutoff != null) {
    const kv = root instanceof SessionRoot ? root.kvs : {};
    for (const row of compactLeadRows(cutoff.turn, cutoff.job, {
      kv,
      configFloor: cutoff.job.keepTurns ?? undefined,
    })) {
      leadRows.push(row);
    }
  }
  const lead: CompletionExpectation[] = [];
  for (const row of leadRows) {
    if (row.kind === "user" || row.kind === "assistant") continue;
    const kept = completionOfCell(row.cell);
    if (kept != null && kept !== tip) lead.push(kept);
  }
  const view = buildView(tip, [...lead, ...tip.spine()], {
    ...(options.clockAt === undefined ? {} : { clockAt: options.clockAt }),
    dialect: dialectOf(tip, options.dialect),
  });
  const ctx: Projection = {
    catalog,
    echoEmptyThought,
    readVisual: options.readVisual,
    readBlob: options.readBlob,
    view,
    images: planImages(view, catalog, options.readVisual),
  };
  for (const row of leadRows) {
    if (row.kind === "user") {
      yield { role: "user", content: row.text };
      continue;
    }
    if (row.kind === "assistant") {
      yield { role: "assistant", content: row.text };
      continue;
    }
    const kept = completionOfCell(row.cell);
    if (kept == null || kept === tip) continue;
    yield* emitCompletionOnTape(kept, ctx);
  }
  for (const completion of tip.spine()) {
    if (completion === tip) {
      yield* promptMessages(completion, ctx);
      return;
    }
    yield* emitCompletionOnTape(completion, ctx);
  }
}
