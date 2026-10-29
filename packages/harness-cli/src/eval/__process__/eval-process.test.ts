/**
 * Spawn dist/bin.js — in-process `run()` has no real SIGINT / socket-drop path.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HarnessDaemon } from "@inhuman.tools/harness/testkit";
import { describe, expect, it, onTestFinished } from "vitest";

const TIMEOUT = 60_000;
const bin = fileURLToPath(new URL("../../../dist/bin.js", import.meta.url));

async function waitFor(needle: string, read: () => string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!read().includes(needle)) {
    if (Date.now() > deadline) throw new Error(`missing ${needle}: ${read()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function hangingChild(label: string, disposeDaemon: boolean) {
  const kernel = await mkdtemp(join(tmpdir(), `harness-eval-${label}-k-`));
  const workspace = await mkdtemp(join(tmpdir(), `harness-eval-${label}-p-`));
  onTestFinished(async () => {
    await rm(kernel, { recursive: true, force: true, maxRetries: 10 });
    await rm(workspace, { recursive: true, force: true, maxRetries: 10 });
  });
  await writeFile(join(kernel, "config.json"), JSON.stringify({ connections: {} }));
  execFileSync("mkfifo", [join(workspace, "hang.fifo")]);
  const daemon = new HarnessDaemon(kernel);
  await daemon.listen();
  if (disposeDaemon) {
    onTestFinished(async () => {
      await daemon[Symbol.asyncDispose]();
    });
  }
  const child = spawn(process.execPath, [bin, "-e", '(read_file "hang.fifo")', "--mode", "yolo", "--kernel", kernel], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  let stderr = "";
  let stdout = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  onTestFinished(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  });
  await waitFor("connect later with --resume", () => stderr, 15_000);
  return {
    daemon,
    child,
    get stderr() {
      return stderr;
    },
    get stdout() {
      return stdout;
    },
  };
}

function waitExit(child: ChildProcess, readStderr: () => string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`still running: ${readStderr()}`)), 8_000);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
}

describe("eval process", () => {
  it.skipIf(!existsSync(bin))(
    "SIGINT cancels a hanging eval; a second signal ends unconfirmed wait; socket drop still exits",
    async () => {
      const first = await hangingChild("sig", true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      first.child.kill("SIGINT");
      const firstCode = await waitExit(first.child, () => first.stderr);

      const second = await hangingChild("sig2", true);
      second.child.kill("SIGINT");
      second.child.kill("SIGINT");
      const secondCode = await waitExit(second.child, () => second.stderr);

      const dropped = await hangingChild("drop", false);
      await dropped.daemon[Symbol.asyncDispose]();
      dropped.child.kill("SIGINT");
      dropped.child.kill("SIGINT");
      const dropCode = await waitExit(dropped.child, () => dropped.stderr);

      expect({
        firstSigint: { code: firstCode, stdout: first.stdout },
        secondSignal: {
          code: secondCode,
          unconfirmed: /cancellation unconfirmed; execution may still be running/.test(second.stderr),
        },
        socketDrop: { code: dropCode, unconfirmed: /cancellation unconfirmed/.test(dropped.stderr) },
      }).toEqual({
        firstSigint: { code: 1, stdout: "" },
        secondSignal: { code: 1, unconfirmed: true },
        socketDrop: { code: 1, unconfirmed: true },
      });
    },
    TIMEOUT,
  );
});
