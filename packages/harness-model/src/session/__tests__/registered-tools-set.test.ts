import { describe, expect, it } from "vitest";

import { mcpConnectionsEqual } from "../RegisteredToolsSet.js";

describe("mcpConnectionsEqual", () => {
  it.each([
    [["a", "b"], ["b", "a"], true],
    [["a", "b"], ["a", "a"], false],
    [["a", "a"], ["a", "b"], false],
    [["a"], ["a", "b"], false],
    [[], [], true],
  ] as const)("%j vs %j → %s", (left, right, equal) => {
    expect(mcpConnectionsEqual(left, right)).toBe(equal);
  });
});
