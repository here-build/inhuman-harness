import path from "node:path";

import { workspacePath } from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

const ROOT = "/Users/me/work/harness";

describe("workspacePath", () => {
  it("relativizes in-root; extra-root stays absolute; empty cwd is a no-op", () => {
    expect({
      dot: workspacePath(ROOT, "."),
      empty: workspacePath(ROOT, ""),
      relative: workspacePath(ROOT, "src/a.ts"),
      self: workspacePath(ROOT, ROOT),
      nested: workspacePath(ROOT, path.join(ROOT, "src")),
      extra: workspacePath(ROOT, "/etc/passwd"),
      parent: workspacePath(ROOT, path.join(ROOT, "..")),
      climb: workspacePath(ROOT, "src/../.env"),
      glob: workspacePath(ROOT, "**/README.md"),
      passthrough: workspacePath("", "/etc/passwd"),
    }).toEqual({
      dot: ".",
      empty: ".",
      relative: "src/a.ts",
      self: ".",
      nested: "src",
      extra: "/etc/passwd",
      parent: path.dirname(ROOT).split(path.sep).join("/"),
      climb: ".env",
      glob: "**/README.md",
      passthrough: "/etc/passwd",
    });
  });
});
