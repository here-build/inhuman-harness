import { describe, expect, it } from "vitest";

import { projectHref, projectNames, readTarget, sessionHref } from "../path.js";

describe("path segment", () => {
  it("keeps a slash inside one segment", () => {
    const path = "/Users/foo/bar";
    expect(readTarget(projectHref(path))).toEqual({ kind: "project", path });
    expect(readTarget(sessionHref(path, "s1"))).toEqual({
      kind: "project-session",
      path,
      sessionId: "s1",
    });
  });

  it("does not parse /p/a/s/b as a path named a/s", () => {
    expect(readTarget("/p/a/s/b")).toEqual({ kind: "project-session", path: "a", sessionId: "b" });
    expect(readTarget("/p/a%2Fs")).toEqual({ kind: "project", path: "a/s" });
  });
});

describe("project names", () => {
  it("names each project by its shortest unshared tail", () => {
    const names = projectNames(["/w/here.build/harness", "/w/here.build/harness/packages/harness", "/w/kley"]);
    expect([...names.values()]).toEqual(["here.build/harness", "packages/harness", "kley"]);
  });

  it("keeps a nested project distinct from the project it ends with", () => {
    expect(projectNames(["/a", "/x/a"]).get("/a")).toBe("a");
    expect(projectNames(["/a", "/x/a"]).get("/x/a")).toBe("x/a");
  });
});
