import { asSystemPrompt, prompt } from "@inhuman.tools/harness-commons";
import { step, trace } from "@inhuman.tools/harness-diagnostics";
import {
  callbackRequiredNote,
  CompactJob,
  CompletionExpectation,
  CompletionJob,
  CONTEXT_NEED_TOOL_NAME,
  ContextNeedToolJob,
  DEFAULT_LENGTH_CONTINUATIONS,
  ResponseCallOrder,
  SystemToolJob,
  contextNeedRound,
  isTitledOnlyCompletion,
  jobTriggersReactLoop,
  METADATA_SAME_ROUND_NOTE,
  parseCompactTrigger,
  ProgrammaticJob,
  ReACTChunk,
  SessionRoot,
  SessionTurn,
  tapeCompletion,
  ToolCallJob,
  TurnPromptChunk,
  TurnSteerChunk,
  UPDATE_METADATA_TOOL_NAME,
  type TurnChunk,
} from "@inhuman.tools/harness-model";
import { type ToolCall } from "@inhuman.tools/tool-call-normalize";
import { runInAction } from "mobx";

import {
  compactDecision,
  historyBehind,
  stampRetentionClock,
  keepFloors,
  stampCompactInputs,
  sliceCompactZones,
  tailCompactCandidate,
  Transcript,
} from "@/context";
import type { NoteLog, Settle } from "@/extensions";
import {
  joinSystemNotes,
  sealedActorRounds,
  SIDE_CHANNEL_REMINDER_EVERY,
  sideChannelReminderNote,
  turnLoopStopped,
} from "@/session";
import { catalogOf } from "@/tool-catalog";

import { ambientCutoff, ambientModel, type startAmbientCompact } from "./ambient-compact.js";
import {
  LENGTH_CONTINUE_NOTE,
  questionLineFromSpeech,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE,
  THOUGHT_CONTINUE_NOTE,
  thoughtWithoutAnswer,
  thoughtWithoutAnswerCapped,
  type ReActLoopIntentDetectedTriggerVerdict,
} from "./re-act-loop-intent-detected-trigger.js";
import { CONTENT_FILTER_STOP, maxRoundsMessage, refusalText, roundCapReached, roundStop } from "./round-stop.js";
import type { TurnResolvers } from "./turn-resolvers.js";
import { toolCallFromResponse } from "../../util/tool-call-json.js";

/** Sequence rules depend on document data and explicit ports, never a daemon. */
export interface TurnIteratorHost {
  readonly session: SessionRoot;
  readonly resolvers: TurnResolvers;
  readonly notes: NoteLog;
  readonly compactKeepTurns: number;
  readonly hardCompactTrigger: string;
  admit(call: ToolCall): ToolCallJob | ProgrammaticJob;
  waitInbound(signal: AbortSignal): Promise<boolean>;
  openRound(resumed: boolean): Promise<boolean>;
  closeRound(settle: Settle): Promise<void>;
  classifyIntent(
    completion: CompletionExpectation,
    signal: AbortSignal,
  ): Promise<ReActLoopIntentDetectedTriggerVerdict>;
  startAmbientCompact(options: Omit<Parameters<typeof startAmbientCompact>[0], "complete" | "inflight">): void;
  /**
   * The loop limits to record on this turn when it starts. Absent means unlimited rounds and
   * the default number of length continuations.
   */
  loopLimits?(turn: SessionTurn): { readonly maxRounds: number; readonly lengthContinuations: number };
  /** True for a third-party MCP server. Absent, or an unknown connection, is local and runs in order. */
  remoteMcp?(connectionKey: string): boolean;
}

/**
 * Append-and-iterate view of the persisted tape. The doneWork/queue
 * split is the durable cursor; entering a cell is independent of resolving it.
 * No snapshot iterator: appends are visited in this same pass.
 */
export class TurnSequence implements Iterable<TurnChunk> {
  constructor(
    readonly turn: SessionTurn,
    readonly signal?: AbortSignal,
  ) {}

  push(...cells: TurnChunk[]): void {
    for (const cell of cells) this.turn.enqueue(cell);
  }

  *[Symbol.iterator](): Iterator<TurnChunk> {
    for (let cell = this.take(); cell != null; cell = this.take()) {
      yield cell;
    }
  }

