import { describe, expect, it } from "vitest";

import { isChatModel, modelCapabilitiesOf, modelNameOf, modelPricingOf } from "../model-capabilities.js";

describe("model capability normalization", () => {
  it("retains ChatGPT/Codex image and text-only input modalities", () => {
    expect(modelCapabilitiesOf({ slug: "gpt-6.1-sol", input_modalities: ["text", "image"] })).toEqual({
      inputModalities: ["text", "image"],
    });
    expect(modelCapabilitiesOf({ input_modalities: ["text"] })).toEqual({ inputModalities: ["text"] });
    expect(modelCapabilitiesOf({ input_modalities: [" TEXT ", "Image"] })).toEqual({
      inputModalities: ["text", "image"],
    });
  });

  it("reads OpenRouter architecture input modalities, not output modalities", () => {
    expect(modelCapabilitiesOf({ architecture: { input_modalities: ["text", "image"] } })).toEqual({
      inputModalities: ["text", "image"],
    });
    expect(modelCapabilitiesOf({ architecture: { input_modalities: ["text"], output_modalities: ["image"] } })).toEqual(
      { inputModalities: ["text"] },
    );
    expect(modelCapabilitiesOf({ input_modalities: null, architecture: { input_modalities: ["image"] } })).toEqual({
      inputModalities: ["image"],
    });
  });

  it("preserves explicit vision booleans including false alongside modalities", () => {
    expect(modelCapabilitiesOf({ supports_vision: true })).toEqual({ supportsVision: true });
    expect(modelCapabilitiesOf({ supports_vision: false })).toEqual({ supportsVision: false });
    expect(modelCapabilitiesOf({ input_modalities: ["image"], supports_vision: false })).toEqual({
      inputModalities: ["image"],
      supportsVision: false,
    });
  });

  it("extracts supportsReasoning and reasoningEfforts across catalog schemas", () => {
    expect(modelCapabilitiesOf({ supports_reasoning: true })).toEqual({ supportsReasoning: true });
    expect(modelCapabilitiesOf({ supports_reasoning: false })).toEqual({ supportsReasoning: false });
    expect(
      modelCapabilitiesOf({
        supported_parameters: ["temperature", "reasoning", "max_tokens"],
      }),
    ).toEqual({ supportsReasoning: true });
    expect(
      modelCapabilitiesOf({
        supported_parameters: ["reasoning_effort"],
      }),
    ).toEqual({ supportsReasoning: true });
    expect(modelCapabilitiesOf({ reasoning: true })).toEqual({ supportsReasoning: true });
    expect(modelCapabilitiesOf({ reasoning: false })).toEqual({ supportsReasoning: false });
    expect(modelCapabilitiesOf({ reasoning: { supported: false } })).toEqual({ supportsReasoning: false });
    expect(
      modelCapabilitiesOf({ reasoning: { enabled: true, supported_efforts: ["LOW", "Medium", "high", "invalid"] } }),
    ).toEqual({
      supportsReasoning: true,
      reasoningEfforts: ["low", "medium", "high"],
    });
    expect(
      modelCapabilitiesOf({
        supported_reasoning_levels: [
          { effort: "low", description: "fast" },
          { effort: "MEDIUM" },
          { effort: "high" },
          { effort: "xhigh" },
        ],
      }),
    ).toEqual({
      supportsReasoning: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
    });
    expect(
      modelCapabilitiesOf({
        reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      }),
    ).toEqual({
      supportsReasoning: true,
      reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
  });

  it.each([
    {},
    { id: "gpt-4o" },
    { input_modalities: "image" },
    { input_modalities: [] },
    { input_modalities: ["text", null] },
    { input_modalities: [""] },
    { input_modalities: ["  "] },
    { architecture: null },
    { architecture: "image" },
    { architecture: { input_modalities: [42] } },
    { supports_vision: "false" },
  ])("keeps missing or malformed metadata unknown: %j", (row) => {
    expect(modelCapabilitiesOf(row)).toBeUndefined();
  });

  it("extracts display names and per-million-token pricing from OpenRouter catalog rows", () => {
    expect(modelNameOf({ name: "NVIDIA: Nemotron 3.5 Super (free)" }, "nvidia/nemotron-3.5-super:free")).toBe(
      "NVIDIA: Nemotron 3.5 Super (free)",
    );
    expect(modelNameOf({ name: "gpt-4o" }, "gpt-4o")).toBeUndefined();
    expect(modelNameOf({ name: "   " }, "gpt-4o")).toBeUndefined();

    expect(
      modelPricingOf({
        pricing: { prompt: "0.000001", completion: "0.00001", input_cache_read: "0.0000001" },
      }),
    ).toEqual({
      prompt: 1,
      completion: 10,
      cacheRead: 0.1,
    });
    expect(
      modelPricingOf({
        pricing: { prompt: "0.000001", completion: "0.00001", input_cache_read: "0" },
      }),
    ).toEqual({
      prompt: 1,
      completion: 10,
    });
    expect(modelPricingOf({ pricing: { prompt: "0", completion: "0" } })).toEqual({
      prompt: 0,
      completion: 0,
    });
    expect(modelPricingOf({ pricing: { prompt: "-1", completion: "-1" } })).toBeUndefined();
    expect(modelPricingOf({})).toBeUndefined();
  });

  it("filters out image generators, voice-to-voice/audio models, embeddings, and batch models", () => {
    expect(
      isChatModel(
        {
          name: "NVIDIA: Nemotron 3.5 Super",
          architecture: { input_modalities: ["text"], output_modalities: ["text"], modality: "text->text" },
        },
        "nvidia/nemotron-3.5-super",
      ),
    ).toBe(true);
    expect(
      isChatModel(
        {
          name: "Google: Gemini 2.5 Pro",
          architecture: {
            input_modalities: ["text", "image", "audio", "file"],
            output_modalities: ["text"],
            modality: "text+image+audio+file->text",
          },
        },
        "google/gemini-2.5-pro",
      ),
    ).toBe(true);

    // Nano Banana / image generation models (output_modalities includes "image")
    expect(
      isChatModel(
        {
          name: "Google: Nano Banana (Gemini 2.5 Flash Image)",
          architecture: {
            input_modalities: ["text", "image"],
            output_modalities: ["image", "text"],
            modality: "text+image->text+image",
          },
        },
        "google/gemini-2.5-flash-image-preview",
      ),
    ).toBe(false);
    expect(isChatModel({ name: "Nano Banana" }, "google/nano-banana")).toBe(false);
    expect(
      isChatModel({ architecture: { input_modalities: ["text"], output_modalities: ["image"] } }, "flux/schnell"),
    ).toBe(false);

    // Voice-to-voice / audio output or audio-only input models
    expect(
      isChatModel(
        {
          architecture: {
            input_modalities: ["text", "audio"],
            output_modalities: ["text", "audio"],
            modality: "text+audio->text+audio",
          },
        },
        "openai/gpt-4o-audio-preview",
      ),
    ).toBe(false);
    expect(isChatModel({}, "openai/gpt-4o-realtime-preview")).toBe(false);
    expect(
      isChatModel({ architecture: { input_modalities: ["audio"], output_modalities: ["text"] } }, "openai/whisper-1"),
    ).toBe(false);

    // Batch models
    expect(isChatModel({}, "z-ai/glm-4.5-air:batch")).toBe(false);
    expect(isChatModel({ name: "OpenAI: GPT-5 (batch)" }, "openai/gpt-5")).toBe(false);
    expect(isChatModel({ batch: true }, "openai/gpt-5")).toBe(false);

    // Embeddings / rerank / moderation
    expect(isChatModel({ type: "embedding" }, "text-embedding-3-large")).toBe(false);
    expect(isChatModel({}, "cohere/rerank-v3")).toBe(false);
  });
});
