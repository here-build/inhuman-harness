import { CompletionExpectation, CompletionJob, SessionSystemPrompt, SessionTurn } from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import {
  completionWires,
  formatModelPricing,
  modelBadges,
  modelChoiceValue,
  naturalName,
  openrouterProvider,
  sessionModel,
  type ModelCatalogSource,
} from "../model-choice.js";

const choicesOf = (connections: Parameters<typeof completionWires>[0]) =>
  completionWires(connections).flatMap((wire) => wire.choices);

function face(
  id: string,
  models: readonly string[],
  can: readonly string[] = ["completion"],
  name?: string,
): ModelCatalogSource {
  return { id, ...(name === undefined ? {} : { name }), driver: { abilityClaim: can }, live: { models: [...models] } };
}

describe("completion model choices", () => {
  it("lists completion models and puts catalogs under 20 ids first", () => {
    const openrouter = Array.from({ length: 20 }, (_, index) => `or-${index}`);
    const choices = choicesOf({
      openrouter: face("openrouter", openrouter),
      grok: face("grok", ["grok-4.7", "grok-4.6"]),
      web: face("web-keyless", ["unused"], ["web-search"]),
      empty: face("chatgpt", []),
      missing: undefined,
    });
    expect(choices.map((choice) => `${choice.connection}/${choice.model}`)).toEqual([
      "grok/grok-4.7",
      "grok/grok-4.6",
      ...openrouter.map((model) => `openrouter/${model}`),
    ]);
  });

  it("keeps unauthorized accounts visible while hiding even cached models", () => {
    const wires = completionWires({
      expired: {
        ...face("expired", ["stale-model"], ["completion"], "ChatGPT"),
        live: {
          models: ["stale-model"],
          auth: "needs-auth",
          identity: { displayName: "Ada" },
        },
      },
      boot: { ...face("boot", [], ["completion"], "Grok"), readyState: "failed", error: "models probe HTTP 401" },
    });
    expect(wires).toHaveLength(2);
    expect(wires.map((wire) => wire.choices)).toEqual([[], []]);
    expect(wires[0]?.account).toMatchObject({ needsAuth: true, name: "Ada" });
    expect(wires[1]?.account.needsAuth).toBe(true);
  });

  it("drops blank ids and non-strings", () => {
    const choices = choicesOf({
      chatgpt: {
        id: "chatgpt",
        driver: { abilityClaim: ["completion"] },
        live: { models: [" gpt-6.1-sol ", "", 3, "gpt-6-sol", "gpt-6.1-sol"] },
      },
    });
    expect(choices).toEqual([
      { connection: "chatgpt", model: "gpt-6.1-sol" },
      { connection: "chatgpt", model: "gpt-6-sol" },
    ]);
  });

  it("groups each connection under its own name, falling back to its id", () => {
    const wires = completionWires({
      chatgpt: face("chatgpt", ["gpt-6.1-sol"], ["completion"], "ChatGPT"),
      local: face("lm-studio", ["qwen"], ["completion"], " "),
      empty: face("grok", [], ["completion"], "Grok"),
    });
    expect(wires.map((wire) => [wire.connection, wire.name, wire.choices.map((choice) => choice.model)])).toEqual([
      ["chatgpt", "ChatGPT", ["gpt-6.1-sol"]],
      ["lm-studio", "lm-studio", ["qwen"]],
    ]);
  });

  it("names the last turn's model when the session has not chosen one", () => {
    const spoke = (model: string, connection: string): CompletionJob => {
      const expectation = new CompletionExpectation({ connectionId: connection });
      expectation.model = model;
      return new CompletionJob({ expectation });
    };
    const older = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      doneWork: [spoke("gpt-6.1-sol", "chatgpt")],
    });
    const newer = new SessionTurn({
      turnTail: older,
      queue: [],
      doneWork: [spoke("grok-4.7", "grok"), spoke("", "grok")],
    });
    expect(sessionModel({ kvs: { model: "  ", connection: "x" }, head: newer })).toEqual({
      connection: "grok",
      model: "grok-4.7",
    });
    expect(sessionModel({ kvs: { connection: "chatgpt", model: "gpt-6-mini" }, head: newer })).toEqual({
      connection: "chatgpt",
      model: "gpt-6-mini",
    });
    expect(sessionModel(null)).toEqual({ connection: "", model: "" });
  });

  it("reads a kebab id as capitalized words with curated model transforms and badge stripping", () => {
    expect(naturalName("grok-4.7-build-fast")).toBe("Grok 4.7 Build Fast");
    expect(naturalName("gpt-6.1-sol")).toBe("GPT 6.1 Sol");
    expect(naturalName("--qwen--")).toBe("Qwen");
    expect(naturalName("cohere/command-a")).toBe("Command-A");
    expect(naturalName("cohere/command-r-plus")).toBe("Command-R+");
    expect(naturalName("nvidia/nemotron-3.5-super:free", "Nvidia: Nemotron 3.5 Super (free)")).toBe(
      "Nemotron 3.5 Super",
    );
    expect(modelBadges("nvidia/nemotron-3.5-super:free", "NVIDIA: Nemotron 3.5 Super (free)")).toEqual(["free"]);
    expect(modelBadges("deepseek/deepseek-r1:thinking")).toEqual(["thinking"]);
    expect(formatModelPricing({ cacheRead: 0.1, prompt: 1, completion: 10 })).toBe("$0.1/$1/$10");
    expect(formatModelPricing({ prompt: 1, completion: 10 })).toBe("$1/$10");
    expect(formatModelPricing({ prompt: 0, completion: 0 })).toBe("free");
    expect(formatModelPricing(undefined, ["free"])).toBe("free");
    expect(openrouterProvider("nvidia/nemotron-3.5-super")).toEqual({
      key: "nvidia",
      label: "NVIDIA",
      icon: "nvidia",
    });
  });

  it("groups OpenRouter catalog models by internal provider while filtering non-chat and batch models", () => {
    const [wire] = completionWires({
      openrouter: face("openrouter", [
        "nvidia/nemotron-3.5-super",
        "google/nano-banana",
        "google/gemini-2.5-flash-image-preview",
        "openai/gpt-5",
        "openai/gpt-4o-realtime-preview",
        "openai/gpt-4o-audio-preview",
        "z-ai/glm-4.5-air:batch",
        "nvidia/nemotron-3.5-super:free",
        "x-ai/grok-4.7",
      ]),
    });
    expect(wire.openrouter).toBe(true);
    expect(wire.choices.map((choice) => choice.model)).toEqual([
      "nvidia/nemotron-3.5-super",
      "nvidia/nemotron-3.5-super:free",
      "openai/gpt-5",
      "x-ai/grok-4.7",
    ]);
  });

  it("keeps the same model on two wires apart", () => {
    expect(modelChoiceValue({ connection: "a", model: "m" })).not.toBe(
      modelChoiceValue({ connection: "b", model: "m" }),
    );
  });
});
