/**
 * Vitest-side client: spawn driver CLI with execa (stdio piped, no TTY inherit).
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import invariant from "tiny-invariant";

import type { TerminalId } from "../terminals-types.js";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export type DriverStep = {
  name: string;
  step?: string;
  settleMs?: number;
};

export type DriverRunOpts = {
  terminal: TerminalId;
  command: string;
  cwd?: string;
  steps: DriverStep[];
  /** Kill after this many ms (default 180s). */
  timeoutMs?: number;
};

export type DriverPng = {
  name: string;
  png: Buffer;
};

export type DriverRunResult = {
  shots: DriverPng[];
};

function driverEntry(): string {
  // Source, not dist. The product build does not emit this tree.
  return join(here, "cli.ts");
}

function tsxLoader(): string {
  // Resolve from this file so a quickdraw vitest cwd still finds harness's tsx.
  return require.resolve("tsx");
}

/**
 * Run one terminal scenario in a **child process**. Parent (vitest) never
 * touches osascript/screencapture or the scenario TTY.
 */
export async function runTerminalScenarioDetached(opts: DriverRunOpts): Promise<DriverRunResult> {
  const entry = driverEntry();
  const job = {
    terminal: opts.terminal,
    command: opts.command,
    cwd: opts.cwd,
    steps: opts.steps,
  };

  const child = execa(process.execPath, ["--import", tsxLoader(), entry, "--oneshot", JSON.stringify(job)], {
    // Critical: do NOT inherit vitest's TTY
    stdio: ["ignore", "pipe", "pipe"],
    // New process group — won't share signals / tty with parent
    detached: false,
    env: {
      ...process.env,
      // Child must not think it's interactive for reporters
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: opts.timeoutMs ?? 180_000,
    reject: false,
  });

  const shots: DriverPng[] = [];
  let errMsg: string | null = null;
  let carry = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    carry += chunk;
    const parts = carry.split("\n");
    carry = parts.pop() ?? "";
    for (const line of parts) {
      const t = line.trim();
      if (!t) continue;
      try {
        const msg = JSON.parse(t) as {
          type: string;
          name?: string;
          base64?: string;
          message?: string;
        };
        if (msg.type === "png" && msg.name && msg.base64) {
          shots.push({ name: msg.name, png: Buffer.from(msg.base64, "base64") });
        } else if (msg.type === "error") {
          errMsg = msg.message ?? "driver error";
        }
      } catch {
        // ignore non-JSON noise on stdout
      }
    }
  });

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (c: string) => {
    stderr += c;
  });

  const result = await child;

  invariant(!errMsg, errMsg ?? "driver error");
  invariant(
    result.exitCode === 0,
    () => `terminal-e2e driver exit ${result.exitCode}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`,
  );
  invariant(
    shots.length > 0,
    () =>
      `terminal-e2e driver produced no screenshots${stderr.trim() ? ` (stderr: ${stderr.trim().slice(0, 300)})` : ""}`,
  );

  return { shots };
}
