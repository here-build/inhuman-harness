import { describe, expect, it } from "vitest";

import { modelCapabilitiesOf } from "../model-capabilities.js";

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
});
