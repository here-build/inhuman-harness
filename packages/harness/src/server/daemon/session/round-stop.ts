/** Provider facts and admission limits. Continuation policy lives in round-boundary. */
import type { SessionTurn } from "@inhuman.tools/harness-model";

export const CONTENT_FILTER_STOP = "content_filter";
export const LENGTH_STOP = "length";

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