  private take(): TurnChunk | undefined {
    if (this.turn.reducerExited || this.turn.cancelRequested || this.signal?.aborted) return undefined;
    return this.turn.take();
  }
}

export async function iterateTurn(turn: SessionTurn, host: TurnIteratorHost, signal: AbortSignal): Promise<void> {
  if (turnLoopStopped(turn, signal)) return;
  const session = host.session;
  const connectionId = session.kvs.connection?.trim() ?? "";
  const model = session.kvs.model?.trim() ?? "";
  const sequence = new TurnSequence(turn, signal);
  // Recorded once: a live setting change does not move a turn that is already running.
  turn.stampLoopLimits(host.loopLimits?.(turn) ?? { maxRounds: 0, lengthContinuations: DEFAULT_LENGTH_CONTINUATIONS });
  for (const chunk of sequence) {
    if (turnLoopStopped(turn, signal)) return;
    switch (true) {
      case chunk instanceof CompactJob: {
        await host.resolvers.compact(chunk, signal);
        if (chunk.cutoff) reenterAfterCompact(turn, chunk);
        continue;
      }
      case chunk instanceof TurnPromptChunk:
      case chunk instanceof ReACTChunk: {
        await host.closeRound({ ok: true, value: false });
        if (turnLoopStopped(turn, signal)) return;
        if (
          chunk instanceof ReACTChunk &&
          chunk.openPage &&
          !behaviorNotesPending(session, host.notes) &&
          !(session.steerTurn === turn && session.steerQueue.length > 0) &&
          session.pendingNotices.length === 0
        ) {
          chunk.skipped = true;
          continue;
        }
        if (connectionId === "") {
          turn.broke = "no connection is configured for this session";
          return;
        }
        if (chunk instanceof ReACTChunk && !session.liveChain.includes(turn)) return;
        if (roundCapReached(turn)) {
          turn.stopLoop(maxRoundsMessage(turn.maxRounds ?? 0));
          return;
        }
        if (!(await host.waitInbound(signal)) || turnLoopStopped(turn, signal)) return;
        const resumed = turn.doneWork.some(
          (done) => done !== chunk && (done instanceof TurnPromptChunk || done instanceof ReACTChunk),
        );
        const opened = await host.openRound(resumed);
        if (turnLoopStopped(turn, signal)) return;
        if (!opened) {
          turn.broke = "a plugin refused to open the round";
          return;
        }
        turn.claimApprovalNotes();
        session.claimSteers(turn);
        session.claimNotices(turn);
        const messages = historyBehind(turn, compactRead(host.compactKeepTurns, session.kvs));
        const completion = new CompletionExpectation({
          promptText: chunk instanceof TurnPromptChunk ? turn.completionMessage : prompt.user``,
          connectionId,
          model,
          messages,
          reasoningEffort: session.agent.spec.reasoningEffort,
        });
        let holdNotes = false;
        if (chunk instanceof ReACTChunk) {
          const prior = tapeCompletion(turn.doneWork.findLast((cell) => tapeCompletion(cell) != null));
          const workTools = priorWorkToolCount(session, prior);
          const titledOnly = prior != null && titledOnlyCompletion(session, prior);
          const pack = loopEndPack(session, host.notes);
          const pending = behaviorNotesPending(session, host.notes);
          // Open Call, not empty tape: work tools do not close ask.
          const callbackRows = openCallbackRowsForTurn(session, turn);
          const awaiting = callbackRows.length > 0;
          const continuing = chunk.intentContinue || chunk.truncated;
          completion.systemNote = chunk.truncated
            ? LENGTH_CONTINUE_NOTE
            : chunk.intentContinue
              ? prior != null && thoughtWithoutAnswer(prior)
                ? THOUGHT_CONTINUE_NOTE
                : RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE
              : awaiting
                ? callbackRequiredNote(session.agent.spec.voidLegal, callbackRows)
                : workTools === 0 && pending && pack.note !== ""
                  ? pack.note
                  : titledOnly
                    ? METADATA_SAME_ROUND_NOTE
                    : workTools === 0
                      ? pack.note
                      : prompt.system``;
          if (
            !continuing &&
            !awaiting &&
            workTools === 0 &&
            pack.consumedIds.length > 0 &&
            ((pending && pack.note !== "") || !titledOnly)
          ) {
            host.notes.consume(session.sessionId, pack.consumedIds, turn.uuid);
          }
          holdNotes = continuing || awaiting || (titledOnly && !(pending && pack.note !== ""));
        } else {
          // `agent__respond` is a fixed tool, so a first round learns the open request ids here.
          const callbackRows = openCallbackRowsForTurn(session, turn);
          if (callbackRows.length > 0) {
            completion.systemNote = callbackRequiredNote(session.agent.spec.voidLegal, callbackRows);
          }
        }
        if (!holdNotes) {
          const left = host.notes.peek(session.sessionId).filter((note) => note.text.trim() !== "");
          if (left.length > 0) {
            completion.systemNote = joinSystemNotes([
              completion.systemNote,
              asSystemPrompt(left.map((note) => note.text).join("\n\n")),
            ]);
            host.notes.consume(
              session.sessionId,
              left.map((note) => note.id),
              turn.uuid,
            );
          }
        }
        const frozenNames = turn.tools.entries.map((entry) => entry.name);
        completion.systemNote = joinSystemNotes([
          completion.systemNote,
          sideChannelReminderNote(
            sealedActorRounds(turn),
            SIDE_CHANNEL_REMINDER_EVERY,
            frozenNames.length > 0 ? frozenNames : null,
          ),
        ]);
        sequence.push(new CompletionJob({ expectation: completion }));
        // R3: read the live inputs once (wall clock, prior warmUntilMs, estimated savings) and record them.
        stampRetentionClock(completion);
        step(`turn round ${turn.doneWork.length + turn.queue.length} ${turn.prompt}`);
        trace("harness:turn", `round ${turn.uuid} queued=${turn.queue.length}`);
        break;
      }
      case chunk instanceof CompletionJob: {
        const pew = chunk.expectation;
        if (pew == null) break;
        await host.resolvers.completion(chunk, signal);
        if (turnLoopStopped(turn, signal)) return;
        if (pew.outcome !== "successful") {
          // A round that failed ends the turn. Say why on the turn, not only in diagnostics.
          if (pew.outcome === "failed" && pew.endCause !== "cancel") {
            turn.broke = `model round failed: ${pew.failReason?.trim() || pew.endDetail?.trim() || "no reason given"}`;
          }
          return;
        }
        // A call the stream cut off, or any call from a response the provider's filter stopped,
        // is never run. It gets a sealed failed receipt so the model hears about it.
        // The actor normalized the rest once, and the assistant message records them.
        const filtered = pew.finishReason === CONTENT_FILTER_STOP;
        const refusals = pew.responseCalls.filter((call) => filtered || call.dropReason !== "");
        const calls = pew.responseCalls.filter((call) => !refusals.includes(call)).map(toolCallFromResponse);
        const order = new ResponseCallOrder({
          entryClass: (name) => catalogOf(session)?.catalogEntry(name)?.class,
          remoteMcp: (key) => host.remoteMcp?.(key) ?? false,
        });
        const startCall = (call: (typeof calls)[number]) =>
          runInAction(() => {
            const tool = host.admit(call);
            order.place(tool);
            sequence.push(tool);
            return tool;
          });
        const refused = refusals.map((call) =>
          runInAction(() => {
            const tool = new SystemToolJob({
              toolCallId: call.toolCallId,
              name: call.name,
              argsJson: "{}",
              humanApprove: false,
              completed: true,
              outcomeJson: JSON.stringify({ ok: false, text: refusalText(call.dropReason, filtered) }),
            });
            sequence.push(tool);
            return tool;
          }),
        );
        // Ack title then need before any other call starts, even if they were not first.
        // Construction appends the job, which makes it reachable, so the rest stay
        // unconstructed until that wait finishes.
        const early = [
          ...calls.filter((call) => call.function.name === UPDATE_METADATA_TOOL_NAME),
          ...calls.filter((call) => call.function.name === CONTEXT_NEED_TOOL_NAME),
        ];
        const opened: Array<ReturnType<typeof startCall>> = [];
        for (const call of early) {
          const tool = startCall(call);
          opened.push(tool);
          if (tool instanceof ContextNeedToolJob) {
            const parsed = tool.need;
            step(
              `context-need ${
                parsed == null
                  ? "invalid"
                  : JSON.stringify({
                      ...parsed,
                      used: turn.contextUsed,
                      limit: turn.contextLimit,
                    })
              }`,
            );
          }
          if ((await host.resolvers.work(tool, signal)) === "aborted") return;
          if (turnLoopStopped(turn, signal)) return;
        }
        const rest = calls
          .filter(
            (call) => call.function.name !== UPDATE_METADATA_TOOL_NAME && call.function.name !== CONTEXT_NEED_TOOL_NAME,
          )
          .map(startCall);
        const tools = [...opened, ...rest, ...refused];
        const work = tools.filter((tool) => !(tool instanceof ToolCallJob) || jobTriggersReactLoop(tool));
        if (work.length === 0) {
          for (const tool of rest) {
            if ((await host.resolvers.work(tool, signal)) === "aborted") return;
            if (turnLoopStopped(turn, signal)) return;
          }
        }
        const read = compactRead(host.compactKeepTurns, session.kvs);
        const eat = Transcript.fromCells(historyBehind(turn, read));
        const zones = sliceCompactZones(eat, keepFloors(turn.contextNeed, session.kvs, false, read.configFloor));
        const zoneSlice = { prefix: zones.prefix, keep: zones.keep };
        const forced = tailCompactCandidate(turn, parseCompactTrigger(host.hardCompactTrigger), zoneSlice);
        if (forced != null) {
          const job = new CompactJob({ reason: forced });
          // F8: the cut's inputs are facts of this job from here on, not live settings.
          stampCompactInputs(job, read.configFloor, session.kvs);
          sequence.push(job);
        }
        const option = compactDecision(turn, zoneSlice);
        const cutoff = option == null ? null : ambientCutoff(zones.keep);
        const summarizer = ambientModel(session.kvs, model);
        if (option != null && cutoff != null && connectionId !== "" && summarizer !== "") {
          host.startAmbientCompact({
            home: turn,
            cutoff,
            prefix: zones.prefix,
            focus: option.focus,
            connectionId,
            model: summarizer,
          });
        }
        const sideChannelOnly = tools.length > 0 && work.length === 0;
        const titledOnly = sideChannelOnly && titledOnlyCompletion(session, pew);
        const needRound = contextNeedRound(pew);
        const awaitingCallback = openCallbackRowsForTurn(session, turn).length > 0;
        const textOnly = work.length === 0 && !titledOnly;
        if (textOnly) {
          await host.closeRound({ ok: true, value: pew.responseText });
          if (turnLoopStopped(turn, signal)) return;
        }
        const hadPending = session.pendingNotices.length > 0;
        if (work.length === 0) session.claimNotices(turn);
        if (work.length > 0) turn.questionLine = "";
        const idleNudge = titledOnly || needRound === "keep" || (work.length === 0 && awaitingCallback);
        const stop = roundStop(turn, pew, work.length);
        if (stop?.kind === "stop") {
          turn.stopLoop(stop.message);
        } else if (stop?.kind === "continue") {
          turn.questionLine = "";
          sequence.push(new ReACTChunk({ truncated: true }));
        } else if (
          work.length > 0 ||
          (session.steerTurn === turn && session.steerQueue.length > 0) ||
          hadPending ||
          (idleNudge && roundsWithoutWork(turn) <= IDLE_ROUND_MAX)
        ) {
          sequence.push(new ReACTChunk());
        } else if (idleNudge) {
          sequence.push(new ReACTChunk({ openPage: true }));
        } else if (
          textOnly &&
          needRound !== "seal" &&
          thoughtWithoutAnswer(pew) &&
          !behaviorNotesPending(session, host.notes)
        ) {
          turn.questionLine = "";
          sequence.push(
            new ReACTChunk(thoughtWithoutAnswerCapped(turn) ? { openPage: true } : { intentContinue: true }),
          );
        } else if (textOnly && needRound !== "seal") {
          if (behaviorNotesPending(session, host.notes)) {
            sequence.push(new ReACTChunk({ openPage: true }));
          } else {
            const intern = await host.classifyIntent(pew, signal);
            if (turnLoopStopped(turn, signal)) return;
            if (intern === "continue") {
              turn.questionLine = "";
              sequence.push(new ReACTChunk({ intentContinue: true }));
            } else {
              if (intern === "question") turn.questionLine = questionLineFromSpeech(pew.responseText);
              sequence.push(new ReACTChunk({ openPage: true }));
            }
          }
        }
        break;
      }
      case chunk instanceof ToolCallJob:
      case chunk instanceof ProgrammaticJob: {
        trace(
          "harness:turn",
          `work ${turn.uuid} ${chunk instanceof ToolCallJob ? chunk.name : "scheme"} ${chunk.toolCallId}`,
        );
        if (!chunk.completed && (await host.resolvers.work(chunk, signal)) === "aborted") return;
        if (turnLoopStopped(turn, signal)) return;
        break;
      }
      default:
        break;
    }
  }
}

