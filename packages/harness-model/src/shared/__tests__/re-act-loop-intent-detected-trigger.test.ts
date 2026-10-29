import { describe, expect, it } from "vitest";

import { parseTextOnlyContinue, reActLoopIntentDetectedTriggerFor } from "../ReActLoopIntentDetectedTrigger.js";

describe("reActLoopIntentDetectedTriggerFor", () => {
  it("dict hit wins, else enabled", () => {
    const bag = {
      enabled: true,
      models: { "openai:gpt-5.2": false, "lm-studio:qwen": true },
    };
    expect({
      off: reActLoopIntentDetectedTriggerFor({ enabled: false, models: {} }, "c", "m"),
      on: reActLoopIntentDetectedTriggerFor({ enabled: true, models: {} }, "c", "m"),
      actorOff: reActLoopIntentDetectedTriggerFor(bag, "openai", "gpt-5.2"),
      actorOn: reActLoopIntentDetectedTriggerFor(bag, "lm-studio", "qwen"),
      inherit: reActLoopIntentDetectedTriggerFor(bag, "c1", "grok-4.6"),
      slash: reActLoopIntentDetectedTriggerFor(
        { enabled: false, models: { "openrouter:anthropic/claude": true } },
        "openrouter",
        "anthropic/claude",
      ),
    }).toEqual({
      off: false,
      on: true,
      actorOff: false,
      actorOn: true,
      inherit: true,
      slash: true,
    });
  });

  it("parse: omitted bag is on, explicit false is off, a non-object is off", () => {
    expect(parseTextOnlyContinue(undefined)).toEqual({ enabled: true, models: {} });
    expect(parseTextOnlyContinue(null)).toEqual({ enabled: true, models: {} });
    expect(parseTextOnlyContinue({})).toEqual({ enabled: true, models: {} });
    expect(parseTextOnlyContinue({ models: { "c:m": false } })).toEqual({
      enabled: true,
      models: { "c:m": false },
    });
    expect(parseTextOnlyContinue({ enabled: false, models: { "c:m": true, bad: 1 } })).toEqual({
      enabled: false,
      models: { "c:m": true },
    });
    expect(parseTextOnlyContinue("nope")).toEqual({ enabled: false, models: {} });
    expect(parseTextOnlyContinue({ enabled: true, models: { "c:m": true, bad: 1 } })).toEqual({
      enabled: true,
      models: { "c:m": true },
    });
  });
});
