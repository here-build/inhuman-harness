/**
 * Tape liveness from PEW fields + the cover predicate.
 * Walk reactChunks + toolCalls, never walkWork (honor bag is not tape).
 * The pin stays up while `SessionTurn.inLoop`. The phrase still walks the tape.
 * Tape work stops before `askPaintHead` — that job is the pin, not a row.
 * Cover chrome still follows `approvalHead` (`needsHuman`).
 */
import { trace } from "@inhuman.tools/harness-diagnostics";
import {
  CallJob,
  type CompletionExpectation,
  ProgrammaticJob,
  reactChunks,
  tapeCompletion,
  type SessionTurn,
  ToolCallJob,
} from "@inhuman.tools/harness-model";
import type { ToolOutcomeSnap } from "@inhuman.tools/harness-model/schemas";

import { agentSpecKey, formatWaitingForAgents } from "./agent-cover.js";
import { mutateArgsHaveDiff } from "./identity.js";

let lastWaitNote = "";

function noteWait(line: string): void {
  if (line === lastWaitNote) return;
  lastWaitNote = line;
  trace("harness:paint", line);
}

export type TurnLiveness = "running" | "waiting-for-you" | "idle";
export type ToolCellState = "live" | "ok" | "fail" | "ask" | "judging";
export type SchemeCellState = "live" | "ok" | "fail";

export function outcomeSnapOf(work: { readonly outcomeSnap: ToolOutcomeSnap | undefined }): ToolOutcomeSnap | null {
  return work.outcomeSnap ?? null;
}

export function tapeTools(turn: SessionTurn): ToolCallJob[] {
  const out: ToolCallJob[] = [];
  for (const chunk of [...turn.doneWork, ...turn.queue]) {
    if (chunk instanceof ToolCallJob) out.push(chunk);
    if (chunk instanceof ProgrammaticJob) out.push(...chunk.toolCalls);
  }
  return out;
}

export function toolCellState(work: ToolCallJob): ToolCellState {
  if (work.needsHuman) return "ask";
  if (judgeEvaluating(work)) return "judging";
  if (!work.completed && work.receiptJson == null) return "live";
  const snap = outcomeSnapOf(work);
  if (snap?.ok === false) return "fail";
  return "ok";
}

/**
 * Remainder classifier is mid-vote on a leaf the floor already routed to it.
 * Excludes the cover: `needsHuman` wins first, and a fail message means the
 * classifier is retrying in the background, not deciding this leaf now.
 */
function judgeEvaluating(work: ToolCallJob): boolean {
  if (work.completed || work.cancelled || work.humanApprove !== null) return false;
  if (work.classifierResult !== null || work.classifierAbstain !== null) return false;
  return work.autoClassifierPending;
}

/**
 * Isolated remainder-classifier PEWs hang on the leaf, not the ReACT tape.
 * Occupancy and thought paint walk these; `walkWork` would pull the honor bag.
 */
export function leftoverJudgeCompletions(turn: SessionTurn): CompletionExpectation[] {
  const out: CompletionExpectation[] = [];
  for (const tool of tapeTools(turn)) {
    for (const child of tool.children) {
      const pew = tapeCompletion(child);
      if (pew != null) out.push(pew);
    }
  }
  return out;
}

/**
 * Paint owner of the ask pin / tape cutoff. Cover chrome is still
 * `approvalHead`. A mutate Diff the human already answered stays the
 * pin until BODY writes a result — dropping it on `approved` remounts the
 * same Diff as a tape row (gap, or both for a frame).
 */
export function askPaintHead(turn: SessionTurn): ToolCallJob | null {
  const head = turn.approvalHead;
  if (head instanceof ToolCallJob) return head;
  for (const tool of tapeTools(turn)) {
    if (heldMutateDiff(tool)) return tool;
  }
  return null;
}

function heldMutateDiff(work: ToolCallJob): boolean {
  if (work.humanApprove === null) return false;
  if (work.completed || work.receiptJson != null) return false;
  return mutateArgsHaveDiff(work);
}

