import { describe, expect, it } from "vitest";

import { completeSkillSlash, matchingSkills, skillSlashToken } from "../skill-slash.js";

const rows = [
  { name: "review", invoke: "project:review", description: "Review changes" },
  { name: "build", invoke: "" },
];

describe("skill slash helpers", () => {
  it("only recognizes the first slash token at the caret, never arguments or selections", () => {
    expect(skillSlashToken("/re", 3)).toBe("re");
    expect(skillSlashToken("/re  \n", 3)).toBe("re");
    for (const [value, caret] of [
      [" /re", 4],
      ["hello /re", 9],
      ["/re args", 3],
      ["/re ", 4],
      ["/re", 0],
    ] as const)
      expect(skillSlashToken(value, caret)).toBeNull();
    expect(skillSlashToken("/re", 1, 3)).toBeNull();
  });

  it("only matches supplied skills and uses canonical invoke with name fallback", () => {
    expect(matchingSkills(rows, "re")).toEqual([rows[0]]);
    expect(matchingSkills(rows, "project:")).toEqual([rows[0]]);
    expect(matchingSkills(rows, "goal")).toEqual([]);
    expect(matchingSkills(rows, "tmp/file")).toEqual([]);
    expect(completeSkillSlash("/bu", rows[1]!)).toEqual({ value: "/build ", caret: 7 });
  });

  it("only replaces the leading token, retaining the remainder", () => {
    expect(completeSkillSlash("/re args\nmore", rows[0]!)).toEqual({
      value: "/project:review args\nmore",
      caret: 16,
    });
    expect(completeSkillSlash("/re  \n", rows[0]!).value).toBe("/project:review  \n");
  });
});
