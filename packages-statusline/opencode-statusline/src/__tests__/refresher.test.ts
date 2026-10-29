import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRefresher } from "../refresher.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
}

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-statusline-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("createRefresher against a real repo", () => {
  it("is empty when clean and level", async () => {
    const seen: string[] = [];
    const r = createRefresher({ dir: repo(), onChange: (c) => seen.push(c) });
    await r.refresh();
    r.stop();
    expect(r.current()).toBe("");
    expect(seen).toEqual([]);
  });

  it("reports uncommitted changes, then clears them", async () => {
    const dir = repo();
    const r = createRefresher({ dir, onChange: () => undefined });
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    await r.refresh();
    expect(r.current()).toContain("uncommitted");
    git(dir, "commit", "-q", "-am", "next");
    await r.refresh();
    r.stop();
    expect(r.current()).toBe("");
  });

  it("yields empty outside a repository", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oc-statusline-none-"));
    dirs.push(dir);
    const r = createRefresher({ dir, onChange: () => undefined });
    await r.refresh();
    r.stop();
    expect(r.current()).toBe("");
  });

  it("refreshes on file changes under .git", async () => {
    const dir = repo();
    const seen: string[] = [];
    const r = createRefresher({ dir, debounceMs: 20, onChange: (c) => seen.push(c) });
    writeFileSync(path.join(dir, "b.txt"), "x\n");
    git(dir, "add", "b.txt");
    await new Promise((resolve) => setTimeout(resolve, 600));
    r.stop();
    expect(seen.some((c) => c.includes("uncommitted") || c.includes("staged"))).toBe(true);
  });
});

describe("coalescing", () => {
  it("never runs twice at once and reruns exactly once for mid-flight requests", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let release!: () => void;
    const gate = () => new Promise<void>((resolve) => (release = resolve));
    const r = createRefresher({
      dir: "/nonexistent-dir-for-test",
      onChange: () => undefined,
      run: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        calls++;
        if (calls === 1) await gate();
        active--;
        return `run${calls}`;
      },
    });
    const first = r.refresh();
    void r.refresh();
    void r.refresh();
    await Promise.resolve();
    release();
    await first;
    r.stop();
    expect(maxActive).toBe(1);
    expect(calls).toBe(2);
    expect(r.current()).toBe("run2");
  });

  it("maps a failing run to empty", async () => {
    const r = createRefresher({
      dir: "/x",
      onChange: () => undefined,
      run: async () => {
        throw new Error("boom");
      },
    });
    await r.refresh();
    r.stop();
    expect(r.current()).toBe("");
  });
});
