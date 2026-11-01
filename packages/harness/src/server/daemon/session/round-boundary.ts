/** Detect positive continuation requests from settled facts; never infer completion from silence. */
import {
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_STREAK_MAX,
  THOUGHT_WITHOUT_ANSWER_STREAK_MAX,
} from "@inhuman.tools/continuation";
import { asSystemPrompt, prompt } from "@inhuman.tools/harness-commons";
import {
  callbackRequiredNote,
  decideRound,
  ReACTChunk,
  SessionTurn,
  TurnSteerChunk,
  jobTriggersReactLoop,
  METADATA_SAME_ROUND_NOTE,
  type CompletionJob,
  type ContinuationCandidate,
  type ContinuationKind,
  type IntentAssessment,
  type RoundDecision,
  type RoundGate,
  type SessionRoot,
} from "@inhuman.tools/harness-model";
import { splitThink } from "@inhuman.tools/tool-call-normalize";

import { joinSystemNotes } from "@/session";

import {
  LENGTH_CONTINUE_NOTE,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE,
  THOUGHT_CONTINUE_NOTE,
  thoughtWithoutAnswer,
} from "./re-act-loop-intent-detected-trigger.js";
import { CONTENT_FILTER_STOP, maxRoundsMessage, roundCapReached } from "./round-stop.js";
import type { TurnIteratorHost } from "./turn-iterator.js";

const REPAIR_ATTEMPTS = 4;
const THOUGHT_ATTEMPTS = THOUGHT_WITHOUT_ANSWER_STREAK_MAX;
const INTENT_ATTEMPTS = RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_STREAK_MAX;

/** Only an actual successful work receipt resets repair budgets. Rejected calls are not progress. */
function madeProgress(job: CompletionJob): boolean {
  return job.responseWork.some((work) => jobTriggersReactLoop(work) && work.outcomeSnap?.ok === true);
}

function attempts(turn: SessionTurn, boundary: ReACTChunk, kind: ContinuationKind): number {
  if (boundary.source != null && madeProgress(boundary.source)) return 0;
  let count = 0;
  for (let i = turn.doneWork.length - 1; i >= 0; i -= 1) {
    const cell = turn.doneWork[i];
    if (cell === boundary) continue;
    if (cell instanceof TurnSteerChunk) break;
    if (!(cell instanceof ReACTChunk)) continue;
    const decision = cell.decision;
    if (
      decision?.kind === "advance" &&
      decision.assessments.some(
        (item) => item.cause.kind === kind && item.disposition === "eligible" && item.budget != null,
      )
    )
      count += 1;
    if (cell.source != null && madeProgress(cell.source)) break;
  }
  return count;
}

export function openCallbackRowsForTurn(session: SessionRoot, turn: SessionTurn) {
  const future = new Set<string>();
  const seen = new Set<SessionTurn>();
  let unit = session.head;
  while (unit != null && unit !== turn && !seen.has(unit)) {
    seen.add(unit);
    if (unit.agentRequestId.trim() !== "") future.add(unit.agentRequestId.trim());
    if (!(unit.turnTail instanceof SessionTurn)) break;
    unit = unit.turnTail;
  }
  return session.openCallbackRows().filter((row) => !future.has(row.requestId));
}

function liveCandidates(turn: SessionTurn, host: TurnIteratorHost): ContinuationCandidate[] {
  const out: ContinuationCandidate[] = [];
  const session = host.session;
  const input = [
    ...(session.steerTurn === turn ? session.steerQueue.map((row) => row.uuid) : []),
    ...session.pendingNotices.map((note) => note.uuid),
  ];
  if (input.length > 0) out.push({ cause: { kind: "input", sources: input } });
  const activating = host.notes
    .peek(session.sessionId)
    .filter((note) => note.mode === "activating" && note.text.trim() !== "");
  if (activating.length > 0) out.push({ cause: { kind: "plugin", sources: activating.map((note) => note.id) } });
  return out;
}

