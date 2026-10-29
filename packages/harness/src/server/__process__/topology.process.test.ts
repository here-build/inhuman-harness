/* eslint-disable security/detect-non-literal-fs-filename -- temp dirs */
/* eslint-disable no-secrets/no-secrets -- generated parent script env names */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BotCallJob, SessionSystemPrompt, SessionTurn } from "@inhuman.tools/harness-model";
import { joinReleased } from "@inhuman.tools/turn/agent-calls";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { openDriverRegistry } from "@/connections";
import {
  Hypervisor,
  isLifetimeLockHeld,
  LifetimeLock,
  LockHeldError,
  lockPathFor,
  ReplacementRefusedError,
} from "@/hypervisor";
import { documentKey, receiptCoversCheckpoint } from "@/protocol/document";
import type { SupervisionIdentity } from "@/protocol/schemas";
import { isExecutionReady, isSyncReady, shutdownFlushFailed, shutdownIsComplete } from "@/protocol/supervision";
import { RuntimeServer } from "@/runtime-server";
import { KernelToolCatalog, type CatalogEntry } from "@/tool-catalog";
import { connectRemoteDocument, wrapWebSocket } from "@/yjs";

import { PRODUCT_PROVIDERS, productBins, productRoster } from "../composition.js";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = join(srcRoot, "../../..");
const scratches: string[] = [];
const running: Hypervisor[] = [];
const orphans: number[] = [];
const sockets: WebSocket[] = [];

const never = { mode: "never" as const, maxAttempts: 0, backoffMs: 0 };
const PEER_CAPABILITY = "product";

afterEach(async () => {
  for (const hv of running.splice(0)) {
    await hv.shutdown({ deadlineMs: 3_000 }).catch(() => undefined);
  }
  for (const ws of sockets.splice(0)) {
    try {
      ws.close();
    } catch {
      /* gone */
    }
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
  ensureDist("harness", "yjs/bin.js");
  ensureDist("harness", "server/runtime-bin.js");
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
  const root = mkdtempSync("/tmp/harness-product-");
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

async function connectPeer(
  root: string,
  identity: SupervisionIdentity,
): Promise<Awaited<ReturnType<typeof connectRemoteDocument>>> {
  const sock = join(root, "private-peer.sock");
  await waitUntil("private peer sock", () => existsSync(sock), 5_000);
  const ws = new WebSocket(`ws+unix://${sock}:/`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.close();
      reject(new Error("timeout waiting for peer socket"));
    }, 5_000);
    const onOpen = (): void => {
      clearTimeout(timer);
      ws.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      reject(error);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
  ws.on("error", () => undefined);
  const connected = await connectRemoteDocument(wrapWebSocket(ws), {
    capability: PEER_CAPABILITY,
    identity,
  });
  if (!connected.ok) ws.close();
  return connected;
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

/** Lock release is not hub detach; busy means the dead runtime socket is still the owner. */
async function waitForPeerVacancy(root: string, identity: SupervisionIdentity): Promise<void> {
  await waitUntil(
    "peer hub vacant",
    async () => {
      const probe = await connectPeer(root, {
        ...identity,
        process: { kind: "runtime", id: "probe-wait" },
      });
      if (!probe.ok) return probe.reason !== "busy";
      probe.adapter[Symbol.dispose]();
      const ws = sockets.at(-1);
      if (ws != null) {
        await waitUntil("throwaway peer closed", () => ws.readyState === WebSocket.CLOSED, 5_000);
      }
      await delay(20);
      return true;
    },
    8_000,
  );
}

describe("product topology", () => {
  it("boots hypervisor with yjs + runtime bins; health distinguishes sync vs execution", async () => {
    ensureDist("harness", "hypervisor/index.js");
    ensureDist("harness", "yjs/bin.js");
    ensureDist("harness", "server/runtime-bin.js");
    const bins = productBins();
    expect(bins.yjs.args.at(-1)).toMatch(/harness[/\\]dist[/\\]yjs[/\\]bin\.js$/);
    expect(bins.runtime.args.at(-1)).toMatch(/harness[/\\]dist[/\\]server[/\\]runtime-bin\.js$/);

    const root = mkdtempSync("/tmp/harness-product-");
    scratches.push(root);
    const hv = await Hypervisor.start({
      root,
      serverRoster: {
        servers: productRoster(bins).servers.map((server) => ({
          ...server,
          restart: never,
        })),
      },
      hypervisorId: "hv-product",
      readyTimeoutMs: 10_000,
    });
    running.push(hv);

    expect(isSyncReady(hv.health())).toBe(true);
    expect(isExecutionReady(hv.health())).toBe(true);

    const child = hv.snapshot().find((row) => row.id === "runtime");
    expect(child?.pid).toBeDefined();
    process.kill(child?.pid ?? 0, "SIGKILL");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!isExecutionReady(hv.health())) break;
      await delay(20);
    }
    expect(isSyncReady(hv.health())).toBe(true);
    expect(isExecutionReady(hv.health())).toBe(false);
  }, 30_000);

  it("reconnects a restarted runtime to the live yjs hub", async () => {
    ensureDist("harness", "hypervisor/index.js");
    ensureDist("harness", "yjs/bin.js");
    ensureDist("harness", "server/runtime-bin.js");
    const bins = productBins();
    const root = mkdtempSync("/tmp/harness-product-");
    scratches.push(root);
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
          restart: server.role === "runtime" ? onFailure : never,
        })),
      },
      hypervisorId: "hv-product-restart",
      readyTimeoutMs: 10_000,
    });
    running.push(hv);
    const before = hv.snapshot().find((row) => row.id === "runtime");
    expect(before?.pid).toBeDefined();
    const generation = before?.identity.runtimeGeneration ?? 0;
    process.kill(before?.pid ?? 0, "SIGKILL");
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const now = hv.snapshot().find((row) => row.id === "runtime");
      if (
        now?.exit === undefined &&
        now?.pid !== undefined &&
        now.pid !== before?.pid &&
        now.identity.runtimeGeneration === generation + 1 &&
        isExecutionReady(hv.health())
      ) {
        break;
      }
      await delay(20);
    }
    const after = hv.snapshot().find((row) => row.id === "runtime");
    expect({
      sync: isSyncReady(hv.health()),
      execution: isExecutionReady(hv.health()),
      generation: after?.identity.runtimeGeneration,
      replaced: after?.pid !== before?.pid,
    }).toEqual({
      sync: true,
      execution: true,
      generation: generation + 1,
      replaced: true,
    });
  }, 30_000);
});