/** Runaway guard for rounds that only title, re-ask for context, or leave a Call unanswered. */
const IDLE_ROUND_MAX = 4;

/** Consecutive actor rounds since the last work tool or steer, including the latest. */
function roundsWithoutWork(turn: SessionTurn): number {
  let count = 0;
  for (let index = turn.doneWork.length - 1; index >= 0; index -= 1) {
    const cell = turn.doneWork[index];
    const pew = tapeCompletion(cell);
    if (pew != null) {
      if (pew.completionMode !== "isolated") count += 1;
      continue;
    }
    if (cell instanceof ToolCallJob && jobTriggersReactLoop(cell)) break;
    if (cell instanceof ProgrammaticJob || cell instanceof TurnSteerChunk) break;
  }
  return count;
}

function behaviorNotesPending(session: SessionRoot, notes: NoteLog): boolean {
  return notes.peek(session.sessionId).some((note) => note.text.trim() !== "");
}

/** Pack unconsumed behavior notes for the next model input. */
function loopEndPack(session: SessionRoot, notes: NoteLog) {
  const parts: string[] = [];
  const consumedIds: string[] = [];
  for (const note of notes.peek(session.sessionId)) {
    if (note.text.trim() === "") continue;
    parts.push(note.text);
    consumedIds.push(note.id);
  }
  return { note: asSystemPrompt(parts.join("\n\n")), consumedIds };
}