/** No effects except the bounded intent assessment. The caller commits the returned decision. */
export async function assessBoundary(
  turn: SessionTurn,
  boundary: ReACTChunk,
  host: TurnIteratorHost,
  signal: AbortSignal,
): Promise<RoundDecision> {
  const source = boundary.source;
  const pew = source?.expectation;
  const candidates: ContinuationCandidate[] = [];
  let gate: RoundGate | null = null;
  const add = (kind: ContinuationKind, sources: readonly string[], limit?: number): void => {
    candidates.push({
      cause: { kind, sources },
      ...(limit == null ? {} : { budget: { used: attempts(turn, boundary, kind), limit } }),
    });
  };
  if (source == null) {
    // Old documents had executable tokens with no recorded cause. Interpret only at this compatibility boundary.
    if (!boundary.openPage)
      add(boundary.truncated ? "length-repair" : boundary.intentContinue ? "intent" : "user", [boundary.uuid]);
  } else if (pew != null && pew.outcome !== "successful") {
    gate = {
      reason: "provider-failed",
      detail: `model round failed: ${pew.failReason?.trim() || pew.endDetail?.trim() || "no reason given"}`,
    };
  } else if (pew != null) {
    const rejected = new Set(pew.responseCalls.filter((call) => call.dropReason !== "").map((call) => call.toolCallId));
    const work = source.responseWork.filter((job) => !rejected.has(job.toolCallId) && jobTriggersReactLoop(job));
    const speech = splitThink(pew.responseText).content.trim();
    if (pew.finishReason === CONTENT_FILTER_STOP) {
      gate = {
        reason: "content-filter",
        detail: "The provider's content filter stopped this response. Send another message to try again.",
      };
    } else {
      if (work.length > 0)
        add(
          "observation",
          work.map((job) => job.uuid),
          madeProgress(source) ? undefined : REPAIR_ATTEMPTS,
        );
      if (rejected.size > 0) add("call-repair", [...rejected], REPAIR_ATTEMPTS);
      if (pew.finishReason === "length" && work.length === 0 && rejected.size === 0) {
        if (speech === "")
          gate = {
            reason: "length-no-answer",
            detail:
              "The model used up its output budget while reasoning and gave no answer. Raise the output limit or ask again more narrowly.",
          };
        else add("length-repair", [source.uuid], turn.lengthContinuations ?? 3);
      } else if (work.length === 0 && rejected.size === 0) {
        if (thoughtWithoutAnswer(pew)) add("thought-repair", [source.uuid], THOUGHT_ATTEMPTS);
        else if (
          speech === "" &&
          pew.responseCalls.some((call) => call.name === "update_metadata" || call.name === "context_need")
        ) {
          add("auxiliary-repair", [source.uuid], REPAIR_ATTEMPTS);
        }
      }
      const callbacks = openCallbackRowsForTurn(host.session, turn);
      if (callbacks.length > 0)
        add(
          "callback",
          callbacks.map((row) => row.requestId),
          REPAIR_ATTEMPTS,
        );
    }
  }
  candidates.push(...liveCandidates(turn, host));
  // A judge is needed only when no cheaper trigger already authorizes the next invocation.
  const preliminary = decideRound(candidates, gate);
  if (
    pew != null &&
    gate == null &&
    preliminary.kind !== "advance" &&
    splitThink(pew.responseText).content.trim() !== ""
  ) {
    if (boundary.intentAssessment == null) {
      let assessment: IntentAssessment;
      try {
        assessment = await host.classifyIntent(pew, signal);
      } catch (error) {
        assessment = {
          verdict: null,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (!signal.aborted) boundary.intentAssessment = assessment;
    }
    if (boundary.intentAssessment?.verdict === "continue") add("intent", [source!.uuid], INTENT_ATTEMPTS);
  }
  // Input may arrive while the judge runs. Refresh event facts before the synchronous commit.
  const stable = candidates.filter(
    (candidate) => candidate.cause.kind !== "input" && candidate.cause.kind !== "plugin",
  );
  const finalCandidates = [...stable, ...liveCandidates(turn, host)];
  if (gate == null && roundCapReached(turn) && decideRound(finalCandidates).kind === "advance") {
    gate = { reason: "round-limit", detail: maxRoundsMessage(turn.maxRounds ?? 0) };
  }
  return decideRound(finalCandidates, gate, boundary.intentAssessment);
}

/** Every admitted cause contributes context. Ambient notes enrich a round but cannot authorize one. */
export function boundaryNote(turn: SessionTurn, boundary: ReACTChunk | null, host: TurnIteratorHost) {
  const kinds = new Set(boundary?.decision?.causes.map((cause) => cause.kind));
  const notes = [];
  if (kinds.has("length-repair")) notes.push(LENGTH_CONTINUE_NOTE);
  if (kinds.has("thought-repair")) notes.push(THOUGHT_CONTINUE_NOTE);
  if (kinds.has("intent")) notes.push(RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE);
  if (kinds.has("auxiliary-repair")) notes.push(METADATA_SAME_ROUND_NOTE);
  const callbacks = openCallbackRowsForTurn(host.session, turn);
  if (callbacks.length > 0) notes.push(callbackRequiredNote(host.session.agent.spec.voidLegal, callbacks));
  const pending = host.notes.peek(host.session.sessionId).filter((note) => note.text.trim() !== "");
  const recorded = boundary?.contextNotes ?? [];
  const context = [
    ...recorded,
    ...pending.filter((note) => !recorded.some((old) => old.id === note.id && old.text === note.text)),
  ];
  if (context.length > 0) notes.push(asSystemPrompt(context.map((note) => note.text).join("\n\n")));
  return { note: notes.length > 0 ? joinSystemNotes(notes) : prompt.system``, noteIds: pending.map((note) => note.id) };
}

/** Re-read inbox facts at the commit site: an awaited detector must not seal over new input. */
export function refreshBoundaryEvents(
  turn: SessionTurn,
  host: TurnIteratorHost,
  decision: RoundDecision,
): RoundDecision {
  const candidates = decision.assessments.filter((item) => item.cause.kind !== "input" && item.cause.kind !== "plugin");
  const live = [...candidates, ...liveCandidates(turn, host)];
  const gate =
    decision.kind === "blocked"
      ? { reason: decision.reason, detail: decision.detail }
      : roundCapReached(turn) && decideRound(live).kind === "advance"
        ? { reason: "round-limit" as const, detail: maxRoundsMessage(turn.maxRounds ?? 0) }
        : null;
  return decideRound(live, gate, decision.intent);
}
