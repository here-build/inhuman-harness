import { CompletionJob, SessionSystemPrompt, CompactJob } from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import { PRIOR_PROMPT, dumpTexts, localClient, openTea, seatTurn, sealedCompletion } from "./_helpers.js";

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
  const texts = dumpTexts(ui.dump().transcript);
  expect({
    compacted: texts.includes("compacted"),
    first: texts.includes("AuthForm reads AUTH"),
    next: texts.includes("Request-time lookup"),
  }).toEqual({ compacted: true, first: true, next: true });
  expect(ui).toMatchScreenshot("tape-compact-notice");
});
