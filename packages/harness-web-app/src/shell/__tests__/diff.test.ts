import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { projectDiff } from "../diff-model.js";
import { DiffView } from "../diff-view.js";

const project = (oldText: string, newText: string, lineStart?: number) =>
  projectDiff({ oldText, newText, lineStart, path: "src/a.ts" });

describe("Pierre diff projection", () => {
  it("ignores a missing final newline but preserves an extra blank line", () => {
    expect(project("hi", "hi\n").status).toBe("same");
    expect(project("", "").status).toBe("empty");
    const model = project("hi\n", "hi\n\n");
    expect(model.status).toBe("diff");
    if (model.status !== "diff") throw new Error("expected diff");
    expect(model.fileDiff.hunks[0].additionLines).toBe(1);
  });

  it("provides both full files to Pierre for highlighting and context expansion", () => {
    const oldText = Array.from({ length: 30 }, (_, i) => `const value${i} = ${i};\n`).join("");
    const newText = oldText.replace("value15 = 15", "value15 = 100");
    const model = project(oldText, newText);
    if (model.status !== "diff") throw new Error("expected diff");
    expect(model.fileDiff.isPartial).toBe(false);
    expect(model.fileDiff.deletionLines.join("")).toBe(oldText);
    expect(model.fileDiff.additionLines.join("")).toBe(newText);
    expect(model.fileDiff.hunks[0].deletionLines).toBe(1);
    expect(model.fileDiff.hunks[0].additionLines).toBe(1);
    expect(model.fileDiff.name).toBe("src/a.ts");
  });

  it("recognizes file creation and deletion", () => {
    const created = project("", "new\n");
    const deleted = project("old\n", "");
    expect(created.status === "diff" && created.fileDiff.type).toBe("new");
    expect(deleted.status === "diff" && deleted.fileDiff.type).toBe("deleted");
  });

  it("keeps stamped span origins without inventing preceding file content", () => {
    const model = project("alpha\n", "beta\n", 46);
    if (model.status !== "diff") throw new Error("expected diff");
    expect(model.fileDiff.isPartial).toBe(true);
    expect(model.fileDiff.hunks[0]).toMatchObject({
      additionStart: 46,
      deletionStart: 46,
      additionLineIndex: 0,
      deletionLineIndex: 0,
    });
    expect(model.fileDiff.deletionLines).toEqual(["alpha\n"]);
    expect(model.fileDiff.additionLines).toEqual(["beta\n"]);
  });
});

describe("DiffView", () => {
  it("renders a filename and a host for an open browser diff", () => {
    const html = renderToStaticMarkup(
      createElement(DiffView, { oldText: "hello\n", newText: "hi\n", path: "src/a.ts" }),
    );
    expect(html).toContain("src/a.ts");
    expect(html).not.toContain("<details");
    expect(html).toContain("<div></div>");
  });

  it("says when the file is empty or unchanged", () => {
    expect(renderToStaticMarkup(createElement(DiffView, { oldText: "", newText: "", path: "a.ts" }))).toContain(
      "Empty file",
    );
    expect(
      renderToStaticMarkup(createElement(DiffView, { oldText: "same\n", newText: "same", path: "a.ts" })),
    ).toContain("No changes");
  });
});
