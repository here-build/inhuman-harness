import {
  LENGTH_CONTINUE_NOTE,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE,
  THOUGHT_CONTINUE_NOTE,
} from "@inhuman.tools/continuation";
import { describe, expect, it } from "vitest";

import {
  INTENT_TYPE,
  LENGTH_TYPE,
  type PiCtx,
  type PiHost,
  type PiMessage,
  readSettings,
  register,
  type SettleEvent,
  type SettleResult,
  THOUGHT_TYPE,
} from "../index.js";

type Reply = { text: string; stopReason?: string } | Error;

function fake(options: { settings?: string; replies?: Reply[]; timeoutMs?: number } = {}) {
  const calls: { model: unknown; systemPrompt?: string; user: string; signal?: AbortSignal }[] = [];
  const replies = [...(options.replies ?? [])];
  const notes: string[] = [];
  const found: [string, string][] = [];
  const ctx: PiCtx = {
    hasUI: true,
    model: "current",
    ui: { notify: (message) => notes.push(message) },
    modelRegistry: {
      find(provider, id) {
        found.push([provider, id]);
        return provider === "cheap" ? { picked: id } : undefined;
      },
      async complete(model, context, opts) {
        calls.push({
          model,
          systemPrompt: context.systemPrompt,
          user: context.messages[0]!.content,
          signal: opts?.signal,
        });
        const reply = replies.shift();
        if (reply === undefined) throw new Error("no scripted reply");
        if (reply instanceof Error) throw reply;
        return { content: [{ type: "text", text: reply.text }], stopReason: reply.stopReason ?? "stop" };
      },
    },
  };
  let handler: ((event: SettleEvent, ctx: PiCtx) => Promise<SettleResult> | SettleResult) | undefined;
  const pi = {
    on(_event: string, h: typeof handler) {
      handler = h;
    },
  } as unknown as PiHost;
  register(pi, { agentDir: "/x", readFile: () => options.settings, timeoutMs: options.timeoutMs });
  return {
    ctx,
    calls,
    notes,
    found,
    registered: handler !== undefined,
    settle: (messages: PiMessage[], extra: Partial<SettleEvent> = {}) =>
      handler!(
        {
          type: "agent_before_settle",
          entries: [],
          continue: false,
          outcome: "completed",
          context: { contextMessages: messages },
          ...extra,
        },
        ctx,
      ),
  };
}

const user = (text = "do it"): PiMessage => ({ role: "user", content: [{ type: "text", text }] });
const say = (text: string, stopReason = "stop"): PiMessage => ({
  role: "assistant",
  stopReason,
  content: [{ type: "text", text }],
});
const think = (text = ""): PiMessage => ({
  role: "assistant",
  stopReason: "stop",
  content: [{ type: "thinking", thinking: "hmm" }, ...(text === "" ? [] : [{ type: "text", text }])],
});
const tool = (text = ""): PiMessage => ({
  role: "assistant",
  stopReason: "toolUse",
  content: [
    ...(text === "" ? [] : [{ type: "text", text }]),
    { type: "toolCall", id: "1", name: "bash", arguments: {} },
  ],
});
const result: PiMessage = { role: "toolResult", content: [{ type: "text", text: "ok" }] };
const nudge = (customType: string): PiMessage => ({ role: "custom", customType, content: "n" });
const INTENT = JSON.stringify({ intent: true, awaiting_user: false });

