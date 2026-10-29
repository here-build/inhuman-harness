import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverInstructions } from "../index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "instructions-")));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  return root;
}

function file(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("discoverInstructions", () => {
  it("loads both families in one directory, agents before claude", () => {
    const root = repo();
    file(join(root, "AGENTS.md"), "agents");
    file(join(root, "CLAUDE.md"), "claude");
    file(join(root, "CLAUDE.local.md"), "local");

    expect(discoverInstructions(root).map((source) => source.text)).toEqual(["agents", "claude", "local"]);
  });

  it("lets an override replace agents and .claude/CLAUDE.md replace the root file", () => {
    const root = repo();
    file(join(root, "AGENTS.override.md"), "override");
    file(join(root, "AGENTS.md"), "agents");
    file(join(root, ".claude", "CLAUDE.md"), "nested");
    file(join(root, "CLAUDE.md"), "root claude");

    expect(discoverInstructions(root).map((source) => source.text)).toEqual(["override", "nested"]);
  });

  it("walks from the git root down to the working directory", () => {
    const root = repo();
    file(join(root, "AGENTS.md"), "root");
    file(join(root, "pkg", "AGENTS.md"), "pkg");
    file(join(root, "pkg", "deep", "CLAUDE.md"), "deep");
    file(join(root, "other", "AGENTS.md"), "other");

    const found = discoverInstructions(join(root, "pkg", "deep"));
    expect(found.map((source) => source.text)).toEqual(["root", "pkg", "deep"]);
  });

  it("follows a symlinked checkout back to the git root", () => {
    const root = repo();
    file(join(root, "AGENTS.md"), "root");
    file(join(root, "pkg", "CLAUDE.md"), "pkg");
    const link = mkdtempSync(join(tmpdir(), "instructions-link-"));
    roots.push(link);
    symlinkSync(join(root, "pkg"), join(link, "pkg"));

    expect(discoverInstructions(join(link, "pkg")).map((source) => source.text)).toEqual(["root", "pkg"]);
  });

  it("stops once the combined text reaches 32 KiB", () => {
    const root = repo();
    file(join(root, "AGENTS.md"), "a".repeat(20_000));
    file(join(root, "CLAUDE.md"), "b".repeat(20_000));
    file(join(root, "CLAUDE.local.md"), "local");

    const found = discoverInstructions(root);
    expect(found).toHaveLength(2);
    expect(found[1]?.text.endsWith("…[truncated]")).toBe(true);
    expect(found.some((source) => source.text === "local")).toBe(false);
  });

  it("skips empty and unreadable names without failing", () => {
    const root = repo();
    file(join(root, "AGENTS.md"), "   \n");
    file(join(root, "CLAUDE.md"), "kept");

    expect(discoverInstructions(root).map((source) => source.text)).toEqual(["kept"]);
  });
});
