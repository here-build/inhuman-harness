import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { RestartPolicy } from "@/protocol/schemas";
import { isExecutionReady, isSyncReady, shutdownFlushFailed, shutdownIsComplete } from "@/protocol/supervision";

import { Hypervisor, isLifetimeLockHeld, LockHeldError, lockPathFor, ReplacementRefusedError } from "../index.js";
import { pidAlive, sleep, waitUntil } from "../util.js";

const supervisedChild = fileURLToPath(new URL("../../../dist/hypervisor/supervised-child.js", import.meta.url));
const readyOnce = fileURLToPath(new URL("fixtures/ready-once.mjs", import.meta.url));

const never = { mode: "never" as const, maxAttempts: 0, backoffMs: 0 };
const onFailure = {
  mode: "on-failure" as const,
  maxAttempts: 3,
  backoffMs: 50,
};
const always = { mode: "always" as const, maxAttempts: 3, backoffMs: 50 };

const scratches: string[] = [];
const running: Hypervisor[] = [];

afterEach(async () => {
  for (const hv of running.splice(0)) {
    await hv.shutdown({ deadlineMs: 3_000 }).catch(() => undefined);
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

function roster(
  rootFlags: string[] = [],
  runtimeFlags: string[] = [],
  restart: RestartPolicy = never,
  runtimeRestart: RestartPolicy = restart,
) {
  return {
    servers: [
      {
        id: "yjs",
        role: "yjs" as const,
        executable: process.execPath,
        args: [supervisedChild, ...rootFlags],
        requires: [] as string[],
        restart,
      },
      {
        id: "runtime",
        role: "runtime" as const,
        executable: process.execPath,
        args: [supervisedChild, ...runtimeFlags],
        requires: ["yjs"],
        restart: runtimeRestart,
      },
    ],
  };
}

async function start(root: string, extra = roster(), readyTimeoutMs = 5_000): Promise<Hypervisor> {
  const hv = await Hypervisor.start({
    root,
    serverRoster: extra,
    hypervisorId: "hv-test",
    readyTimeoutMs,
  });
  running.push(hv);
  return hv;
}

describe("descriptors and readiness", () => {
  it("starts from F3 descriptors and keeps sync ready independent of execution", async () => {
    const hv = await start(scratch());
    const health = hv.health();
    expect(isSyncReady(health)).toBe(true);
    expect(isExecutionReady(health)).toBe(true);
    expect(health.sync.state).toBe("ready");
    expect(health.execution.state).toBe("ready");
    const ids = hv.snapshot().map((child) => child.id);
    expect(ids).toEqual(["yjs", "runtime"]);
    expect(hv.snapshot().find((child) => child.id === "runtime")?.identity.hypervisor.id).toBe("hv-test");
  });

  it("does not admit a runtime before its yjs readiness dependency", async () => {
    const root = scratch();
    await expect(start(root, roster(["--unready"], [], never), 400)).rejects.toThrow(/timeout waiting for yjs ready/);
  });

  it("records exit when a child dies before ready", async () => {
    const root = scratch();
    await expect(
      Hypervisor.start({
        root,
        serverRoster: {
          servers: [
            {
              id: "yjs",
              role: "yjs",
              executable: process.execPath,
              args: ["-e", "process.exit(1)"],
              requires: [],
              restart: never,
            },
          ],
        },
        readyTimeoutMs: 5_000,
      }),
    ).rejects.toThrow(/exited before ready/);
  });

  it("refuses a second hypervisor on the same root lock", async () => {
    const root = scratch();
    await start(root);
    await expect(Hypervisor.start({ root, serverRoster: roster(), readyTimeoutMs: 5_000 })).rejects.toBeInstanceOf(
      LockHeldError,
    );
  });

  it("lets only one hypervisor reclaim a leftover root socket", async () => {
    const root = scratch();
    const sock = lockPathFor(root, "root");
    const holder = spawn(
      process.execPath,
      [supervisedChild, "--lock-path", sock, "--lock-kind", "root", "--role", "runtime"],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    await waitUntil("holder root lock", () => isLifetimeLockHeld(sock), 5_000);
    const pid = holder.pid ?? 0;
    process.kill(pid, "SIGKILL");
    await waitUntil("holder dead", () => !pidAlive(pid), 5_000);
    expect(existsSync(sock)).toBe(true);

    const results = await Promise.allSettled([
      Hypervisor.start({
        root,
        serverRoster: roster(),
        hypervisorId: "hv-a",
        readyTimeoutMs: 5_000,
      }),
      Hypervisor.start({
        root,
        serverRoster: roster(),
        hypervisorId: "hv-b",
        readyTimeoutMs: 5_000,
      }),
    ]);
    const ok = results.flatMap((row) => (row.status === "fulfilled" ? [row.value] : []));
    const bad = results.flatMap((row) => (row.status === "rejected" ? [row.reason] : []));
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toBeInstanceOf(LockHeldError);
    running.push(ok[0]);
  });
});

describe("replacement and child locks", () => {
  it("holds the runtime lock in the child, not the hypervisor, and refuses double owner", async () => {
    const root = scratch();
    const hv = await start(root);
    const runtimeLock = lockPathFor(root, "runtime");
    const rootLock = lockPathFor(root, "root");
    expect(await isLifetimeLockHeld(runtimeLock)).toBe(true);
    expect(await isLifetimeLockHeld(rootLock)).toBe(true);

    const runtime = hv.snapshot().find((child) => child.id === "runtime");
    expect(runtime?.pid).toBeDefined();
    expect(pidAlive(runtime?.pid ?? 0)).toBe(true);

    await expect(hv.replace("runtime")).rejects.toBeInstanceOf(ReplacementRefusedError);
  });

  it("replaces a runtime only after confirmed exit and lock release", async () => {
    const root = scratch();
    const hv = await start(root, roster([], [], never));
    const before = hv.snapshot().find((child) => child.id === "runtime");
    expect(before?.pid).toBeDefined();
    const generation = before?.identity.runtimeGeneration;
    process.kill(before?.pid ?? 0, "SIGKILL");
    await waitUntil(
      "runtime exit",
      () => hv.snapshot().find((child) => child.id === "runtime")?.exit !== undefined,
      5_000,
    );
    await waitUntil("runtime lock free", async () => !(await isLifetimeLockHeld(lockPathFor(root, "runtime"))), 5_000);
    await hv.replace("runtime");
    const after = hv.snapshot().find((child) => child.id === "runtime");
    expect(after?.exit).toBeUndefined();
    expect(after?.pid).not.toBe(before?.pid);
    expect(after?.identity.runtimeGeneration).toBe((generation ?? 0) + 1);
    expect(await isLifetimeLockHeld(lockPathFor(root, "runtime"))).toBe(true);
  });

  it("does not restart runtime while a required yjs plane is down", async () => {
    const hv = await start(scratch(), roster([], [], never, always), 400);
    const yjs = hv.snapshot().find((child) => child.id === "yjs");
    process.kill(yjs?.pid ?? 0, "SIGKILL");
    await waitUntil("yjs down", () => hv.snapshot().find((child) => child.id === "yjs")?.exit !== undefined, 5_000);
    await sleep(600);
    expect(isExecutionReady(hv.health())).toBe(false);
    expect(hv.snapshot().find((child) => child.id === "runtime")?.exit).toBeDefined();
  });

  it("restarts on-failure after the previous lock is released", async () => {
    const root = scratch();
    const hv = await start(root, roster([], [], onFailure));
    const before = hv.snapshot().find((child) => child.id === "runtime");
    process.kill(before?.pid ?? 0, "SIGKILL");
    await waitUntil(
      "runtime restarted",
      () => {
        const now = hv.snapshot().find((child) => child.id === "runtime");
        return (
          now !== undefined &&
          now.exit === undefined &&
          now.pid !== undefined &&
          now.pid !== before?.pid &&
          now.identity.runtimeGeneration === (before?.identity.runtimeGeneration ?? 0) + 1
        );
      },
      8_000,
    );
  });
});

describe("restart policy", () => {
  const runtimeOf = (hv: Hypervisor) => hv.snapshot().find((child) => child.id === "runtime");
  const restartedFrom = async (hv: Hypervisor, pid: number | undefined) =>
    waitUntil(
      "runtime restarted",
      () => {
        const now = runtimeOf(hv);
        return now?.exit === undefined && now?.pid !== undefined && now.pid !== pid && isExecutionReady(hv.health());
      },
      8_000,
    );

  it("a ready restart refills the attempt budget", { timeout: 20_000 }, async () => {
    const hv = await start(scratch(), roster([], [], never, { mode: "on-failure", maxAttempts: 1, backoffMs: 20 }));
    const first = runtimeOf(hv)?.pid;
    process.kill(first ?? 0, "SIGKILL");
    await restartedFrom(hv, first);
    const second = runtimeOf(hv)?.pid;
    process.kill(second ?? 0, "SIGKILL");
    await restartedFrom(hv, second);
  });

  it("a restart that never comes ready is killed and the policy continues", { timeout: 20_000 }, async () => {
    const root = scratch();
    const ready = [readyOnce, join(root, "spawned")];
    const hv = await start(
      root,
      {
        servers: [
          roster().servers[0],
          { ...roster().servers[1], args: ready, restart: { mode: "on-failure", maxAttempts: 2, backoffMs: 20 } },
        ],
      },
      400,
    );
    const first = runtimeOf(hv)?.pid;
    process.kill(first ?? 0, "SIGKILL");
    await waitUntil("restart spawned", () => runtimeOf(hv)?.pid !== undefined && runtimeOf(hv)?.pid !== first, 5_000);
    const hung = runtimeOf(hv)?.pid ?? 0;
    await waitUntil("hung restart killed", () => !pidAlive(hung), 5_000);
    await waitUntil(
      "attempts spent",
      () => runtimeOf(hv)?.exit !== undefined && runtimeOf(hv)?.pid === undefined,
      8_000,
    );
    expect(await isLifetimeLockHeld(lockPathFor(root, "runtime"))).toBe(false);
  });

  it("a restart waiting on its requires does not spawn after shutdown", { timeout: 20_000 }, async () => {
    const hv = await start(scratch(), roster([], [], never, { mode: "always", maxAttempts: 3, backoffMs: 0 }));
    // Hold the restart inside spawnAndWaitReady's awaits while shutdown runs.
    const gate = hv as unknown as { waitForRequires: () => Promise<void> };
    let entered = false;
    gate.waitForRequires = async () => {
      entered = true;
      await sleep(1_500);
    };
    const pid = runtimeOf(hv)?.pid;
    process.kill(pid ?? 0, "SIGKILL");
    await waitUntil("restart waiting", () => entered, 5_000);
    await hv.shutdown({ deadlineMs: 200 });
    await sleep(1_800);
    const after = runtimeOf(hv);
    expect(after?.pid === undefined || !pidAlive(after.pid)).toBe(true);
  });
});

describe("shutdown cutoff", () => {
  it("refuses new admission and completes after drain plus flush", async () => {
    const hv = await start(scratch(), roster([], [], always));
    const cutoff = await hv.shutdown({ deadlineMs: 5_000 });
    expect(hv.admissionState).toBe("refused");
    expect(cutoff.admission).toBe("refused");
    expect(shutdownIsComplete(cutoff)).toBe(true);
    expect(shutdownFlushFailed(cutoff)).toBe(false);
    expect(hv.snapshot().every((child) => child.exit !== undefined)).toBe(true);
    expect(hv.snapshot().some((child) => child.cutoff !== undefined)).toBe(true);
  });

  it("does not treat a missing cutoff as a successful flush", async () => {
    const hv = await start(scratch(), roster([], [], never));
    for (const child of hv.snapshot()) {
      if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
    }
    await waitUntil("children crashed", () => hv.snapshot().every((child) => child.exit !== undefined), 5_000);
    const cutoff = await hv.shutdown({ deadlineMs: 2_000 });
    expect(cutoff.flush).toBe("pending");
    expect(shutdownIsComplete(cutoff)).toBe(false);
  });

  it("keeps a forced pending flush observable", async () => {
    const hv = await start(scratch(), roster([], ["--ignore-shutdown"], never));
    const cutoff = await hv.shutdown({ deadlineMs: 200 });
    expect(cutoff.admission).toBe("refused");
    expect(cutoff.forced).toBe(true);
    expect(shutdownFlushFailed(cutoff)).toBe(true);
  });
});
