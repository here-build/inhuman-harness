/**
 * Continuation spine. `.turnTail` is "I continue X", not parent.
 * Parent is ownership (honor / intern / remainder). Follow `.turnTail` until
 * SessionTurn; a tool stops the walk so remainder stays off-spine.
 */
import { CompletionJob } from "./CompletionJob.js";
import { SessionTurn } from "../turn/session-turn.js";

export function tapeTurn(job: CompletionJob): SessionTurn | null {
  return continuationTurn(job.turnTail);
}

function continuationTurn(start: unknown): SessionTurn | null {
  const seen = new Set<object>();
  let cell: unknown = start;
  while (cell != null && typeof cell === "object" && !seen.has(cell)) {
    seen.add(cell);
    if (cell instanceof SessionTurn) return cell;
    if (cell instanceof CompletionJob) {
      cell = cell.turnTail;
      continue;
    }
    return null;
  }
  return null;
}
