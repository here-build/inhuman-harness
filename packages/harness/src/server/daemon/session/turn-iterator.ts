import { prompt } from "@inhuman.tools/harness-commons";
import { step, trace } from "@inhuman.tools/harness-diagnostics";
import {
  CompactJob,
  CompletionExpectation,
  CompletionJob,
  CONTEXT_NEED_TOOL_NAME,
  DEFAULT_LENGTH_CONTINUATIONS,
  ResponseCallOrder,
  SystemToolJob,
  parseCompactTrigger,
  ProgrammaticJob,
  ReACTChunk,
  SessionRoot,
  SessionTurn,
  ToolCallJob,
  TurnPromptChunk,
  UPDATE_METADATA_TOOL_NAME,
  type TurnChunk,
  type IntentAssessment,
  type RoundGate,
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
  isWorkReachable,
  sealedActorRounds,
  SIDE_CHANNEL_REMINDER_EVERY,
  sideChannelReminderNote,
  turnLoopStopped,
} from "@/session";
import { catalogOf } from "@/tool-catalog";

import { ambientCutoff, ambientModel, type startAmbientCompact } from "./ambient-compact.js";
import { questionLineFromSpeech } from "./re-act-loop-intent-detected-trigger.js";
import { assessBoundary, boundaryNote, refreshBoundaryEvents } from "./round-boundary.js";
import { CONTENT_FILTER_STOP, maxRoundsMessage, refusalText, roundCapReached } from "./round-stop.js";
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
  classifyIntent(completion: CompletionExpectation, signal: AbortSignal): Promise<IntentAssessment>;
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
function* turnSequence(turn: SessionTurn, signal: AbortSignal): Generator<TurnChunk> {
  while (!turnLoopStopped(turn, signal)) {
    const cell = turn.take();
    if (cell == null) return;
    yield cell;
  }
}

