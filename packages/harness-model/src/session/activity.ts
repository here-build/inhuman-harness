import type { CompletionExpectation } from "./expectations/CompletionExpectation.js";
import { CallJob } from "./jobs/CallJob.js";
import { CompactJob } from "./jobs/CompactJob.js";
import { CompletionJob } from "./jobs/CompletionJob.js";
import { ProgrammaticJob } from "./jobs/ProgrammaticJob.js";
import { ToolCallJob } from "./jobs/ToolCallJob.js";
import type { SessionRoot } from "./SessionRoot.js";
import { SessionTurn } from "./turn/session-turn.js";

export type SessionActivity =
  | { readonly kind: "idle" | "stopping" | "approval" | "tools" | "agents" | "compacting" | "working" }
  | { readonly kind: "stopped"; readonly detail: string }
  | {
      readonly kind: "waiting" | "thinking" | "responding" | "retrying" | "checking";
      readonly completion: CompletionExpectation;
    };

/** Live activity is a projection of work and provider progress, never a second loop state. */
export function sessionActivity(root: SessionRoot): SessionActivity {
  const turn =
    root.liveChain.findLast((candidate) => !candidate.reducerExited && !candidate.completed) ??
    [...root.liveTurns].find((candidate) => candidate.openBackgroundWork.length > 0);
  if (turn == null) {
    return root.head instanceof SessionTurn && root.head.broke !== ""
      ? { kind: "stopped", detail: root.head.broke }
      : { kind: "idle" };
  }
  if (turn.cancelRequested) return { kind: "stopping" };
  const work = turn.subtreeWork;
  const primary = [...turn.doneWork, ...turn.queue].findLast(
    (node) => node instanceof CompletionJob && !node.completed && !node.expectation.isDone,
  );
  if (primary == null && work.some((node) => node instanceof CompactJob && !node.completed))
    return { kind: "compacting" };
  const completion =
    primary ??
    work.findLast(
      (node) => node instanceof CompletionJob && !node.completed && !node.background && !node.expectation.isDone,
    );
  if (completion instanceof CompletionJob) {
    const expectation = completion.expectation;
    if (expectation.retryUntilMs != null) return { kind: "retrying", completion: expectation };
    return {
      kind: expectation.completionMode === "isolated" ? "checking" : expectation.phase,
      completion: expectation,
    };
  }
  if (turn.approvalHead != null) return { kind: "approval" };
  if (work.some((node) => node instanceof CallJob && !node.completed && !node.cancelled)) return { kind: "agents" };
  if (work.some((node) => (node instanceof ToolCallJob || node instanceof ProgrammaticJob) && !node.completed))
    return { kind: "tools" };
  return { kind: "working" };
}
