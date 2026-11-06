import { applyAckAnswer, applyAskAnswer, type AckAnswer, type AskAnswer } from "@inhuman.tools/harness/testkit";
import { parseGrantRows, type GrantRow } from "@inhuman.tools/harness-model";
import type { Client } from "@inhuman.tools/harness-sdk";

let ids = 0;

/**
 * Stand in for the session daemon's `ask/answer`: the TUI only names the ask,
 * so a test without a daemon applies the answer the way the daemon would.
 * Project, bot and global grants land in the kernel root's `grantsJson`, as the kernel file would.
 */
export function answerLikeDaemon(client: Client, method: string, params: unknown): void {
  if (method !== "ask/answer" && method !== "ack/answer") return;
  const answer = params as (AskAnswer | AckAnswer) & { readonly sessionId: string; readonly jobId: string };
  const target = [client.sessionRoot, client.askPlexus?.root].find((root) => root?.sessionId === answer.sessionId);
  const leaf = target?.findRunningTurn()?.approvalHead;
  if (leaf == null || leaf.uuid !== answer.jobId || leaf.humanApprove !== null) return;
  const env = {
    now: () => 1_000_000,
    newId: () => `g-test-${(ids += 1)}`,
    persist: (row: GrantRow) => {
      client.kernelRoot.grantsJson = JSON.stringify([...parseGrantRows(client.kernelRoot.grantsJson), row]);
    },
  };
  if (method === "ack/answer") applyAckAnswer(client.sessionRoot, leaf, answer as AckAnswer, env);
  else applyAskAnswer(client.sessionRoot, leaf, answer as AskAnswer, env);
}
