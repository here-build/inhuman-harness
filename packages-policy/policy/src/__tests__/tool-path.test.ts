import { describe, expect, it } from "vitest";

import { checkToolPath, normalizeToolPath } from "../tool-path.js";

const cwd = "/work/proj";
const home = "/home/u";

describe("normalizeToolPath", () => {
  it.each([
    ["src/../.git/hooks/pre-commit", ".git/hooks/pre-commit"],
    ["/work/proj/.git/hooks/pre-commit", ".git/hooks/pre-commit"],
    ["/work/proj/../.zshrc", "/work/.zshrc"],
    ["../../../.zshrc", "/.zshrc"],
    ["./a//b/./c", "a/b/c"],
    ["src\\..\\.env", ".env"],
    ["~/.aws/credentials", "/home/u/.aws/credentials"],
    ["", "."],
    ["/work/proj", "."],
    ["/work/proj/dir/", "dir"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeToolPath(raw, cwd, home)).toBe(expected);
  });
});

describe("checkToolPath", () => {
  it.each([
    ["write", ".git/hooks/pre-commit"],
    ["write", "src/../.git/hooks/pre-commit"],
    ["write", ".GIT/hooks/pre-commit"],
    ["write", "/work/proj/.git/hooks/pre-commit"],
    ["write", "src/../.env"],
    ["write", ".ENV"],
    ["read", "src/../.env"],
    ["read", ".ENV"],
    ["read", "~/.aws/credentials"],
    ["read", "./.SSH/id_rsa"],
  ] as const)("%s %s is block", (operation, raw) => {
    expect(checkToolPath(operation, raw, { cwd, home })).toBe("block");
  });

  it("leaves ordinary in-tree reads approved", () => {
    expect(checkToolPath("read", "src/index.ts", { cwd, home })).toBe("policyApprove");
    expect(checkToolPath("read", "/work/proj/src/../src/index.ts", { cwd, home })).toBe("policyApprove");
  });
});
