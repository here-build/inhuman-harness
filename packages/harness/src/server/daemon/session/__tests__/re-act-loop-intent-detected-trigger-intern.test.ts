import * as core from "@inhuman.tools/continuation";
import { CompletionJob, SessionTurn } from "@inhuman.tools/harness-model";
import {
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_RESPONSE_SCHEMA,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_RESPONSE_SCHEMA_JSON,
} from "@inhuman.tools/harness-model/shared";
import { ConnectionMiss } from "@inhuman.tools/plexus-expectations/driver";
import { expect, test, vi } from "vitest";

import {
  LENGTH_CONTINUE_NOTE,
  questionLineFromSpeech,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE,
  THOUGHT_CONTINUE_NOTE,
  runTextOnlyContinueIntern,
  type ReActLoopIntentDetectedTriggerComplete,
} from "../re-act-loop-intent-detected-trigger.js";

function options(complete: ReActLoopIntentDetectedTriggerComplete) {
  return {
    speech: "I will write tests now.",
    wire: { connection: "judge", model: "fast", key: "judge\nfast" },
    haltKeys: new Set<string>(),
    home: new SessionTurn(),
    complete,
    signal: new AbortController().signal,
  };
}

test("judge sees spoken text only, isolated from reasoning and the actor tape", async () => {
  const complete = vi.fn<ReActLoopIntentDetectedTriggerComplete>(async (req) => {
    const text = JSON.stringify({ intent: true, awaiting_user: false });
    req.round.succeed("settled", "", "null", { result: { text } });
    return { text };
  });
  const opts = options(complete);
  opts.speech = `<think>${"Should I ask the user? ".repeat(250)}</think>I will write tests now.`;
  expect(await runTextOnlyContinueIntern(opts)).toBe("continue");
  const req = complete.mock.calls[0]![0];
  expect(req.round.completionMode).toBe("isolated");
  expect(req.round.responseSchema).toEqual(RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_RESPONSE_SCHEMA);
  expect(req.responseSchemaJson).toBe(RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_RESPONSE_SCHEMA_JSON);
  expect(req.round.promptMessages.map(({ role, content }) => ({ role, content }))).toEqual([
    { role: "system", content: expect.any(String) },
    { role: "user", content: "I will write tests now." },
  ]);
  expect(req.promptText).toBe("I will write tests now.");
  expect(opts.home.doneWork).toEqual([]);
  expect(opts.home.children).toHaveLength(1);
  expect(opts.home.children[0]!.completed).toBe(true);
  expect(questionLineFromSpeech("<think>I should proceed.</think>Which tests should I run?")).toBe(
    "Which tests should I run?",
  );
});

test.each([
  ["missing connection", new ConnectionMiss("noconnect", "missing judge")],
  ["needs auth", new ConnectionMiss("needs-auth", "judge needs auth")],
  ["crash", new Error("intern boom")],
] as const)("%s seals and settles the judge without disabling future attempts", async (_label, error) => {
  const complete = vi.fn<ReActLoopIntentDetectedTriggerComplete>(async () => {
    throw error;
  });
  const opts = options(complete);
  expect(await runTextOnlyContinueIntern(opts)).toBe("seal");
  const job = opts.home.children[0] as CompletionJob;
  expect(job.completed).toBe(true);
  expect(job.expectation.outcome).toBe("failed");
  expect(job.expectation.failReason).toBe(error.message);
  expect(opts.haltKeys.size).toBe(0);
  expect(await runTextOnlyContinueIntern(opts)).toBe("seal");
  expect(complete).toHaveBeenCalledTimes(2);
});

test.each([false, true])("unsupported schema disables only this judge wire (throws=%s)", async (throws) => {
  const complete = vi.fn<ReActLoopIntentDetectedTriggerComplete>(async (req) => {
    const message = "json_schema unsupported: test judge";
    if (throws) throw new Error(message);
    req.round.failReason = message;
    req.round.fail("crash", message, "null");
    return { text: "" };
  });
  const opts = options(complete);
  expect(await runTextOnlyContinueIntern(opts)).toBe("seal");
  expect(opts.haltKeys).toEqual(new Set([opts.wire.key]));
  expect(await runTextOnlyContinueIntern(opts)).toBe("seal");
  expect(complete).toHaveBeenCalledTimes(1);
  expect(
    await runTextOnlyContinueIntern({ ...opts, wire: { ...opts.wire, model: "other", key: "judge\nother" } }),
  ).toBe("seal");
  expect(complete).toHaveBeenCalledTimes(2);
});

test.each(["not json", '{"intent":true}', '{"intent":true,"awaiting_user":"false"}'])(
  "malformed vote seals: %s",
  async (text) => {
    expect(
      await runTextOnlyContinueIntern(
        options(async (req) => {
          req.round.succeed("settled", "", "null", { result: { text } });
          return { text };
        }),
      ),
    ).toBe("seal");
  },
);

test("cancellation reaches the judge and seals its completion", async () => {
  const abort = new AbortController();
  const opts = options(async (req) => {
    abort.abort(new Error("turn cancelled"));
    req.signal!.throwIfAborted();
    return { text: "" };
  });
  opts.signal = abort.signal;
  expect(await runTextOnlyContinueIntern(opts)).toBe("seal");
  expect((opts.home.children[0] as CompletionJob).expectation.isDone).toBe(true);
});

test("a judge timeout seals and settles without disabling future attempts", async () => {
  const opts = options(async (req) => {
    await new Promise<void>((_resolve, reject) => {
      req.signal!.addEventListener("abort", () => reject(req.signal!.reason), { once: true });
    });
    return { text: "" };
  });
  expect(await runTextOnlyContinueIntern(opts)).toBe("seal");
  const job = opts.home.children[0] as CompletionJob;
  expect(job.completed).toBe(true);
  expect(job.expectation.outcome).toBe("failed");
  expect(opts.haltKeys.size).toBe(0);
}, 45_000);

test("the harness notes are the core strings, byte for byte", () => {
  expect({
    reAct: RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE,
    thought: THOUGHT_CONTINUE_NOTE,
    length: LENGTH_CONTINUE_NOTE,
  }).toEqual({
    reAct: core.RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE,
    thought: core.THOUGHT_CONTINUE_NOTE,
    length: core.LENGTH_CONTINUE_NOTE,
  });
});
