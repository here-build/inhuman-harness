/* eslint-disable security/detect-non-literal-fs-filename -- temp dirs */
/* eslint-disable no-secrets/no-secrets -- generated parent script env names */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@inhuman.tools/harness-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  Hypervisor,
  isLifetimeLockHeld,
  LifetimeLock,
  LockHeldError,
  lockPathFor,
  ReplacementRefusedError,
} from "@/hypervisor";
import { isExecutionReady, isSyncReady, shutdownFlushFailed, shutdownIsComplete } from "@/protocol/supervision";

import { productBins, productRoster } from "../composition.js";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = join(srcRoot, "../../..");
const scratches: string[] = [];
const running: Hypervisor[] = [];
const orphans: number[] = [];

const never = { mode: "never" as const, maxAttempts: 0, backoffMs: 0 };

afterEach(async () => {
  for (const hv of running.splice(0)) {
    await hv.shutdown({ deadlineMs: 3_000 }).catch(() => undefined);
  }
  const leftover = orphans.splice(0);
  for (const pid of leftover) {
    if (pid <= 0) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  const deadline = Date.now() + 2_000;
  while (leftover.some((pid) => pidAlive(pid)) && Date.now() < deadline) {
    await delay(20);
  }
  for (const root of scratches.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function ensureDist(pkg: string, file: string): string {
  const dist = join(workspace, pkg, "dist", file);
  if (!existsSync(dist)) {
    execFileSync("pnpm", ["exec", "tsc", "-p", "tsconfig.build.json"], {
      cwd: join(workspace, pkg),
      stdio: "pipe",
    });
  }
  return dist;
}

function binsReady() {
  ensureDist("harness", "hypervisor/index.js");
  ensureDist("harness", "server/bin.js");
  return productBins();
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

async function waitUntil(label: string, pred: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await delay(20);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function scratch(): string {
  const root = realpathSync(mkdtempSync("/tmp/harness-product-"));
  scratches.push(root);
  return root;
}

function neverRoster() {
  return {
    servers: productRoster(binsReady()).servers.map((server) => ({
      ...server,
      restart: never,
    })),
  };
}

async function startProduct(root: string, hypervisorId = "hv-product"): Promise<Hypervisor> {
  const hv = await Hypervisor.start({
    root,
    serverRoster: neverRoster(),
    hypervisorId,
    readyTimeoutMs: 10_000,
  });
  running.push(hv);
  return hv;
}

function childOf(hv: Hypervisor, id: string) {
  const row = hv.snapshot().find((entry) => entry.id === id);
  if (row === undefined) throw new Error(`missing child ${id}`);
  return row;
}

function trackPid(pid: number | undefined): void {
  if (pid == null || pid <= 0) return;
  if (!orphans.includes(pid)) orphans.push(pid);
}

function childPidsOf(parentPid: number): number[] {
  try {
    const out = execFileSync("pgrep", ["-P", String(parentPid)], {
      encoding: "utf8",
    }).trim();
    if (out === "") return [];
    return out
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function collectDescendants(parentPid: number, into: number[] = []): number[] {
  for (const child of childPidsOf(parentPid)) {
    if (into.includes(child)) continue;
    into.push(child);
    collectDescendants(child, into);
  }
  return into;
}

function trackDescendants(parentPid: number): void {
  if (parentPid <= 0) return;
  for (const pid of collectDescendants(parentPid)) trackPid(pid);
}

function killPid(pid: number): void {
  if (pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* gone */
  }
}

function killTree(parentPid: number): void {
  for (const pid of collectDescendants(parentPid)) {
    trackPid(pid);
    killPid(pid);
  }
  killPid(parentPid);
}

describe("product topology", () => {
  it("boots hypervisor with SQLite-backed runtime bin; health tracks sync and execution", async () => {
    const bins = binsReady();
    expect(bins.runtime.args[0]).toMatch(/harness[/\\]dist[/\\]server[/\\]bin\.js$/);
    expect(bins.runtime.args.at(-1)).toBe("--supervised");

    const root = scratch();
    const hv = await startProduct(root);

    expect(isSyncReady(hv.health())).toBe(true);
    expect(isExecutionReady(hv.health())).toBe(true);

    const child = hv.snapshot().find((row) => row.id === "runtime");
    expect(child?.pid).toBeDefined();
    process.kill(child?.pid ?? 0, "SIGKILL");
    await waitUntil("runtime exit", () => !isExecutionReady(hv.health()), 5_000);
    expect(isSyncReady(hv.health())).toBe(false);
    expect(isExecutionReady(hv.health())).toBe(false);
  }, 30_000);

  it("restarts a crashed runtime and preserves committed SQLite state", async () => {
    const bins = binsReady();
    const root = scratch();
    const projectDir = scratch();
    const onFailure = {
      mode: "on-failure" as const,
      maxAttempts: 3,
      backoffMs: 50,
    };
    const hv = await Hypervisor.start({
      root,
      serverRoster: {
        servers: productRoster(bins).servers.map((server) => ({
          ...server,
          restart: onFailure,
        })),
      },
      hypervisorId: "hv-product-restart",
      readyTimeoutMs: 10_000,
    });
    running.push(hv);

    let sessionId = "";
    {
      await using client = await Client.start(root, projectDir);
      sessionId = client.sessionId;
      await client.request("kv/set", { key: "persisted", value: "across-sigkill" });
    }

    const before = hv.snapshot().find((row) => row.id === "runtime");
    expect(before?.pid).toBeDefined();
    const generation = before?.identity.runtimeGeneration ?? 0;
    process.kill(before?.pid ?? 0, "SIGKILL");
    await waitUntil(
      "runtime restarted",
      () => {
        const now = hv.snapshot().find((row) => row.id === "runtime");
        return (
          now?.exit === undefined &&
          now?.pid !== undefined &&
          now.pid !== before?.pid &&
          now.identity.runtimeGeneration === generation + 1 &&
          isExecutionReady(hv.health())
        );
      },
      8_000,
    );
    const after = hv.snapshot().find((row) => row.id === "runtime");
    await using restored = await Client.restore(root, sessionId);
    expect({
      sync: isSyncReady(hv.health()),
      execution: isExecutionReady(hv.health()),
      generation: after?.identity.runtimeGeneration,
      replaced: after?.pid !== before?.pid,
      persisted: restored.sessionRoot.kvs.persisted,
    }).toEqual({
      sync: true,
      execution: true,
      generation: generation + 1,
      replaced: true,
      persisted: "across-sigkill",
    });
  }, 30_000);
});

describe("process failure matrix", () => {
  it("runtime replacement succeeds only after exit and lock release; no two owners", async () => {
    const root = scratch();
    const hv = await startProduct(root);
    const runtimeLock = lockPathFor(root, "runtime");
    expect(await isLifetimeLockHeld(runtimeLock)).toBe(true);
    expect(isSyncReady(hv.health())).toBe(true);
    await expect(hv.replace("runtime")).rejects.toBeInstanceOf(ReplacementRefusedError);

    const before = childOf(hv, "runtime");
    expect(before.pid).toBeDefined();
    process.kill(before.pid ?? 0, "SIGKILL");
    await waitUntil("runtime exit", () => childOf(hv, "runtime").exit !== undefined, 5_000);
    await waitUntil("runtime lock free", async () => !(await isLifetimeLockHeld(runtimeLock)), 5_000);
    expect(isSyncReady(hv.health())).toBe(false);
    expect(isExecutionReady(hv.health())).toBe(false);

    const results = await Promise.allSettled([hv.replace("runtime"), hv.replace("runtime")]);
    const ok = results.filter((row) => row.status === "fulfilled");
    const bad = results.flatMap((row) => (row.status === "rejected" ? [row.reason] : []));
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toBeInstanceOf(ReplacementRefusedError);

    const after = childOf(hv, "runtime");
    expect({
      sync: isSyncReady(hv.health()),
      execution: isExecutionReady(hv.health()),
      replaced: after.pid !== before.pid,
      generation: after.identity.runtimeGeneration,
      live: hv
        .snapshot()
        .filter((row) => row.id === "runtime" && row.exit === undefined)
        .map((row) => row.pid),
      lock: await isLifetimeLockHeld(runtimeLock),
    }).toEqual({
      sync: true,
      execution: true,
      replaced: true,
      generation: before.identity.runtimeGeneration + 1,
      live: [after.pid],
      lock: true,
    });
  }, 30_000);

  it("hypervisor death does not free a live child's lock", async () => {
    const root = scratch();
    const bins = binsReady();
    const runtimeBin = bins.runtime.args[0];
    if (runtimeBin == null) {
      throw new Error("product runtime bin missing");
    }
    const pidFile = join(root, "hv.json");
    const script = join(root, "hv-parent.mjs");
    // Children otherwise shut down on stdin EOF, which would release the lock
    // and hide the parent-death invariant.
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";
import { Hypervisor } from ${JSON.stringify(pathToFileURL(ensureDist("harness", "hypervisor/index.js")).href)};
import { productRoster } from ${JSON.stringify(pathToFileURL(ensureDist("harness", "server/composition.js")).href)};

const root = process.env.HARNESS_ROOT;
const pidFile = process.env.HARNESS_PID_FILE;
const runtimeBin = process.env.HARNESS_RUNTIME_BIN;
if (root == null || pidFile == null || runtimeBin == null) {
  throw new Error("hypervisor parent env missing");
}
const never = { mode: "never", maxAttempts: 0, backoffMs: 0 };
const bins = {
  runtime: {
    executable: process.execPath,
    args: [runtimeBin, "--supervised", "--ignore-parent-loss"],
  },
};
const hv = await Hypervisor.start({
  root,
  serverRoster: {
    servers: productRoster(bins).servers.map((server) => ({
      ...server,
      restart: never,
    })),
  },
  hypervisorId: "hv-orphan",
  readyTimeoutMs: 10_000,
});
writeFileSync(
  pidFile,
  JSON.stringify({
    pid: process.pid,
    children: hv.snapshot().map((child) => ({ id: child.id, pid: child.pid })),
  }),
);
await new Promise(() => {});
`,
    );
    const parent = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        HARNESS_ROOT: root,
        HARNESS_PID_FILE: pidFile,
        HARNESS_RUNTIME_BIN: runtimeBin,
      },
      stdio: ["ignore", "ignore", "inherit"],
    });
    trackPid(parent.pid);
    try {
      await waitUntil(
        "hypervisor pid file",
        () => {
          if (parent.pid != null) trackDescendants(parent.pid);
          return existsSync(pidFile);
        },
        15_000,
      );
    } catch (error) {
      if (parent.pid != null) killTree(parent.pid);
      throw error;
    }
    if (parent.pid != null) trackDescendants(parent.pid);
    const snap = JSON.parse(readFileSync(pidFile, "utf8")) as {
      pid: number;
      children: Array<{ id: string; pid?: number }>;
    };
    trackPid(snap.pid);
    for (const child of snap.children) trackPid(child.pid);
    const runtimePid = snap.children.find((child) => child.id === "runtime")?.pid ?? 0;
    const runtimeLock = lockPathFor(root, "runtime");
    expect(pidAlive(snap.pid)).toBe(true);
    expect(runtimePid).toBeGreaterThan(0);
    expect(pidAlive(runtimePid)).toBe(true);
    expect(await isLifetimeLockHeld(runtimeLock)).toBe(true);

    killPid(snap.pid);
    await waitUntil("hypervisor dead", () => !pidAlive(snap.pid), 5_000);
    expect(pidAlive(runtimePid)).toBe(true);
    expect(await isLifetimeLockHeld(runtimeLock)).toBe(true);
    expect(await LifetimeLock.tryAcquire(runtimeLock, "runtime")).toBeNull();

    killPid(runtimePid);
    await waitUntil("orphan runtime lock release", async () => !(await isLifetimeLockHeld(runtimeLock)), 5_000);
    const taken = await LifetimeLock.tryAcquire(runtimeLock, "runtime");
    expect(taken).not.toBeNull();
    await taken?.release();
  }, 45_000);

  it("shutdown cutoff refuses admission and keeps flush pending/failed/ok visible", async () => {
    const graceful = await startProduct(scratch(), "hv-product-stop");
    const cutoff = await graceful.shutdown({ deadlineMs: 5_000 });
    expect(graceful.admissionState).toBe("refused");
    expect(cutoff.admission).toBe("refused");
    expect(cutoff.flush).toBe("ok");
    expect(shutdownIsComplete(cutoff)).toBe(true);
    expect(shutdownFlushFailed(cutoff)).toBe(false);
    expect(graceful.snapshot().every((child) => child.exit !== undefined)).toBe(true);
    await expect(graceful.replace("runtime")).rejects.toThrow(/admission refused/);

    const crashed = await startProduct(scratch(), "hv-product-kill");
    for (const child of crashed.snapshot()) {
      if (child.pid !== undefined) process.kill(child.pid, "SIGKILL");
    }
    await waitUntil("children crashed", () => crashed.snapshot().every((child) => child.exit !== undefined), 5_000);
    const missing = await crashed.shutdown({ deadlineMs: 2_000 });
    expect(missing.admission).toBe("refused");
    expect(missing.flush).toBe("pending");
    expect(shutdownIsComplete(missing)).toBe(false);
    expect(shutdownFlushFailed(missing)).toBe(missing.forced);
  }, 45_000);

  it("concurrent ensure does not double-own", async () => {
    const root = scratch();
    const roster = neverRoster();
    const results = await Promise.allSettled([
      Hypervisor.start({
        root,
        serverRoster: roster,
        hypervisorId: "hv-a",
        readyTimeoutMs: 10_000,
      }),
      Hypervisor.start({
        root,
        serverRoster: roster,
        hypervisorId: "hv-b",
        readyTimeoutMs: 10_000,
      }),
    ]);
    const ok = results.flatMap((row) => (row.status === "fulfilled" ? [row.value] : []));
    const bad = results.flatMap((row) => (row.status === "rejected" ? [row.reason] : []));
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toBeInstanceOf(LockHeldError);
    running.push(ok[0]);
    expect(isSyncReady(ok[0].health())).toBe(true);
    expect(isExecutionReady(ok[0].health())).toBe(true);
    expect(ok[0].snapshot().filter((row) => row.id === "runtime" && row.exit === undefined)).toHaveLength(1);
  }, 30_000);
});
