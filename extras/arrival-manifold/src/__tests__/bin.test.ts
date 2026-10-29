import { describe, expect, it } from "vitest";

import { configPathFromArgv, responseCharacterCapFromArgv } from "../bin.js";

describe("configPathFromArgv", () => {
  it("reads the path following --config", () => {
    expect(configPathFromArgv(["--config", "mcpServers.json"])).toBe("mcpServers.json");
  });

  it("throws a usage error when --config is missing", () => {
    expect(() => configPathFromArgv([])).toThrow(/--config/);
  });

  it("throws a usage error when --config has no following path", () => {
    expect(() => configPathFromArgv(["--config"])).toThrow(/--config/);
  });
});

describe("responseCharacterCapFromArgv", () => {
  it("reads the integer following --response-character-cap", () => {
    expect(responseCharacterCapFromArgv(["--response-character-cap", "8000"])).toBe(8000);
  });

  it("returns undefined when the flag is absent", () => {
    expect(responseCharacterCapFromArgv(["--config", "mcpServers.json"])).toBeUndefined();
  });

  it("throws when the flag has no following value", () => {
    expect(() => responseCharacterCapFromArgv(["--response-character-cap"])).toThrow(/--response-character-cap/);
  });

  it("throws on a non-positive or fractional value", () => {
    expect(() => responseCharacterCapFromArgv(["--response-character-cap", "0"])).toThrow(/--response-character-cap/);
    expect(() => responseCharacterCapFromArgv(["--response-character-cap", "-5"])).toThrow(/--response-character-cap/);
    expect(() => responseCharacterCapFromArgv(["--response-character-cap", "1.5"])).toThrow(/--response-character-cap/);
    expect(() => responseCharacterCapFromArgv(["--response-character-cap", "not-a-number"])).toThrow(
      /--response-character-cap/,
    );
  });
});
