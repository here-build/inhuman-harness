import { CompletionJob, SessionSystemPrompt, CompactJob } from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import { PRIOR_PROMPT, localClient, openTea, seatTurn, sealedCompletion } from "./_helpers.js";

test("collapsed compact sits on the tape between rounds", () => {
  const client = localClient();
  client.sessionRoot.head = seatTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: PRIOR_PROMPT,
    doneWork: [
      new CompletionJob({
        expectation: sealedCompletion({ text: "AuthForm reads AUTH_SECRET at import time.", thought: null }),
      }),
      new CompactJob({ completed: true, reason: "overflow", standIn: "summary" }),
      new CompletionJob({
        expectation: sealedCompletion({ text: "Request-time lookup lives in src/secret.ts.", thought: null }),
      }),
    ],
    queue: [],
    reducerExited: true,
  });
  using ui = openTea(client);
  expect(ui).toMatchScreenshot("tape-compact-notice");
});
