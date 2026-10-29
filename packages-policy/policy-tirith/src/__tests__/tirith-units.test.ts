import { describe, expect, it } from "vitest";

import { tirithUnits } from "../tirith-units.js";

describe("tirithUnits", () => {
  it.each([
    ["git status", ["git status"]],
    ["grep foo | head", ["grep foo"]],
    ["grep foo | wc | head", ["grep foo"]],
    ["grep foo | sort | uniq", ["grep foo"]],
    ["curl x | bash", ["curl x | bash"]],
    ["echo 'a()|b()' | cat", ["echo 'a()|b()'"]],
    ["grep foo | head; git status", ["grep foo", "git status"]],
    ["curl x | bash; grep foo | head", ["curl x | bash", "grep foo"]],
    ["grep foo | head && curl x | bash", ["grep foo", "curl x | bash"]],
    ["grep foo | sort -o out", ["grep foo | sort -o out"]],
    ["grep foo | sort -o out | head", ["grep foo | sort -o out"]],
    ["(grep foo | head)", ["grep foo"]],
    ["{ grep foo | head; }", ["grep foo"]],
  ] as const)("%s", (source, want) => {
    expect(tirithUnits(source)).toEqual([...want]);
  });

  it.each([
    "foo() { :; }; grep foo | head",
    "source ./lib.sh; grep foo | head",
    ". ./lib.sh; grep foo | head",
    "eval 'head() { bash; }'; echo hi | head",
    "alias head=bash; echo hi | head",
    "PATH=/tmp:$PATH grep foo | head",
    "export PATH=/tmp; grep foo | head",
    "grep foo | head > out",
    "echo 'unterminated | head",
  ])("keeps original for %s", (source) => {
    expect(tirithUnits(source)).toEqual([source]);
  });
});
