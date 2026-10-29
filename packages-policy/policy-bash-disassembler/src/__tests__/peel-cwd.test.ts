import { describe, expect, it } from "vitest";

import { peelLeadingCd, peelShellCwd } from "../peel-cwd.js";

describe("peelLeadingCd", () => {
  it.each([
    ["cd ./scripts && npm test", { cwd: "./scripts", command: "npm test" }],
    ["cd ../bin && ./tool", { cwd: "../bin", command: "./tool" }],
    ["cd /etc && ls", { cwd: "/etc", command: "ls" }],
    ["cd src; git status", { cwd: "src", command: "git status" }],
    ['cd "./scripts" && npm test', { cwd: "./scripts", command: "npm test" }],
    ["cd dest && a && b", { cwd: "dest", command: "a && b" }],
    ["cd dest && a; b", { cwd: "dest", command: "a; b" }],
    ["builtin cd src && ls", { cwd: "src", command: "ls" }],
    ["command cd src && ls", { cwd: "src", command: "ls" }],
    ["cd dest", { cwd: "dest", command: "" }],
  ] as const)("%s", (source, want) => {
    expect(peelLeadingCd(source)).toEqual(want);
  });

  it.each([
    "cd dest || exit",
    "cd dest | cmd",
    "mkdir x && cd x",
    "( cd dest && cmd )",
    "{ cd dest; cmd; }",
    "cd -",
    "cd -- dest",
    "cd dest extra",
    "cd $HOME && ls",
    "cd dest & ls",
  ])("does not peel %s", (source) => {
    expect(peelLeadingCd(source)).toBeNull();
  });

  it("keeps an agreeing cwd arg; refuses a disagreement", () => {
    expect({
      agree: peelShellCwd("cd src && npm test", "./src"),
      omit: peelShellCwd("cd src && npm test"),
      clash: peelShellCwd("cd other && npm test", "src"),
    }).toEqual({
      agree: { cwd: "./src", command: "npm test" },
      omit: { cwd: "src", command: "npm test" },
      clash: null,
    });
  });
});
