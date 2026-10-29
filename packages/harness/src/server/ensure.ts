import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { access, mkdir, realpath, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { step } from "@inhuman.tools/harness-diagnostics";
import { daemonLogPath, daemonSocketPath } from "@inhuman.tools/harness-sdk/paths";
import invariant from "tiny-invariant";

import { errnoCode } from "./util/errno.js";

const READY_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 300;
const GRACE_MS = 2000;
// Old startup adapter: spawn the in-process daemon bin. Do not import composition.
// Public ensure() is daemon-socket liveness, not hypervisor sync/execution health.
const entry = fileURLToPath(new URL("boot.js", import.meta.url));

async function socketAnswers(socketPath: string): Promise<boolean> {
  return new Promise((_resolve) => {
    const socket = connect(socketPath);
    const settle = (alive: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      _resolve(alive);
    };
    const timer = setTimeout(() => settle(false), PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      settle(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      settle(false);
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveRoot(root?: string): Promise<string> {
  const given = resolve(root ?? join(homedir(), ".harness"));
  await mkdir(given, { recursive: true });
  return realpath(given);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

/** lsof matches unix sockets by the bound (canonical) path. */
function socketPids(socketPath: string): number[] {
  if (!existsSync(socketPath)) return [];
  try {
    const out = execFileSync("lsof", ["-t", socketPath], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (out === "") return [];
    return [
      ...new Set(
        out
          .split("\n")
          .map((line) => Number(line.trim()))
          .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid),
      ),
    ].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function sockPath(root: string): string {
  try {
    return daemonSocketPath(realpathSync(root));
  } catch {
    return daemonSocketPath(root);
  }
}

export type EnsureOptions = {
  /** Kill the live owner, then spawn. Dev default; product `ensure()` is still attach. */
  readonly restart?: boolean;
};

/** True when the kernel's daemon socket answers right now. Never spawns and never clears a stale socket. */
export async function daemonRunning(root?: string): Promise<boolean> {
  return socketAnswers(daemonSocketPath(await resolveRoot(root)));
}

export async function ensure(root?: string, options?: EnsureOptions): Promise<void> {
  const resolved = await resolveRoot(root);
  if (options?.restart === true) {
    step("ensure restart");
    await stop(resolved);
  }
  const sock = daemonSocketPath(resolved);
  step(`ensure probe ${sock}`);
  if (await socketAnswers(sock)) {
    step("ensure already live");
    return;
  }
  if (await exists(sock)) {
    try {
      await unlink(sock);
    } catch {
      /* another ensure() may have already cleared it */
    }
  }

  step(`ensure spawn ${entry}`);
  const log = process.env.HARNESS_LOG || daemonLogPath(resolved);
  step(`ensure log ${log}`);
  // Daemon identity is cwd. No argv, no stdout handshake. Log path is explicit
  // so a live daemon writes the kernel file even if the parent cwd differs.
  // stdio stays ignore: the daemon outlives this parent. boot.js records an
  // import failure in that log, then exits.
  const childExit: { code: number | null } = { code: null };
  const child = spawn(process.execPath, [entry], {
    cwd: resolved,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, HARNESS_LOG: log },
  });
  child.once("exit", (code, signal) => {
    childExit.code = code ?? (signal == null ? 0 : 1);
  });
  step(`ensure pid ${child.pid ?? "none"}`);
  child.unref();

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!(await socketAnswers(sock))) {
    if (childExit.code !== null) {
      step(`ensure child exit ${childExit.code}`);
      invariant(false, `harness daemon exited ${childExit.code} before listen: ${sock} (see ${log})`);
    }
    invariant(Date.now() < deadline, `harness daemon sock is dead: ${sock}`);
    await new Promise((_resolve) => setTimeout(_resolve, 50));
  }
  step("ensure child ready");
}

export async function stop(root: string): Promise<void> {
  const sock = sockPath(root);
  const pids = socketPids(sock);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  const deadline = Date.now() + GRACE_MS;
  for (const pid of pids) {
    while (pidAlive(pid) && Date.now() < deadline) {
      await new Promise((_resolve) => setTimeout(_resolve, 50));
    }
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  if (existsSync(sock) && !(await socketAnswers(sock))) {
    try {
      unlinkSync(sock);
    } catch {}
  }
}
