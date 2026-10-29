import { CompletionExpectation } from "@inhuman.tools/harness-model";
import { reportRole } from "@inhuman.tools/plexus-expectations";
import { SCREENSHOT_NOW_MS } from "@inhuman.tools/quickdraw/runtime";
import { runInAction } from "mobx";
import { test } from "vitest";

import { approveLaw } from "./approve.js";
import { PRIOR_PROMPT, openTea, wrapTurn } from "../__visual__/_helpers.js";

/** frames.test.ts `LIVE_THOUGHT` — one line, so it stays a single painted run. */
const LIVE_THOUGHT = "The 401 is the old hash, not the session cookie.";
/** frames.test.ts `THOUGHT_ONLY`. */
const THOUGHT_ONLY_LEAD = "The module-scope AUTH_SECRET is captured when AuthForm";
const THOUGHT_ONLY_TAIL = "loads. Request-time read would pick up the rotate.";

test("live thought clock", async () => {
  using ui = openTea();
  const completion = new CompletionExpectation({
    promptText: PRIOR_PROMPT,
    connectionId: "c",
  });
  // Present now is frozen. 3s before it resolves as `thinking · 3.0s` (tenths kept).
  completion.markStarted(SCREENSHOT_NOW_MS - 3_000);
  ui.client.sessionRoot.head = wrapTurn(completion);
  // wrapTurn stamps thought end, and that seals the header off the live clock.
  runInAction(() => {
    completion.thoughtEndedAtMs = null;
  });
  const hub = completion.awareness;
  if (hub == null) throw new Error("completion has no awareness");
  reportRole(hub, completion.uuid, { thought: LIVE_THOUGHT });
  await approveLaw("live-thought", ui.tea, {
    runs: [{ text: LIVE_THOUGHT }, { text: "thinking" }, { text: "thinking · 3.0s" }],
  });
});

test("sealed thought duration", async () => {
  using ui = openTea();
  const completion = new CompletionExpectation({
    promptText: PRIOR_PROMPT,
    connectionId: "c",
  });
  completion.responseText = "";
  completion.responseThought = `${THOUGHT_ONLY_LEAD}\n${THOUGHT_ONLY_TAIL}`;
  completion.outcome = "successful";
  completion.markStarted(SCREENSHOT_NOW_MS - 3_000);
  ui.client.sessionRoot.head = wrapTurn(completion);
  await approveLaw("sealed-thought", ui.tea, {
    runs: [{ text: THOUGHT_ONLY_LEAD }, { text: THOUGHT_ONLY_TAIL }, { text: "thought for 3s" }],
  });
});

test("wait pin clock", async () => {
  using ui = openTea();
  const completion = new CompletionExpectation({
    promptText: PRIOR_PROMPT,
    connectionId: "c",
  });
  // 3.4s before the frozen present: `waiting for response... · 3.4s`.
  completion.markStarted(SCREENSHOT_NOW_MS - 3_400);
  ui.client.sessionRoot.head = wrapTurn(completion);
  const hub = completion.awareness;
  if (hub == null) throw new Error("completion has no awareness");
  // Occupied lane, no speech frame. occupancyPhrase then keeps elapsed on.
  reportRole(hub, completion.uuid, "");
  await approveLaw("wait-pin", ui.tea, {
    runs: [{ text: "waiting for response..." }, { text: "waiting for response... · 3.4s" }],
  });
});
