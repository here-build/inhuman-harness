import { mkdir, rmdir, stat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { dirname, join } from "node:path";

import { note } from "@inhuman.tools/harness-diagnostics";

import type { LockKind } from "@/protocol/schemas";

import { errnoCode, sleep, waitUntil } from "./util.js";

/** Kernel bind retries after a confirmed-dead leftover socket file. */
const ACQUIRE_ATTEMPTS = 3;
const PROBE_MS = 200;
/** Wait for another acquirer to leave the reclaim gate. */
const GATE_WAIT_MS = 1_000;
/**
 * Crash leftover only. A live acquire is milliseconds; do not rmdir a recent
 * gate — that would let a second process unlink+bind beside the first.
 */
const GATE_STALE_MS = 2_000;

export class LockHeldError extends Error {
  constructor(readonly path: string) {
    super(`lifetime lock held: ${path}`);
    this.name = "LockHeldError";
  }
}

export class LifetimeLock {
  private released = false;

  private constructor(
    readonly kind: LockKind,
    readonly path: string,
    private readonly server: Server,
  ) {}

  static async acquire(path: string, kind: LockKind): Promise<LifetimeLock> {
    const held = await LifetimeLock.tryAcquire(path, kind);
    if (held === null) throw new LockHeldError(path);
    return held;
  }

  static async tryAcquire(path: string, kind: LockKind): Promise<LifetimeLock | null> {
    await mkdir(dirname(path), { recursive: true });
    // One process may unlink+bind a leftover. Concurrent reclaim would unlink
    // a just-bound socket and create a second owner at the same path.
    const entered = await enterReclaimGate(path);
    if (!entered) return null;
    try {
      for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
        const bound = await bindLockSocket(path);
        if (bound.status === "held") return null;
        if (bound.status === "owned") {
          return new LifetimeLock(kind, path, bound.server);
        }
        try {
          await unlink(path);
        } catch {
          /* already gone */
        }
        await sleep(10);
      }
      return null;
    } finally {
      await leaveReclaimGate(path);
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    try {
      await unlink(this.path);
    } catch {
      /* closed bind; leftover path is not ownership */
    }
    note(`hypervisor lock released kind=${this.kind} path=${this.path}`);
  }
}

/** Darwin unix-socket paths cap at 104 bytes; keep names short under `/tmp`. */
export function lockPathFor(root: string, kind: LockKind): string {
  return join(root, `${kind}.sock`);
}

export async function isLifetimeLockHeld(path: string): Promise<boolean> {
  return (await probeLockSocket(path)) !== "dead";
}

export async function waitForLockRelease(path: string, timeoutMs: number): Promise<void> {
  await waitUntil(`lock release ${path}`, async () => !(await isLifetimeLockHeld(path)), timeoutMs);
}

type BindResult = { status: "owned"; server: Server } | { status: "held" } | { status: "stale" };

type Probe = "live" | "dead" | "busy";

async function bindLockSocket(path: string): Promise<BindResult> {
  const server = createServer((socket) => {
    socket.end();
  });
  try {
    await listenUnix(server, path);
    return { status: "owned", server };
  } catch (error) {
    server.close();
    if (errnoCode(error) !== "EADDRINUSE") throw error;
    const probe = await probeLockSocket(path);
    // Timeout/busy is occupancy, never a license to unlink.
    return probe === "dead" ? { status: "stale" } : { status: "held" };
  }
}

function reclaimGatePath(path: string): string {
  return `${path}.gate`;
}

async function enterReclaimGate(path: string): Promise<boolean> {
  const gate = reclaimGatePath(path);
  const deadline = Date.now() + GATE_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(gate);
      return true;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
      if (await isReclaimGateStale(gate)) {
        await rmdir(gate).catch(() => undefined);
        continue;
      }
      await sleep(10);
    }
  }
  return false;
}

async function isReclaimGateStale(gate: string): Promise<boolean> {
  try {
    const info = await stat(gate);
    return Date.now() - info.mtimeMs >= GATE_STALE_MS;
  } catch {
    return true;
  }
}

async function leaveReclaimGate(path: string): Promise<void> {
  await rmdir(reclaimGatePath(path)).catch(() => undefined);
}

function listenUnix(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen({ path }, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function probeLockSocket(path: string): Promise<Probe> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const settle = (result: Probe): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => settle("busy"), PROBE_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      settle("live");
    });
    socket.once("error", (error: Error) => {
      clearTimeout(timer);
      const code = errnoCode(error);
      settle(
        code === "ECONNREFUSED" || code === "ENOENT" || code === "ENOTSOCK" || code === "ECONNRESET" ? "dead" : "busy",
      );
    });
  });
}
