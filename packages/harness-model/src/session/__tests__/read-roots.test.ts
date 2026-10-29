import { Plexus } from "@here.build/plexus";
import { describe, expect, it } from "vitest";

import { isReadRootable, readRootOf, underReadRoot } from "../read-roots.js";
import { SessionRoot } from "../SessionRoot.js";

describe("read roots", () => {
  it("only a deep absolute folder may be a root", () => {
    for (const bad of [
      "/",
      "/Users",
      "/Users/me",
      "/home/me",
      "/Volumes/x",
      "src",
      "/a/../b",
      "/a/*",
      "/a/{b,c}",
      "~/x",
    ]) {
      expect(isReadRootable(bad)).toBe(false);
    }
    for (const good of ["/Users/me/docs", "/opt/shared", "/srv/a/b"]) expect(isReadRootable(good)).toBe(true);
  });
  it("normalises against the workspace and drops trailing slashes", () => {
    expect(readRootOf("/w/proj", "/opt/shared/")).toBe("/opt/shared");
    expect(readRootOf("/w/proj", "../shared")).toBe("/w/shared");
    expect(readRootOf("/w/proj", "docs")).toBeUndefined();
  });
  it("covers the folder and what is under it, not a sibling prefix", () => {
    expect(underReadRoot(["/opt/shared"], "/opt/shared")).toBe(true);
    expect(underReadRoot(["/opt/shared"], "/opt/shared/a/b")).toBe(true);
    expect(underReadRoot(["/opt/shared"], "/opt/shared2/a")).toBe(false);
  });
  it("SessionRoot.addReadRoot records a session root and refuses a fenced one", () => {
    const root = new SessionRoot({ sessionId: "s", path: "/w/proj" });
    const plexus = Plexus.bootstrap(root);
    expect(root.addReadRoot("/opt/shared")).toBe(true);
    expect(root.addReadRoot("/Users")).toBe(false);
    expect(Object.keys(root.readRoots)).toEqual(["/opt/shared"]);
    plexus.destroy();
  });
});
