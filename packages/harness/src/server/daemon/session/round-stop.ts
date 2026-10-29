/**
 * What the provider's stop reason means for the loop. Pure over the tape: the reason
 * is a fact on the completion, and the router reads it the way it reads any other
 * enrichment.
 */
import {
  jobTriggersReactLoop,
  ProgrammaticJob,
  tapeCompletion,
  ToolCallJob,
  type CompletionExpectation,
  type SessionTurn,
} from "@inhuman.tools/harness-model";
import { splitThink } from "@inhuman.tools/tool-call-normalize";

export const CONTENT_FILTER_STOP = "content_filter";
export const LENGTH_STOP = "length";

export type RoundStop = { readonly kind: "continue" } | { readonly kind: "stop"; readonly message: string };

/** Consecutive actor rounds, newest last, that ended on the output limit with no work tool between them. */
export function lengthStreak(turn: SessionTurn): number {
  let count = 0;
  for (let index = turn.doneWork.length - 1; index >= 0; index -= 1) {
    const cell = turn.doneWork[index];
    const pew = tapeCompletion(cell);
    if (pew != null) {
      if (pew.completionMode === "isolated") continue;
      if (pew.finishReason !== LENGTH_STOP) break;
      count += 1;
      continue;
    }
    if (cell instanceof ToolCallJob && jobTriggersReactLoop(cell)) break;
    if (cell instanceof ProgrammaticJob) break;
  }
  return count;
}

/**
 * `null` leaves the round to the ordinary rules. Only a round with no work tool is judged:
 * a `length` stop that still produced whole calls is a round like any other.
 */
export function roundStop(turn: SessionTurn, pew: CompletionExpectation, workTools: number): RoundStop | null {
  if (pew.finishReason === CONTENT_FILTER_STOP) {
    return {
      kind: "stop",
      message:
        "The provider's content filter stopped this response, so it is blocked or incomplete. This is not an empty answer. Rephrase the request, or send another message to try again.",
    };
  }
  if (pew.finishReason !== LENGTH_STOP || workTools > 0) return null;
  const answered = splitThink(pew.responseText).content.trim() !== "";
  if (!answered) {
    return {
      kind: "stop",
      message:
        "The model used up its output budget while reasoning and gave no answer. It was not nudged again. Raise the output limit or the reasoning budget, or ask again more narrowly.",
    };
  }
  const allowed = turn.lengthContinuations ?? 0;
  const streak = lengthStreak(turn);
  if (streak <= allowed) return { kind: "continue" };
  return {
    kind: "stop",
    message: `The answer hit the output limit ${streak} times in a row${allowed === 0 ? "" : ` (limit ${allowed} continuations)`} and was cut off. Send another message to continue it.`,
  };
}

/** The receipt for a call that was not run. */
export function refusalText(dropReason: string, filtered: boolean): string {
  if (dropReason === "truncated") {
    return "Your tool call was truncated (the response hit its output limit mid-call), so it was not run. Re-issue it.";
  }
  if (dropReason !== "") {
    return "Your tool call's arguments could not be parsed, so it was not run. Re-issue it with valid arguments.";
  }
  return filtered ? "Not run: the provider's content filter stopped this response." : "Not run.";
}

export function maxRoundsMessage(limit: number): string {
  return `Stopped after ${limit} model rounds: the round limit for this turn (maxRounds) is reached. Send another message to continue.`;
}

export function roundCapReached(turn: SessionTurn): boolean {
  return turn.maxRounds != null && turn.maxRounds > 0 && turn.rounds >= turn.maxRounds;
}
