import { describe, expect, it } from "vitest";

import { lineDiff } from "./line-diff.js";

describe("lineDiff", () => {
  it("marks a changed line as a removal and an addition with numbers", () => {
    const rows = lineDiff("a\nb\nc\n", "a\nB\nc\n");
    expect(rows).toEqual([
      { kind: "ctx", oldNo: 1, newNo: 1, text: "a" },
      { kind: "del", oldNo: 2, newNo: null, text: "b" },
      { kind: "add", oldNo: null, newNo: 2, text: "B" },
      { kind: "ctx", oldNo: 3, newNo: 3, text: "c" },
    ]);
  });

  it("starts numbering at lineStart", () => {
    expect(lineDiff("x", "y", 40)).toEqual([
      { kind: "del", oldNo: 40, newNo: null, text: "x" },
      { kind: "add", oldNo: null, newNo: 40, text: "y" },
    ]);
  });

  it("folds distant context into a gap", () => {
    const base = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const next = [...base];
    next[15] = "changed";
    const rows = lineDiff(base.join("\n"), next.join("\n"));
    expect(rows.filter((row) => row.kind === "gap")).toHaveLength(0);
    const far = [...base];
    far[0] = "first";
    far[29] = "last";
    expect(lineDiff(base.join("\n"), far.join("\n")).filter((row) => row.kind === "gap")).toEqual([
      { kind: "gap", hidden: 22 },
    ]);
  });

  it("treats an empty side as pure additions or removals", () => {
    expect(lineDiff("", "a\nb").map((row) => row.kind)).toEqual(["add", "add"]);
    expect(lineDiff("a\nb", "").map((row) => row.kind)).toEqual(["del", "del"]);
  });
});