describe("process failure matrix", () => {
  it("runtime death keeps sync; replace only after exit and lock release; no two owners", async () => {
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
    expect(isSyncReady(hv.health())).toBe(true);
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
      live: hv
        .snapshot()
        .filter((row) => row.id === "runtime" && row.exit === undefined)
        .map((row) => row.pid),
      lock: await isLifetimeLockHeld(runtimeLock),
    }).toEqual({
      sync: true,
      execution: true,
      replaced: true,
      live: [after.pid],
      lock: true,
    });
  }, 30_000);

  it("yjs death does not leave the old runtime as a second writer; replacement is explicit", async () => {
    const root = scratch();
    const hv = await startProduct(root, "hv-product-yjs");
    const yjs = childOf(hv, "yjs");
    const runtime = childOf(hv, "runtime");
    const epoch = yjs.identity.serverEpoch;
    const generation = runtime.identity.runtimeGeneration;
    process.kill(yjs.pid ?? 0, "SIGKILL");
    await waitUntil("yjs exit", () => childOf(hv, "yjs").exit !== undefined, 5_000);
    await waitUntil("runtime exit after yjs loss", () => childOf(hv, "runtime").exit !== undefined, 8_000);
    await waitUntil(
      "runtime lock free after yjs loss",
      async () => !(await isLifetimeLockHeld(lockPathFor(root, "runtime"))),
      5_000,
    );
    expect(pidAlive(runtime.pid ?? 0)).toBe(false);
    expect(isSyncReady(hv.health())).toBe(false);
    expect(isExecutionReady(hv.health())).toBe(false);
    await delay(300);
    expect(childOf(hv, "yjs").exit).toBeDefined();
    expect(childOf(hv, "runtime").exit).toBeDefined();

    await hv.replace("yjs");
    expect(isSyncReady(hv.health())).toBe(true);
    const yjs2 = childOf(hv, "yjs");
    expect(yjs2.pid).not.toBe(yjs.pid);
    expect(yjs2.identity.serverEpoch).toBe(epoch + 1);

    const staleEpoch = await connectPeer(root, {
      ...runtime.identity,
      serverEpoch: epoch,
      process: { kind: "runtime", id: "probe-stale-epoch" },
    });
    expect(staleEpoch).toEqual({ ok: false, reason: "stale" });

    await hv.replace("runtime");
    expect(isExecutionReady(hv.health())).toBe(true);
    const runtime2 = childOf(hv, "runtime");
    expect(runtime2.identity.runtimeGeneration).toBe(generation + 1);
    expect(runtime2.pid).not.toBe(runtime.pid);
    expect(hv.snapshot().filter((row) => row.id === "runtime" && row.exit === undefined)).toHaveLength(1);

    const staleGen = await connectPeer(root, {
      ...runtime2.identity,
      runtimeGeneration: generation,
      process: { kind: "runtime", id: "probe-stale-gen" },
    });
    expect(staleGen).toEqual({ ok: false, reason: "stale" });
  }, 45_000);

  it("hypervisor death does not free a live child's lock", async () => {
    const root = scratch();
    const bins = binsReady();
    const yjsBin = bins.yjs.args.at(-1);
    const runtimeBin = bins.runtime.args.at(-1);
    if (yjsBin == null || runtimeBin == null) {
      throw new Error("product bins missing");
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
const yjsBin = process.env.HARNESS_YJS_BIN;
const runtimeBin = process.env.HARNESS_RUNTIME_BIN;
if (root == null || pidFile == null || yjsBin == null || runtimeBin == null) {
  throw new Error("hypervisor parent env missing");
}
const never = { mode: "never", maxAttempts: 0, backoffMs: 0 };
const bins = {
  yjs: { executable: process.execPath, args: [yjsBin, "--ignore-parent-loss"] },
  runtime: {
    executable: process.execPath,
    args: [runtimeBin, "--ignore-parent-loss"],
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
        HARNESS_YJS_BIN: yjsBin,
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
    const yjsPid = snap.children.find((child) => child.id === "yjs")?.pid ?? 0;
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
    killPid(yjsPid);
    await waitUntil("orphan runtime lock release", async () => !(await isLifetimeLockHeld(runtimeLock)), 5_000);
    const taken = await LifetimeLock.tryAcquire(runtimeLock, "runtime");
    expect(taken).not.toBeNull();
    await taken?.release();
  }, 45_000);

  it("stale epoch/receipt is not dispatch; concurrent reconnect does not double-own", async () => {
    const root = scratch();
    const hv = await startProduct(root, "hv-product-peer");
    const runtime = childOf(hv, "runtime");
    process.kill(runtime.pid ?? 0, "SIGKILL");
    await waitUntil("runtime exit for peer", () => childOf(hv, "runtime").exit !== undefined, 5_000);
    await waitUntil(
      "runtime lock free for peer",
      async () => !(await isLifetimeLockHeld(lockPathFor(root, "runtime"))),
      5_000,
    );
    expect(isSyncReady(hv.health())).toBe(true);

    const base = runtime.identity;
    await waitForPeerVacancy(root, base);
    const raced = await Promise.all([
      connectPeer(root, {
        ...base,
        process: { kind: "runtime", id: "probe-a" },
      }),
      connectPeer(root, {
        ...base,
        process: { kind: "runtime", id: "probe-b" },
      }),
    ]);
    const owners = raced.filter((row) => row.ok);
    const refused = raced.filter((row) => !row.ok);
    expect(owners).toHaveLength(1);
    expect(refused).toEqual([{ ok: false, reason: "busy" }]);
    for (const row of owners) {
      row.adapter[Symbol.dispose]();
    }
    await waitForPeerVacancy(root, base);

    const staleHello = await connectPeer(root, {
      ...base,
      runtimeGeneration: Math.max(0, base.runtimeGeneration - 1),
    });
    expect(staleHello).toEqual({ ok: false, reason: "stale" });

    const first = await connectPeer(root, base);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const catalog = new KernelToolCatalog();
    catalog.replacePack([
      {
        wireName: "offload",
        description: "offload",
        parameters: { type: "object", properties: {} },
        class: "effect",
        source: { kind: "pack", pluginName: "pack" },
        packMeta: {
          kind: "bot-call",
          pluginName: "pack",
          target: "worker",
          background: true,
          lifetime: "call",
          show: "result",
          supportsNotify: false,
        },
      } satisfies CatalogEntry,
    ]);
    const server = new RuntimeServer({
      adapter: first.adapter,
      registry: openDriverRegistry(PRODUCT_PROVIDERS),
      catalog,
    });
    server.bind({ connections: {}, drivers: {} });
    const session = await server.acquireSession("s1");
    const call = new BotCallJob({
      name: "offload",
      background: true,
      orchestrationResult: true,
      acceptedAt: 1,
      preparedInputJson: JSON.stringify({ prepared: true }),
      workerSessionId: "worker",
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
    });
    turn.pushChild(call);
    session.root.head = turn;
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await delay(50);
    const key = documentKey("sessions", "s1");
    const checkpoint = server.documents.checkpoint(key);
    if (checkpoint == null) throw new Error("missing checkpoint");
    const gated = await server.documents.flush(key, checkpoint);
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;
    const staleReceipt = {
      ...gated.receipt,
      serverEpoch: gated.receipt.serverEpoch - 1,
    };
    expect(receiptCoversCheckpoint(staleReceipt, checkpoint)).toBe(false);
    server.recover();

    const second = await connectPeer(root, base);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const staleFlush = await first.adapter.flush(key, checkpoint);
    const recovered = await server.reconnect(second.adapter);
    const row = recovered.find((item) => item.kind === "harness:job:bot-call");
    const adopted = row?.job instanceof BotCallJob ? row.job : undefined;
    expect(second.adapter.connectionEpoch).toBeGreaterThan(first.adapter.connectionEpoch);
    expect({
      staleFlush,
      action: row?.action,
      join: adopted != null && joinReleased(adopted, catalog),
      activated: server.runtime.activated,
    }).toEqual({
      staleFlush: { ok: false, reason: "disconnected" },
      action: "resume-inner",
      join: false,
      activated: false,
    });
    server[Symbol.dispose]();
    catalog[Symbol.dispose]();
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
