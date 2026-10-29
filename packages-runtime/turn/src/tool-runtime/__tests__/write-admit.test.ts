import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeFileAdmitSnap } from "../write-admit.js";

describe("writeFileAdmitSnap", () => {
  let root = "";
  let outside = "";
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "wa-root-")));
    outside = realpathSync(mkdtempSync(path.join(tmpdir(), "wa-out-")));
    writeFileSync(path.join(root, "note.txt"), "inside");
    writeFileSync(path.join(outside, "secret.txt"), "TOPSECRET");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const snap = (p: string, extra: object = {}) => writeFileAdmitSnap(root, JSON.stringify({ path: p, ...extra }));
  const blind = { existed: null, priorContent: null, refuse: null };

  it("captures prior content and the overwrite door for an in-root file", () => {
    expect(snap("note.txt")).toMatchObject({ existed: true, priorContent: "inside" });
    expect(snap("note.txt").refuse).toMatch(/exists/);
    expect(snap("note.txt", { overwriteExisting: true }).refuse).toBeNull();
    expect(snap("fresh.txt")).toEqual({ existed: false, priorContent: null, refuse: null });
  });

  it("reads nothing and probes nothing outside the root", () => {
    expect(snap(path.join(outside, "secret.txt"))).toEqual(blind);
    expect(snap(path.join(outside, "missing.txt"))).toEqual(blind);
    expect(snap("../etc/passwd")).toEqual(blind);
  });

  it("does not follow an in-root link to an outside file", () => {
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    expect(snap("link.txt")).toEqual(blind);
  });
});
