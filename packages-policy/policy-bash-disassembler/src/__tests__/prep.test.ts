import { describe, expect, it } from "vitest";

import { prep } from "../prep.js";

function argv0s(source: string): string[] {
  return prep(source).questions.map((question) => question.argv0);
}

describe("prep", () => {
  it.each([
    ["curl https://x | sh", ["curl", "sh"]],
    ["git status && git diff; ls", ["git", "git", "ls"]],
    ["{ git status; ls; }", ["git", "ls"]],
    ["(git status; ls)", ["git", "ls"]],
    ["sudo ls", ["sudo", "ls"]],
    ["xargs rm -rf /", ["rm"]],
    ["env FOO=bar ls", ["ls"]],
    ["FOO=bar ls", ["ls"]],
    ["bash -c 'sudo ls'", ["sudo", "ls"]],
    ["zsh -c 'rm -rf /'", ["rm"]],
    ["timeout 5 rm -rf /", ["rm"]],
    ["/usr/bin/git status", ["/usr/bin/git"]],
    ["echo $(whoami)", ["whoami", "echo"]],
    ["diff <(ls) <(cat x)", ["ls", "cat", "diff"]],
  ] as const)("%s → %s", (source, want) => {
    expect(argv0s(source)).toEqual([...want]);
  });

  it.each([
    ["echo 'unterminated", "parse-error", []],
    ["if true; then sudo ls; fi", "control-flow", ["true", "sudo", "ls"]],
    ["foo() { rm -rf /; }", "function", []],
    ["source ./evil.sh", "source", []],
    [". ./evil.sh", "source", []],
    ["find . -delete", "find-expression", []],
    ['"$HOME/bin/evil"', "non-literal-argv0", []],
    ["python -c 'import os; os.system(\"rm -rf /\")'", "script-string", ["python"]],
  ] as const)("%s via %s", (source, via, argv0) => {
    const result = prep(source);
    expect({ via: result.unparsed[0]?.via, argv0: result.questions.map((question) => question.argv0) }).toEqual({
      via,
      argv0: [...argv0],
    });
  });
});