describe("continuation-pi", () => {
  it("does nothing when the last message has tool calls", async () => {
    const h = fake();
    expect(await h.settle([user(), tool("I will run it")])).toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });

  it("output limit continues with the length note, hidden", async () => {
    const h = fake();
    const out = await h.settle([user(), say("half of an ans", "length")]);
    expect(out).toEqual({
      entries: [{ type: "custom_message", customType: LENGTH_TYPE, content: LENGTH_CONTINUE_NOTE, display: false }],
      continue: true,
    });
    expect(h.calls).toHaveLength(0);
  });

  it("output limit stops after its cap", async () => {
    const h = fake();
    const cut = (): PiMessage[] => [say("a", "length"), nudge(LENGTH_TYPE)];
    const messages = [user(), ...cut(), ...cut(), ...cut(), say("d", "length")];
    expect(await h.settle(messages)).toBeUndefined();
  });

  it("thinking with no spoken text continues with the thought note", async () => {
    const h = fake();
    const out = await h.settle([user(), think()]);
    expect(out?.entries[0]).toMatchObject({ customType: THOUGHT_TYPE, content: THOUGHT_CONTINUE_NOTE });
    expect(out?.continue).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  it("thought-only rounds stop after the runaway cap", async () => {
    const h = fake();
    const rounds = Array.from({ length: 8 }, () => [think(), nudge(THOUGHT_TYPE)]).flat();
    expect(await h.settle([user(), ...rounds, think()])).toBeUndefined();
    const seven = Array.from({ length: 7 }, () => [think(), nudge(THOUGHT_TYPE)]).flat();
    expect(await h.settle([user(), ...seven, think()])).toBeDefined();
  });

  it("a declared intent continues with the re-act note; the judge sees spoken text only", async () => {
    const h = fake({ replies: [{ text: INTENT }] });
    const out = await h.settle([user(), think("I will write the tests now.")]);
    expect(out).toEqual({
      entries: [
        {
          type: "custom_message",
          customType: INTENT_TYPE,
          content: RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE,
          display: false,
        },
      ],
      continue: true,
    });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.model).toBe("current");
    expect(h.calls[0]!.user).toBe("I will write the tests now.");
    expect(h.calls[0]!.systemPrompt).toContain("Classify this assistant message.");
  });

  it("keeps entries other handlers already appended", async () => {
    const h = fake({ replies: [{ text: INTENT }] });
    const earlier = { type: "custom_message", customType: "other", content: "x", display: false } as const;
    const out = await h.settle([user(), say("I will do it.")], { entries: [earlier] });
    expect(out?.entries).toHaveLength(2);
    expect(out?.entries[0]).toBe(earlier);
  });

  it("tolerates a fenced judge reply", async () => {
    const h = fake({ replies: [{ text: `\`\`\`json\n${INTENT}\n\`\`\`` }] });
    expect(await h.settle([user(), say("I will do it.")])).toBeDefined();
  });

  it("asking the user settles", async () => {
    const h = fake({ replies: [{ text: JSON.stringify({ intent: true, awaiting_user: true }) }] });
    expect(await h.settle([user(), say("Want me to write the tests?")])).toBeUndefined();
  });

  it("a finished answer settles", async () => {
    const h = fake({ replies: [{ text: JSON.stringify({ intent: false, awaiting_user: false }) }] });
    expect(await h.settle([user(), say("Done.")])).toBeUndefined();
  });

  it("a judge that throws, errors or answers badly settles", async () => {
    const throws = fake({ replies: [new Error("boom")] });
    expect(await throws.settle([user(), say("I will do it.")])).toBeUndefined();
    const errored = fake({ replies: [{ text: INTENT, stopReason: "error" }] });
    expect(await errored.settle([user(), say("I will do it.")])).toBeUndefined();
    const garbage = fake({ replies: [{ text: "sure thing" }] });
    expect(await garbage.settle([user(), say("I will do it.")])).toBeUndefined();
  });

  it("aborts the judge at the deadline and settles", async () => {
    const h = fake({ timeoutMs: 5 });
    h.ctx.modelRegistry!.complete = (_model, _context, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    expect(await h.settle([user(), say("I will do it.")])).toBeUndefined();
  });

  it("nudges at most twice in a row, then settles without a call", async () => {
    const h = fake({ replies: [{ text: INTENT }, { text: INTENT }, { text: INTENT }] });
    const base = [user(), say("I will do it.")];
    expect(await h.settle(base)).toBeDefined();
    const once = [...base, nudge(INTENT_TYPE), say("I will do it now.")];
    expect(await h.settle(once)).toBeDefined();
    const twice = [...once, nudge(INTENT_TYPE), say("Really doing it.")];
    expect(await h.settle(twice)).toBeUndefined();
    expect(h.calls).toHaveLength(2);
  });

  it("work between nudges, or a new prompt, resets the streak", async () => {
    const h = fake({ replies: [{ text: INTENT }, { text: INTENT }] });
    const spent = [user(), say("a"), nudge(INTENT_TYPE), say("b"), nudge(INTENT_TYPE), say("c")];
    expect(await h.settle(spent)).toBeUndefined();
    const worked = [...spent.slice(0, 5), tool(), result, say("I will do more.")];
    expect(await h.settle(worked)).toBeDefined();
    const fresh = [...spent.slice(0, 5), say("c"), user("next"), say("I will do more.")];
    expect(await h.settle(fresh)).toBeDefined();
    expect(h.calls).toHaveLength(2);
  });

  it("does not run for aborted or errored runs, or once another handler continued", async () => {
    const h = fake({ replies: [{ text: INTENT }] });
    const messages = [user(), say("I will do it.")];
    expect(await h.settle(messages, { outcome: "aborted" })).toBeUndefined();
    expect(await h.settle(messages, { outcome: "error" })).toBeUndefined();
    expect(await h.settle(messages, { continue: true })).toBeUndefined();
    expect(await h.settle([user(), { ...say("x"), stopReason: "error" }])).toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });

  it("empty speech with no thinking settles without a call", async () => {
    const h = fake();
    expect(await h.settle([user(), say("")])).toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });

  it("judgeModel resolves through the registry; an unknown one falls back with one warning", async () => {
    const good = fake({ settings: '{"judgeModel":"cheap/mini/v1"}', replies: [{ text: INTENT }] });
    await good.settle([user(), say("I will do it.")]);
    expect(good.found).toEqual([["cheap", "mini/v1"]]);
    expect(good.calls[0]!.model).toEqual({ picked: "mini/v1" });

    const bad = fake({ settings: '{"judgeModel":"nope/x"}', replies: [{ text: INTENT }, { text: INTENT }] });
    await bad.settle([user(), say("I will do it.")]);
    await bad.settle([user(), say("I will do it again.")]);
    expect(bad.calls.map((call) => call.model)).toEqual(["current", "current"]);
    expect(bad.notes).toHaveLength(1);
  });

  it("enabled: false does not register", () => {
    expect(fake({ settings: '{"enabled":false}' }).registered).toBe(false);
    expect(fake().registered).toBe(true);
  });

  it("readSettings", () => {
    expect(readSettings(undefined)).toEqual({ enabled: true });
    expect(readSettings("not json")).toEqual({ enabled: true });
    expect(readSettings('{"enabled":false,"judgeModel":" a/b "}')).toEqual({ enabled: false, judgeModel: "a/b" });
    expect(readSettings('{"judgeModel":""}')).toEqual({ enabled: true });
  });
});
