/**
 * The floor must judge the path the tool will open. Only glob / fff_search take a `cwd`;
 * every other file tool strips unknown keys, so a decoy `cwd` must not steer the question.
 */
import { describe, expect, it } from "vitest";

import { fileQuestion } from "../cluster.js";
import { fileReadPreparedPath } from "../read-roots.js";

describe("fileQuestion", () => {
  it.each(["read_file", "write_file", "edit_file", "list_dir", "grep"])("%s ignores a decoy cwd", (name) => {
    expect(fileQuestion(name, { path: ".env", cwd: "src" })).toBe(".env");
    expect(fileQuestion(name, { path: ".git/hooks/pre-commit", cwd: "." })).toBe(".git/hooks/pre-commit");
  });

  it.each(["read_file", "write_file", "edit_file", "list_dir", "grep"])(
    "%s with only a cwd has no question",
    (name) => {
      expect(fileQuestion(name, { cwd: "src" })).toBeNull();
    },
  );

  it.each(["glob", "fff_search"])("%s uses cwd, then path", (name) => {
    expect(fileQuestion(name, { cwd: "src", path: "lib" })).toBe("src");
    expect(fileQuestion(name, { path: "lib" })).toBe("lib");
    expect(fileQuestion(name, {})).toBeNull();
  });

  it("a read root candidate keys on the real path, not the decoy", () => {
    expect(fileReadPreparedPath("/w/proj", "read_file", { path: ".env", cwd: "src" })).toBe(".env");
  });
});
