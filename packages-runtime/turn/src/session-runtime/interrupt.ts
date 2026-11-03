import {
  CallJob,
  CompactJob,
  CompletionJob,
  ProgrammaticJob,
  ToolCallJob,
  type SessionRoot,
} from "@inhuman.tools/harness-model/session";
import { WorkExpectation, walkWork } from "@inhuman.tools/plexus-expectations";
import { runInAction } from "mobx";

export function interruptSession(root: SessionRoot, message: string): void {
  runInAction(() => {
    for (const turn of root.liveTurns) {
      if (turn.reducerExited) continue;
      for (const node of walkWork(turn)) {
        if (node instanceof CallJob) continue;
        if (node instanceof WorkExpectation && !node.isDone) node.fail("cancel", message, "null");
        if ((node instanceof ToolCallJob || node instanceof ProgrammaticJob) && !node.completed) {
          node.outcomeSnap ??= { ok: false, text: message };
          node.markComplete();
        } else if (node instanceof CompactJob && !node.completed) {
          node.failed = true;
          node.notice = message;
          node.markComplete();
        } else if (node instanceof CompletionJob && !node.completed) node.markComplete();
      }
      turn.cancelRequested = true;
      turn.broke = message;
      turn.reducerExited = true;
      turn.markComplete();
    }
  });
}
