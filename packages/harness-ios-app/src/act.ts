import { answerParams, isAccepted } from "./directory.js";
import type { Dial } from "../../harness-web-app/src/client/dial.js";

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Allow or deny the session's sitting ask, without pushing its screen. */
export async function decide(dial: Dial, sessionId: string, path: string, allow: boolean): Promise<string> {
  try {
    await dial.borrowSession(sessionId, path, async (rpc, plexus) => {
      const head = plexus.root.findRunningTurn()?.approvalHead;
      if (head == null || head.humanApprove != null) throw new Error("That decision is no longer waiting.");
      const result = await rpc.request(
        "ask/answer",
        answerParams({ sessionId: plexus.root.sessionId, jobId: head.uuid, allow }),
      );
      if (!isAccepted(result)) throw new Error("Decision was not accepted.");
    });
    return "";
  } catch (error) {
    return message(error, "Could not send the decision.");
  }
}

/** Run the session's retry. The problem stays written here either way. */
export async function retrySession(dial: Dial, sessionId: string, path: string): Promise<string> {
  try {
    await dial.borrowSession(sessionId, path, async (rpc) => {
      const result = await rpc.request("turn/retry", {});
      if (!isAccepted(result)) throw new Error("Retry was not accepted.");
    });
    return "";
  } catch (error) {
    return message(error, "Could not retry.");
  }
}
