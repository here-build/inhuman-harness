import { CompletionExpectation, CompletionJob, SessionSystemPrompt, SessionTurn } from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import {
  completionWires,
  modelChoiceValue,
  naturalName,
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

  it("reads a kebab id as capitalized words", () => {
    expect(naturalName("grok-4.7-build-fast")).toBe("Grok 4.7 Build Fast");
    expect(naturalName("gpt-6.1-sol")).toBe("Gpt 6.1 Sol");
    expect(naturalName("--qwen--")).toBe("Qwen");
  });

  it("keeps the same model on two wires apart", () => {
    expect(modelChoiceValue({ connection: "a", model: "m" })).not.toBe(
      modelChoiceValue({ connection: "b", model: "m" }),
    );
  });
});