export async function iterateTurn(turn: SessionTurn, host: TurnIteratorHost, signal: AbortSignal): Promise<void> {
  if (turnLoopStopped(turn, signal)) return;
  const session = host.session;
  const connectionId = session.kvs.connection?.trim() ?? "";
  const model = session.kvs.model?.trim() ?? "";
  // Recorded once: a live setting change does not move a turn that is already running.
  turn.stampLoopLimits(host.loopLimits?.(turn) ?? { maxRounds: 0, lengthContinuations: DEFAULT_LENGTH_CONTINUATIONS });
  for (const chunk of turnSequence(turn, signal)) {
    if (turnLoopStopped(turn, signal)) return;
    switch (true) {
      case chunk instanceof CompactJob: {
        await host.resolvers.compact(chunk, signal);
        continue;
      }
      case chunk instanceof TurnPromptChunk:
      case chunk instanceof ReACTChunk: {
        if (chunk instanceof ReACTChunk) {
          if (chunk.decision == null) {
            if (!chunk.roundClosed) {
              const pew = chunk.source?.expectation;
              await host.closeRound(
                pew?.outcome === "failed"
                  ? { ok: false, error: pew.failReason ?? pew.endDetail ?? "model round failed" }
                  : { ok: true, value: pew?.responseText || false },
              );
              if (turnLoopStopped(turn, signal)) return;
              chunk.roundClosed = true;
            }
            const assessed = await assessBoundary(turn, chunk, host, signal);
            if (turnLoopStopped(turn, signal)) return;
            const decision = refreshBoundaryEvents(turn, host, assessed);
            turn.commitBoundary(
              chunk,
              decision,
              host.notes.peek(session.sessionId),
              decision.reason === "awaiting-user" && chunk.source != null
                ? questionLineFromSpeech(chunk.source.expectation.responseText)
                : "",
            );
          }
          if (chunk.decision?.kind !== "advance") continue;
          if (chunk.decision.nextRoundId != null) continue;
        }
        if (turnLoopStopped(turn, signal)) return;
        if (connectionId === "") {
          blockAdmission(turn, chunk, {
            reason: "no-connection",
            detail: "no connection is configured for this session",
          });
          return;
        }
        if (chunk instanceof ReACTChunk && !isWorkReachable(session, turn)) return;
        if (roundCapReached(turn)) {
          blockAdmission(turn, chunk, { reason: "round-limit", detail: maxRoundsMessage(turn.maxRounds ?? 0) });
          return;
        }
        if (chunk instanceof ReACTChunk) chunk.waitingFor = "inbound";
        if (!(await host.waitInbound(signal)) || turnLoopStopped(turn, signal)) return;
        const resumed = turn.doneWork.some(
          (done) => done !== chunk && (done instanceof TurnPromptChunk || done instanceof ReACTChunk),
        );
        if (chunk instanceof ReACTChunk) chunk.waitingFor = "round-hook";
        const opened = await host.openRound(resumed);
        if (turnLoopStopped(turn, signal)) return;
        if (!opened) {
          blockAdmission(turn, chunk, { reason: "plugin-refused", detail: "a plugin refused to open the round" });
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
        const enrichment = boundaryNote(turn, chunk instanceof ReACTChunk ? chunk : null, host);
        completion.systemNote = enrichment.note;
        const frozenNames = turn.tools.entries.map((entry) => entry.name);
        completion.systemNote = joinSystemNotes([
          completion.systemNote,
          sideChannelReminderNote(
            sealedActorRounds(turn),
            SIDE_CHANNEL_REMINDER_EVERY,
            frozenNames.length > 0 ? frozenNames : null,
          ),
        ]);
        runInAction(() => {
          const next = new CompletionJob({ expectation: completion, managesResponse: true });
          turn.admitRound(chunk instanceof ReACTChunk ? chunk : null, next);
          host.notes.consume(session.sessionId, enrichment.noteIds, turn.uuid);
        });
        // R3: read the live inputs once (wall clock, prior warmUntilMs, estimated savings) and record them.
        stampRetentionClock(completion);
        step(`turn round ${turn.doneWork.length + turn.queue.length} ${turn.prompt}`);
        trace("harness:turn", `round ${turn.uuid} queued=${turn.queue.length}`);
        break;
      }
      case chunk instanceof CompletionJob: {
        const pew = chunk.expectation;
        if (pew == null) break;
        if (!pew.isDone) await host.resolvers.completion(chunk, signal);
        if (turnLoopStopped(turn, signal)) return;
        if (chunk.responseExpanded) break;
        if (pew.outcome !== "successful") {
          turn.finishResponseExpansion(chunk);
          break;
        }
        const filtered = pew.finishReason === CONTENT_FILTER_STOP;
        const refusals = pew.responseCalls.filter((call) => filtered || call.dropReason !== "");
        const calls = pew.responseCalls.filter((call) => !refusals.includes(call)).map(toolCallFromResponse);
        const order = new ResponseCallOrder({
          entryClass: (name) => catalogOf(session)?.catalogEntry(name)?.class,
          remoteMcp: (key) => host.remoteMcp?.(key) ?? false,
        });
        let cursor = 0;
        const record = (make: () => ToolCallJob | ProgrammaticJob) =>
          runInAction(() => {
            const existing = chunk.responseWork[cursor++];
            if (existing != null) {
              order.place(existing);
              return existing;
            }
            const tool = make();
            order.place(tool);
            turn.recordResponseWork(chunk, tool);
            return tool;
          });
        for (const call of refusals) {
          record(
            () =>
              new SystemToolJob({
                toolCallId: call.toolCallId,
                name: call.name,
                argsJson: "{}",
                humanApprove: false,
                completed: true,
                triggersReactLoop: false,
                outcomeJson: JSON.stringify({ ok: false, text: refusalText(call.dropReason, filtered) }),
              }),
          );
        }
        // Early metadata must settle before other calls become reachable. The durable cursor
        // makes re-entry safe even when a park happens in this wait.
        const early = [
          ...calls.filter((call) => call.function.name === UPDATE_METADATA_TOOL_NAME),
          ...calls.filter((call) => call.function.name === CONTEXT_NEED_TOOL_NAME),
        ];
        for (const call of early) {
          const tool = record(() => host.admit(call));
          if (!tool.completed && (await host.resolvers.work(tool, signal)) === "aborted") return;
          if (turnLoopStopped(turn, signal)) return;
        }
        for (const call of calls.filter(
          (candidate) =>
            candidate.function.name !== UPDATE_METADATA_TOOL_NAME && candidate.function.name !== CONTEXT_NEED_TOOL_NAME,
        )) {
          record(() => host.admit(call));
        }
        const read = compactRead(host.compactKeepTurns, session.kvs);
        const eat = Transcript.fromCells(historyBehind(turn, read));
        const zones = sliceCompactZones(eat, keepFloors(turn.contextNeed, session.kvs, false, read.configFloor));
        const zoneSlice = { prefix: zones.prefix, keep: zones.keep };
        const forced = tailCompactCandidate(turn, parseCompactTrigger(host.hardCompactTrigger), zoneSlice);
        let forcedCompact: CompactJob | null = null;
        if (forced != null) {
          const job = new CompactJob({ reason: forced });
          // F8: the cut's inputs are facts of this job from here on, not live settings.
          stampCompactInputs(job, read.configFloor, session.kvs);
          forcedCompact = job;
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
        turn.finishResponseExpansion(chunk, forcedCompact);
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

function blockAdmission(turn: SessionTurn, chunk: TurnPromptChunk | ReACTChunk, gate: RoundGate): void {
  runInAction(() => {
    if (chunk instanceof ReACTChunk && chunk.decision != null) {
      turn.commitBoundary(chunk, { ...chunk.decision, kind: "blocked", ...gate }, chunk.contextNotes, "");
    } else turn.stopLoop(gate.detail);
  });
}

function compactRead(
  configFloor: number,
  kv: Readonly<Record<string, string>>,
): { readonly configFloor: number; readonly kv: Readonly<Record<string, string>> } {
  return { configFloor: Math.max(configFloor, 1), kv };
}
