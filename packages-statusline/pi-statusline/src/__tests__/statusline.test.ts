import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agentDirectory, readEnabled, register, STATUS_KEY, type PiCtx } from "../index.js";

type Fn = (event: unknown, ctx: PiCtx) => void;

function fakePi() {
  const handlers = new Map<string, Fn[]>();
  const calls: (string | undefined)[] = [];
  const ctx = (cwd: string): PiCtx => ({
    cwd,
    ui: {
      setStatus(key, text) {
        expect(key).toBe(STATUS_KEY);
        calls.push(text);
      },
    },
  });
  return {
    calls,
    ctx,
    pi: {
      on(event: string, handler: Fn) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    },
    emit(event: string, c: PiCtx) {
      for (const h of handlers.get(event) ?? []) h({}, c);
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

describe("statusline-pi", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sl-pi-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("paints the clause, then clears it when the tree is clean", async () => {
    git(dir, "init", "-q");
    writeFileSync(path.join(dir, "a.txt"), "a");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    writeFileSync(path.join(dir, "a.txt"), "b");

    const h = fakePi();
    register(h.pi, { agentDir: path.join(dir, "none"), watch: () => () => {} });
    const c = h.ctx(dir);
    h.emit("session_start", c);
    await settle();
    expect(h.calls.at(-1)).toContain("uncommitted");
    expect(h.calls.at(-1)).not.toContain("\u001f");

    git(dir, "commit", "-aqm", "two");
    h.emit("tool_execution_end", c);
    await settle();
    expect(h.calls.at(-1)).toBeUndefined();
    h.emit("session_shutdown", c);
  });

  it("clears the status on failure", async () => {
    const h = fakePi();
    register(h.pi, {
      agentDir: dir,
      watch: () => () => {},
      run: () => Promise.reject(new Error("boom")),
    });
    h.emit("session_start", h.ctx(dir));
    await settle();
    expect(h.calls).toEqual([undefined]);
  });

  it("never runs two at once and runs once more when dirtied", async () => {
    const h = fakePi();
    let active = 0;
    let peak = 0;
    let started = 0;
    const releases: (() => void)[] = [];
    register(h.pi, {
      agentDir: dir,
      watch: () => () => {},
      run: () => {
        started++;
        active++;
        peak = Math.max(peak, active);
        return new Promise<string>((resolve) => {
          releases.push(() => {
            active--;
            resolve("main\u001fdirty");
          });
        });
      },
    });
    const c = h.ctx(dir);
    h.emit("session_start", c);
    h.emit("tool_execution_end", c);
    h.emit("turn_end", c);
    h.emit("agent_end", c);
    expect(started).toBe(1);
    releases[0]?.();
    await settle();
    expect(started).toBe(2);
    releases[1]?.();
    await settle();
    expect(started).toBe(2);
    expect(peak).toBe(1);
    expect(h.calls).toEqual(["dirty", "dirty"]);
  });

  it("aborts an in-flight run on shutdown and paints nothing", async () => {
    const h = fakePi();
    let signal: AbortSignal | undefined;
    register(h.pi, {
      agentDir: dir,
      watch: () => () => {},
      run: (_cwd, s) => {
        signal = s;
        return new Promise<string>((resolve) => s.addEventListener("abort", () => resolve("m\u001fx")));
      },
    });
    const c = h.ctx(dir);
    h.emit("session_start", c);
    h.emit("session_shutdown", c);
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(h.calls).toEqual([]);
  });

  it("is off when the settings file says so", async () => {
    writeFileSync(path.join(dir, "statusline-pi.json"), '{"enabled":false}');
    const h = fakePi();
    register(h.pi, { agentDir: dir, watch: () => () => {}, run: () => Promise.resolve("m\u001fx") });
    h.emit("session_start", h.ctx(dir));
    await settle();
    expect(h.calls).toEqual([]);
  });

  it("settings helpers", () => {
    expect(readEnabled(undefined)).toBe(true);
    expect(readEnabled("nope")).toBe(true);
    expect(readEnabled('{"enabled":false}')).toBe(false);
    expect(agentDirectory({ PI_CODING_AGENT_DIR: " /x " }, "/h")).toBe("/x");
    expect(agentDirectory({}, "/h")).toBe(path.join("/h", ".pi", "agent"));
  });
});
