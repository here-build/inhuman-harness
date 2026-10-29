import { describe, expect, it } from "vitest";

import { decideHook, hookCall, runHook } from "../hook.js";
import { type Judge, type Verdict } from "../index.js";

const deny: Judge = (): Promise<Verdict> => Promise.resolve("deny");

describe("hookCall", () => {
  it("reads bash command and file_path, and skips view", () => {
    expect(hookCall({ tool_name: "bash", tool_input: { command: "git status", working_dir: "/tmp" } })).toEqual({
      kind: "bash",
      command: "git status",
    });
    expect(hookCall({ tool_name: "multiedit", tool_input: { file_path: "a.ts" } })).toEqual({
      kind: "write",
      path: "a.ts",
    });
    expect(hookCall({ tool_name: "view", tool_input: { file_path: "../outside" }, cwd: "/work/proj" })).toEqual({
      kind: "read",
      path: "../outside",
      cwd: "/work/proj",
    });
    expect(hookCall({ tool_name: "fetch", tool_input: { url: "https://x" } })).toEqual({ kind: "skip" });
    expect(hookCall({ tool_name: "bash", tool_input: {} })).toEqual({ kind: "invalid" });
  });
});

describe("decideHook: normalised paths and read tools", () => {
  const cwd = "/work/proj";

  it("a dot-dot or upper-case route to .git is a floor block", async () => {
    for (const file_path of ["src/../.git/hooks/pre-commit", ".GIT/hooks/pre-commit", "/work/proj/.git/hooks/x"]) {
      expect(await decideHook({ tool_name: "write", tool_input: { file_path }, cwd }, () => "allow")).toEqual({
        decision: "deny",
        reason: "not authorized",
      });
    }
  });

  it("view of a secret is denied; view of an in-tree file is left to Crush", async () => {
    expect(await decideHook({ tool_name: "view", tool_input: { file_path: ".env" }, cwd }, () => "allow")).toEqual({
      decision: "deny",
      reason: "not authorized",
    });
    expect(
      await decideHook({ tool_name: "view", tool_input: { file_path: "src/a.ts" }, cwd }, () => "deny"),
    ).toBeUndefined();
  });
});

describe("decideHook", () => {
  it("prints allow for a floor approve and deny for a missing path", async () => {
    expect(await decideHook({ tool_name: "bash", tool_input: { command: "ls" } }, deny)).toEqual({
      decision: "allow",
    });
    expect(await decideHook({ tool_name: "write", tool_input: {} }, null)).toEqual({
      decision: "deny",
      reason: "missing command or path",
    });
  });

  it("denies when the judge does not answer before the budget", async () => {
    const decision = await runHook(
      JSON.stringify({ tool_name: "bash", tool_input: { command: "git pull" } }),
      () => new Promise(() => undefined),
      20,
    );
    expect(decision).toEqual({ decision: "deny", reason: "authorization timed out" });
  });

  it("denies input that is not json", async () => {
    expect(await runHook("{", null, 20)).toEqual({ decision: "deny", reason: "hook input is not json" });
  });
});