/**
 * Stateful cutoff at `askPaintHead`. Walk tape order: skip the head
 * (pin owns it) and every tool after it. A scheme after the cut is omitted
 * whole; a scheme that contains the head still paints the bag.
 */
export function createAskTapeCut(turn: SessionTurn): {
  skipTool(work: ToolCallJob): boolean;
  skipScheme(): boolean;
} {
  const head = askPaintHead(turn);
  let cut = false;
  return {
    skipTool(work: ToolCallJob): boolean {
      if (cut || work === head) {
        if (work === head) cut = true;
        return true;
      }
      return false;
    },
    skipScheme(): boolean {
      return cut;
    },
  };
}

export function schemeCellState(chunk: ProgrammaticJob): SchemeCellState {
  if (!chunk.completed && chunk.receiptJson == null) return "live";
  const snap = outcomeSnapOf(chunk);
  if (snap?.ok === false) return "fail";
  return "ok";
}

/**
 * Occupancy pin above the omnibox while glance is `running`.
 * Cover (`waiting-for-you`) owns the slot. Overlay / auth / off-tip hide it
 * at the Tea seat, not here.
 *
 * connecting — running, worker not seated, no tools, speech, or agents
 * waiting — seated empty completion, no tools or agents
 * responding — live speech body, no tools or agents
 * using-tools — live tools (incl. floor-hidden and judging) and/or live agents
 * retry is `retryUntilMs` (countdown), not this discriminant
 */
export type OccupancyKind = "connecting" | "waiting" | "responding" | "using-tools";

export type EmptyWaitChrome = {
  readonly kind: OccupancyKind;
  readonly label: string;
  readonly elapsed: boolean;
  readonly startedAt: number | null;
  readonly retryUntilMs: number | null;
};

export function emptyWaitChrome(turn: SessionTurn | null): EmptyWaitChrome | null {
  if (turn == null || turn.cutOff) {
    noteWait(`wait skip ${turn == null ? "no-turn" : "cutoff"}`);
    return null;
  }
  const glance = turnLiveness(turn);
  if (glance === "waiting-for-you" || glance !== "running") {
    noteWait(`wait skip ${glance} turn=${idOf(turn)}`);
    return null;
  }
  const activity = activityCensus(turn);
  const phrase = occupancyPhrase(activity);
  noteWait(`wait show turn=${idOf(turn)} kind=${phrase.kind} startedAt=${activity.startedAt ?? "none"}`);
  return {
    ...phrase,
    startedAt: activity.startedAt,
    retryUntilMs: activity.retryUntilMs,
  };
}

/** Reads only when the caller will show it — a turn outside a plexus has no uuid. */
function idOf(turn: SessionTurn): string {
  try {
    return turn.uuid;
  } catch {
    return "unmaterialized";
  }
}

/**
 * Compact column drops this leaf. Comm-first (agent) always.
 * Floor-allow only when `hideFloorTools`. Nested scheme inners never drop.
 */
export function compactOmitsTool(work: ToolCallJob, hideFloorTools: boolean, nested = false): boolean {
  if (nested || !work.tapeFuse) return false;
  if (work.commFirst) return true;
  return hideFloorTools;
}

type ActivityCensus = {
  readonly tools: boolean;
  readonly agentSpecs: readonly string[];
  readonly speech: boolean;
  readonly seated: boolean;
  readonly startedAt: number | null;
  readonly retryUntilMs: number | null;
};