function openCallbackRowsForTurn(session: SessionRoot, turn: SessionTurn) {
  const futureRequestIds = new Set<string>();
  let unit = session.head;
  const seen = new Set<SessionTurn>();
  while (unit != null && unit !== turn && !seen.has(unit)) {
    seen.add(unit);
    const reqId = unit.agentRequestId.trim();
    if (reqId !== "") futureRequestIds.add(reqId);
    if (!(unit.turnTail instanceof SessionTurn)) break;
    unit = unit.turnTail;
  }
  const rows = session.openCallbackRows();
  if (futureRequestIds.size === 0) return rows;
  return rows.filter((row) => !futureRequestIds.has(row.requestId));
}

function callIsSideChannel(session: SessionRoot, name: string): boolean {
  return catalogOf(session)?.catalogEntry(name)?.isSideChannel === true;
}

function titledOnlyCompletion(
  session: SessionRoot,
  chunk: { readonly responseText: string; readonly responseCalls: readonly { readonly name: string }[] },
): boolean {
  return isTitledOnlyCompletion({
    responseText: chunk.responseText,
    responseCalls: chunk.responseCalls.map((call) => ({
      name: call.name,
      isSideChannel: callIsSideChannel(session, call.name),
    })),
  });
}

function priorWorkToolCount(session: SessionRoot, completion: CompletionExpectation | null): number {
  if (completion == null) return 0;
  return completion.responseCalls.filter((call) => !callIsSideChannel(session, call.name)).length;
}

/**
 * A speculative continuation queued behind this cutoff is inert, so a
 * text-only overflow exits on the card and paints as an interrupted turn.
 * Slash compact is the card. A second cutoff in the same turn stays a card
 * too: the gauge is still the pre-fold report, and promoting again spins.
 */
function reenterAfterCompact(turn: SessionTurn, compact: CompactJob): void {
  if (compact.reason === "user") return;
  const next = turn.queue[0];
  if (!(next instanceof ReACTChunk) || !next.openPage) return;
  const priorCutoff = turn.doneWork.some((chunk) => chunk !== compact && chunk instanceof CompactJob && chunk.cutoff);
  if (priorCutoff) return;
  next.openPage = false;
}

function compactRead(
  configFloor: number,
  kv: Readonly<Record<string, string>>,
): { readonly configFloor: number; readonly kv: Readonly<Record<string, string>> } {
  return { configFloor: Math.max(configFloor, 1), kv };
}
