/**
 * Compact calculations. The Scheme program that writes the card is session-runtime.
 *
 * Occupancy that fires compact is config.json compactTriggers (hard / soft).
 * Empty eat and compact-on-compact REJECT before a strategy runs.
 * Keep-all (empty prefix, nonempty keep) skips auto compact, including hard overflow.
 */
import {
  CompactJob,
  CompletionExpectation,
  jobTriggersReactLoop,
  reactChunks,
  ProgrammaticJob,
  SessionTurn,
  ToolCallJob,
  TurnApprovalNoteChunk,
  TurnNotificationChunk,
  TurnSteerChunk,
  type CompletionMessage,
  type ContextNeed,
  type SessionUnit,
} from "@inhuman.tools/harness-model";

import { Transcript, walkTranscript } from "./transcript.js";

export function compactDue(head: SessionUnit | null, ratio: number | null): boolean {
  if (head == null || ratio == null || !(ratio > 0)) return false;
  if (!(head instanceof SessionTurn)) return false;
  const used = head.contextUsed;
  const limit = head.contextLimit;
  if (!(used > 0 && limit > 0)) return false;
  return used / limit >= ratio;
}

/** Unknown occupancy is not a deficit. */
export function needDeficit(turn: SessionTurn, need: ContextNeed | null): boolean {
  if (need?.min_remaining_tokens == null) return false;
  const used = turn.contextUsed;
  const limit = turn.contextLimit;
  if (!(used > 0 && limit > 0)) return false;
  const want = Math.min(Math.max(0, need.min_remaining_tokens), limit);
  return limit - used < want;
}

/**
 * Keep floors + requested runway cannot exceed the window.
 * Card budget is not estimated — keep occupancy is the host retain.
 */
export function needFeasible(turn: SessionTurn, need: ContextNeed | null, keepTokens: number): boolean {
  if (need?.min_remaining_tokens == null) return true;
  const limit = turn.contextLimit;
  if (!(limit > 0)) return false;
  const runway = Math.min(Math.max(0, need.min_remaining_tokens), limit);
  return keepTokens + runway <= limit;
}

/**
 * Forced tail splice. Slash is `#mintCompactTurn`, not this.
 * Keep-all (empty prefix, nonempty keep) vetoes hard overflow.
 * Does not read `contextNeed` — a need is an ambient option, not a tail node.
 * Null = do not enqueue `CompactJob`.
 */
export function tailCompactCandidate(
  turn: SessionTurn,
  hardRatio: number | null,
  sliced?: { readonly prefix: Transcript; readonly keep: Transcript },
): "overflow" | null {
  if (sliced != null && sliced.prefix.cells.length === 0 && sliced.keep.cells.length > 0) return null;
  if (!compactDue(turn, hardRatio)) return null;
  return "overflow";
}

/**
 * Ambient option, not a cutoff. A live need with a real prefix is worth a
 * background completion when the runway is short, the need names a preserve
 * cutoff, or the phase is settled. Hard overflow is `tailCompactCandidate`.
 * Null = do not spend a summarizer. Infeasible retain does not block the option.
 */
export function compactDecision(
  turn: SessionTurn,
  sliced?: { readonly prefix: Transcript; readonly keep: Transcript },
): { readonly focus: string } | null {
  if (sliced == null || sliced.prefix.cells.length === 0) return null;
  const need = turn.contextNeed;
  if (need == null) return null;
  if (compactRejectReason(turn) != null) return null;
  const named = needDeficit(turn, need) || need.preserve != null || need.current_phase_settled === true;
  if (!named) return null;
  return { focus: need.focus ?? "" };
}

export type CompactReject = "empty" | "already-compacted";

export function compactRejectReason(unit: SessionUnit | null, current?: CompactJob): CompactReject | null {
  if (unit == null) return "empty";
  const seen = new Set<SessionUnit>();
  for (
    let cell: SessionUnit | null = unit;
    cell != null && !seen.has(cell);
    cell = cell instanceof SessionTurn ? cell.turnTail : null
  ) {
    seen.add(cell);
    if (!(cell instanceof SessionTurn)) continue;
    const own = eatSinceCutoff(reactChunks(cell).filter((chunk) => chunk !== current));
    if (Array.isArray(own)) return null;
    if (own === "already-compacted") return "already-compacted";
  }
  return "empty";
}

function eatSinceCutoff(chunks: readonly unknown[]): CompletionMessage[] | CompactReject {
  let sawCutoff = false;
  let last: CompletionExpectation | null = null;
  const tools: Array<ToolCallJob | ProgrammaticJob> = [];
  const notifies: TurnNotificationChunk[] = [];
  const notes: TurnApprovalNoteChunk[] = [];
  const steers: TurnSteerChunk[] = [];
  for (const event of walkTranscript(chunks)) {
    switch (event.kind) {
      case "compact": {
        sawCutoff = true;
        last = null;
        tools.length = 0;
        notifies.length = 0;
        notes.length = 0;
        steers.length = 0;

        break;
      }
      case "completion": {
        last = event.chunk;
        tools.length = 0;
        notifies.length = 0;
        notes.length = 0;
        steers.length = 0;

        break;
      }
      case "tool": {
        if (jobTriggersReactLoop(event.chunk)) tools.push(event.chunk);

        break;
      }
      case "scheme": {
        tools.push(event.chunk);

        break;
      }
      case "notify": {
        notifies.push(event.chunk);

        break;
      }
      case "approval-note": {
        notes.push(event.chunk);

        break;
      }
      case "steer": {
        steers.push(event.chunk);

        break;
      }
      case "cell": {
        break;
      }
      default: {
        const _kind: never = event;
        void _kind;
      }
    }
  }
  if (last != null) return [...last.messages, last, ...tools, ...notifies, ...notes, ...steers];
  if (notifies.length > 0 || notes.length > 0 || steers.length > 0) return [...notifies, ...notes, ...steers];
  return sawCutoff ? "already-compacted" : "empty";
}