function activityCensus(turn: SessionTurn): ActivityCensus {
  const askCut = createAskTapeCut(turn);
  const agentSpecs: string[] = [];
  let tools = false;
  let speech = false;
  let seated = false;
  let startedAt: number | null = null;
  let retryUntilMs: number | null = null;

  const notePew = (pew: CompletionExpectation): void => {
    const copy = completionLiveCopy(pew, false);
    if (copy.startedAt != null) startedAt = copy.startedAt;
    if (!copy.live) return;
    retryUntilMs = copy.retryUntilMs;
    if (copy.workerPresent) seated = true;
    if (copy.text.trim() !== "") speech = true;
  };

  const noteTool = (work: ToolCallJob): void => {
    if (work instanceof CallJob) {
      if (!work.completed) agentSpecs.push(agentSpecKey(work) || "agent");
      return;
    }
    if (work.tapeHidden || askCut.skipTool(work)) return;
    const state = toolCellState(work);
    if (state === "live" || state === "judging") tools = true;
  };

  for (const chunk of reactChunks(turn)) {
    const pew = tapeCompletion(chunk);
    if (pew != null) {
      notePew(pew);
      continue;
    }
    if (chunk instanceof ToolCallJob) {
      noteTool(chunk);
      continue;
    }
    if (chunk instanceof ProgrammaticJob) {
      if (askCut.skipScheme()) continue;
      if (schemeCellState(chunk) === "live") tools = true;
      for (const inner of chunk.toolCalls) noteTool(inner);
    }
  }
  for (const pew of leftoverJudgeCompletions(turn)) notePew(pew);
  return { tools, agentSpecs, speech, seated, startedAt, retryUntilMs };
}

export const CONNECTING = "connecting...";
export const USING_TOOLS = "using tools...";
export const RESPONDING = "responding...";

function occupancyPhrase(activity: ActivityCensus): {
  readonly kind: OccupancyKind;
  readonly label: string;
  readonly elapsed: boolean;
} {
  const retry = activity.retryUntilMs != null;
  if (activity.tools || activity.agentSpecs.length > 0) {
    const waiting = formatWaitingForAgents(activity.agentSpecs);
    const label =
      waiting === "" ? USING_TOOLS : activity.tools ? `${USING_TOOLS.slice(0, -3)} and ${waiting}` : waiting;
    return { kind: "using-tools", label, elapsed: retry };
  }
  if (activity.speech) return { kind: "responding", label: RESPONDING, elapsed: retry };
  if (activity.seated) return { kind: "waiting", label: "waiting for response...", elapsed: true };
  return { kind: "connecting", label: CONNECTING, elapsed: retry };
}

function completionLiveCopy(
  chunk: CompletionExpectation,
  cutOff: boolean,
): {
  readonly live: boolean;
  readonly text: string;
  readonly thought: string;
  readonly workerPresent: boolean;
  readonly startedAt: number | null;
  readonly retryUntilMs: number | null;
} {
  const live = chunk.outcome == null && !cutOff;
  const report = live && chunk.plexus != null ? chunk.report : null;
  const text = live ? (typeof report?.text === "string" ? report.text : "") || chunk.responseText : chunk.responseText;
  const thought = live
    ? (typeof report?.thought === "string" ? report.thought : "") || chunk.responseThought
    : chunk.responseThought;
  const startedAt =
    chunk.startedAtMs != null && Number.isFinite(chunk.startedAtMs)
      ? chunk.startedAtMs
      : live && typeof report?.startedAt === "number" && Number.isFinite(report.startedAt)
        ? report.startedAt
        : null;
  const retryUntilMs =
    live && typeof report?.retryUntilMs === "number" && Number.isFinite(report.retryUntilMs)
      ? report.retryUntilMs
      : null;
  return {
    live,
    text,
    thought,
    workerPresent: live ? chunk.workerPresent : false,
    startedAt,
    retryUntilMs,
  };
}

export function turnLiveness(turn: SessionTurn | null): TurnLiveness {
  if (turn == null) return "idle";
  if (turn.approvalHead != null && !hasPendingAutoResidual(turn)) return "waiting-for-you";
  if (turn.inLoop) return "running";
  return "idle";
}

function hasPendingAutoResidual(turn: SessionTurn): boolean {
  return tapeTools(turn).some(
    (work) => work.autoClassifierPending && work.classifierAbstain == null && !work.completed,
  );
}
