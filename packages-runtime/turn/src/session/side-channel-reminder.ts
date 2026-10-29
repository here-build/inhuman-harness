/**
 * Nags for side-channel tools the model skips.
 *
 * Title (`update_metadata`) and context_need keep separate clocks. A call
 * of one does not reset the other. Each nag is attached to the completion
 * being armed, as `systemNote`. The TUI paints tape cells and does not
 * paint that field, so the nag stays off the
 * transcript. A user message or a tape cell would show it.
 *
 * Only a sealed successful session completion on the visible tape counts.
 * The count starts after the latest cutoff, same as `spine()`:
 * rounds behind the summary are off the wire, and a call buried there
 * must not keep the nag dark. An uncommitted compact is not a boundary.
 * Representation cells and the isolated summarizer child are not rounds.
 * A failure, an isolated intern, and the round still being armed are not
 * rounds the model spent skipping the tool. A scheme inner call counts:
 * display already reads that job.
 *
 * `offered === null` means the wire is still the live catalog, which lists
 * both tools. A frozen tool set is the wire list — omit a nag whose tool
 * is absent from it.
 *
 * Due on the armed round when (quiet + 1) is a multiple of the period.
 * `quiet % period` fires one round late.
 */
import { prompt, type SystemPrompt } from "@inhuman.tools/harness-commons";
import {
  CompactJob,
  CONTEXT_NEED_TOOL_NAME,
  ProgrammaticJob,
  SessionTurn,
  tapeCompletion,
  ToolCallJob,
  UPDATE_METADATA_TOOL_NAME,
  type SessionUnit,
  type TurnChunk,
} from "@inhuman.tools/harness-model";

/** Quiet sealed session rounds before the armed round carries the nag. */
export const SIDE_CHANNEL_REMINDER_EVERY = 5;

export const TITLE_UPDATE_REMINDER = prompt.system`Call update_metadata in this completion, last among your other tool calls — not as its own round. Record this turn's title and a short description. This is bookkeeping: do not mention this note or the call in your reply, and do not address the user.`;

export const CONTEXT_NEED_REMINDER = prompt.system`Call context_need in this completion, last among your other tool calls — not as its own round. Put what to keep in the call's arguments only. This is bookkeeping: do not mention this note or the call in your reply, do not describe what you will keep, and do not address the user. Do not wait for a result.`;

export type SideChannelRound = {
  readonly calls: readonly string[];
};

export function quietRoundsSince(rounds: readonly SideChannelRound[], tool: string): number {
  let quiet = 0;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index];
    if (round.calls.includes(tool)) return quiet;
    quiet += 1;
  }
  return quiet;
}

export function sideChannelReminderDue(quietRounds: number, every: number = SIDE_CHANNEL_REMINDER_EVERY): boolean {
  if (!Number.isInteger(every) || every < 1) return false;
  if (!Number.isInteger(quietRounds) || quietRounds < 0) return false;
  return (quietRounds + 1) % every === 0;
}

export function joinSystemNotes(notes: readonly SystemPrompt[]): SystemPrompt {
  const text = notes
    .map((note) => note.trim())
    .filter((note) => note !== "")
    .join("\n\n");
  return prompt.system`${text}`;
}

export function sideChannelReminderNote(
  rounds: readonly SideChannelRound[],
  every: number = SIDE_CHANNEL_REMINDER_EVERY,
  offered: readonly string[] | null = null,
): SystemPrompt {
  const allow = offered == null ? null : new Set(offered);
  return joinSystemNotes([
    allow?.has(UPDATE_METADATA_TOOL_NAME) !== false &&
    sideChannelReminderDue(quietRoundsSince(rounds, UPDATE_METADATA_TOOL_NAME), every)
      ? TITLE_UPDATE_REMINDER
      : prompt.system``,
    allow?.has(CONTEXT_NEED_TOOL_NAME) !== false &&
    sideChannelReminderDue(quietRoundsSince(rounds, CONTEXT_NEED_TOOL_NAME), every)
      ? CONTEXT_NEED_REMINDER
      : prompt.system``,
  ]);
}

/** Oldest first. The armed completion is not sealed yet, so it is absent. */
export function sealedActorRounds(turn: SessionTurn): readonly SideChannelRound[] {
  const newestFirst: SessionTurn[] = [];
  const seen = new Set<SessionTurn>();
  let cell: SessionUnit | null = turn;
  while (cell instanceof SessionTurn && !seen.has(cell)) {
    seen.add(cell);
    newestFirst.push(cell);
    cell = cell.turnTail;
  }
  const oldestFirst = newestFirst.toReversed();
  const cutoff = latestCutoff(oldestFirst);
  const rounds: SideChannelRound[] = [];
  const start = cutoff == null ? 0 : Math.max(0, oldestFirst.indexOf(cutoff.turn));
  for (const head of oldestFirst.slice(start)) {
    let chunks: readonly TurnChunk[] = head.doneWork;
    if (cutoff?.turn === head) {
      const at = chunks.indexOf(cutoff.compact);
      if (at !== -1) chunks = chunks.slice(at + 1);
    }
    let round: { calls: string[] } | null = null;
    for (const chunk of chunks) {
      const pew = tapeCompletion(chunk);
      if (pew != null) {
        if (pew.completionMode === "isolated" || pew.outcome !== "successful") {
          round = null;
          continue;
        }
        round = { calls: [] };
        for (const call of pew.responseCalls) noteMetaCall(round, call.name);
        rounds.push(round);
        continue;
      }
      if (round == null) continue;
      if (chunk instanceof ToolCallJob) noteMetaCall(round, chunk.name);
      if (chunk instanceof ProgrammaticJob) {
        for (const inner of chunk.toolCalls) noteMetaCall(round, inner.name);
      }
    }
  }
  return rounds;
}

function noteMetaCall(round: { calls: string[] }, name: string): void {
  if (name !== UPDATE_METADATA_TOOL_NAME && name !== CONTEXT_NEED_TOOL_NAME) return;
  if (round.calls.includes(name)) return;
  round.calls.push(name);
}

function latestCutoff(turns: readonly SessionTurn[]): { turn: SessionTurn; compact: CompactJob } | null {
  for (const head of turns.toReversed()) {
    for (const chunk of head.doneWork.toReversed()) {
      if (chunk instanceof CompactJob && chunk.cutoff) return { turn: head, compact: chunk };
    }
  }
  return null;
}
