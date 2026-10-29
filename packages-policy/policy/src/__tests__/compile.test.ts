import { describe, expect, it } from "vitest";

import { compilePolicy, PolicyCompileError } from "../compile.js";

function compileFailure(document: unknown): string {
  try {
    compilePolicy(document);
    return "";
  } catch (error) {
    return error instanceof PolicyCompileError ? error.message : String(error);
  }
}

describe("policy document", () => {
  it("rejects a string and an unknown key", () => {
    expect({
      text: compileFailure("bash: ask"),
      extra: compileFailure({ extra: 1 }),
    }).toEqual({
      text: "policy.json: document must be a mapping",
      extra: "policy.json: unknown top-level key extra",
    });
  });
});
