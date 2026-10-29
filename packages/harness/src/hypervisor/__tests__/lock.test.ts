import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isLifetimeLockHeld, LifetimeLock, lockPathFor } from "../index.js";
import { pidAlive, waitUntil } from "../util.js";

const supervisedChild = fileURLToPath(new URL("../../../dist/hypervisor/supervised-child.js", import.meta.url));
const orphanParent = fileURLToPath(new URL("fixtures/orphan-parent.mjs", import.meta.url));

const scratches: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  for (const root of scratches.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function scratch(): string {
  const root = mkdtempSync("/tmp/harness-hv-");
  scratches.push(root);
  return root;
}

function track(child: ChildProcess): ChildProcess {
  children.push(child);
  return child;
}

function spawnLockChild(lockPath: string, extraArgs: string[] = []): ChildProcess {
  return track(
    spawn(
      process.execPath,
      [supervisedChild, "--lock-path", lockPath, "--lock-kind", "runtime", "--role", "runtime", ...extraArgs],
      { stdio: ["pipe", "pipe", "inherit"] },
    ),
  );
}

describe("lifetime lock", () => {
  it("lets one process take the lock and refuses a second owner", async () => {
    const path = lockPathFor(scratch(), "runtime");
    const first = spawnLockChild(path);
    await waitUntil("first lock", () => isLifetimeLockHeld(path), 5_000);
    expect(first.pid).toBeDefined();

    const second = spawnLockChild(path);
    const code = await new Promise<number | null>((resolve) => {
      second.once("exit", (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(1);
    expect(await isLifetimeLockHeld(path)).toBe(true);
    expect(pidAlive(first.pid ?? 0)).toBe(true);

    first.kill("SIGKILL");
    await waitUntil("first lock release", async () => !(await isLifetimeLockHeld(path)), 5_000);

    const third = spawnLockChild(path);
    await waitUntil("third lock", () => isLifetimeLockHeld(path), 5_000);
    expect(pidAlive(third.pid ?? 0)).toBe(true);
  });

  it("does not free a live child's lock when the parent dies", async () => {
    const root = scratch();
    const path = lockPathFor(root, "runtime");
    const pidFile = join(root, "pids");
    const parent = track(
      spawn(
        process.execPath,
        [
          orphanParent,
          supervisedChild,
          "--lock-path",
          path,
          "--lock-kind",
          "runtime",
          "--role",
          "runtime",
          "--ignore-parent-loss",
        ],
        {
          env: { ...process.env, HARNESS_PID_FILE: pidFile },
          stdio: "ignore",
        },
      ),
    );

    await waitUntil("child lock after parent spawn", () => isLifetimeLockHeld(path), 5_000);
    await waitUntil(
      "pid file",
      () => {
        try {
          return Number(readFileSync(pidFile, "utf8").trim()) > 0;
        } catch {
          return false;
        }
      },
      5_000,
    );
    const childPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pidAlive(parent.pid ?? 0)).toBe(true);
    expect(pidAlive(childPid)).toBe(true);

    process.kill(parent.pid ?? 0, "SIGKILL");
    await waitUntil("parent dead", () => !pidAlive(parent.pid ?? 0), 5_000);
    expect(pidAlive(childPid)).toBe(true);
    expect(await isLifetimeLockHeld(path)).toBe(true);

    const steal = await LifetimeLock.tryAcquire(path, "runtime");
    expect(steal).toBeNull();

    process.kill(childPid, "SIGKILL");
    await waitUntil("orphan lock release", async () => !(await isLifetimeLockHeld(path)), 5_000);
    const taken = await LifetimeLock.tryAcquire(path, "runtime");
    expect(taken).not.toBeNull();
    await taken?.release();
  });

  it("lets only one owner reclaim a leftover socket", async () => {
    const path = lockPathFor(scratch(), "root");
    const holder = spawnLockChild(path);
    await waitUntil("holder lock", () => isLifetimeLockHeld(path), 5_000);
    const pid = holder.pid ?? 0;
    process.kill(pid, "SIGKILL");
    await waitUntil("holder dead", () => !pidAlive(pid), 5_000);
    expect(existsSync(path)).toBe(true);
    expect(await isLifetimeLockHeld(path)).toBe(false);

    const [first, second] = await Promise.all([
      LifetimeLock.tryAcquire(path, "root"),
      LifetimeLock.tryAcquire(path, "root"),
    ]);
    const owners = [first, second].filter((lock) => lock !== null);
    expect(owners).toHaveLength(1);
    expect(await isLifetimeLockHeld(path)).toBe(true);
    const steal = await LifetimeLock.tryAcquire(path, "root");
    expect(steal).toBeNull();
    await owners[0]?.release();
  });
});
