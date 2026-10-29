/**
 * Kill a separate daemon process and reconstruct from the files it wrote.
 * Dispose+reopen of in-process objects is not this suite.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SystemToolJob,
  evalProgramOf,
  findEvalTurnByRequestId,
  isEvalRequestCancelled,
} from "@inhuman.tools/harness-model";
import { Client } from "@inhuman.tools/harness-sdk";
import { daemonSocketPath } from "@inhuman.tools/harness-sdk/paths";
import { walkWork } from "@inhuman.tools/plexus-expectations";
import { when } from "mobx";
import { describe, expect, it, onTestFinished } from "vitest";

import { ensure, stop } from "../../../dist/server/ensure.js";
import { RpcInvalidParams } from "../contract.js";
import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../daemon/project/ProjectDaemon.js";

const TIMEOUT = 120_000;
const bin = fileURLToPath(new URL("../../../dist/server/bin.js", import.meta.url));

function socketPids(socketPath: string): number[] {
  if (!existsSync(socketPath)) return [];
  try {
    const out = execFileSync("lsof", ["-t", socketPath], { encoding: "utf8", timeout: 5_000 }).trim();
    if (out === "") return [];
    return [
      ...new Set(
        out
          .split("\n")
          .map((line) => Number(line.trim()))
          .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid),
      ),
    ];
  } catch {
    return [];
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(label);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function killHard(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  await waitFor(() => !pidAlive(pid), 5_000, `pid ${pid} still alive`);
}

async function openWorld(): Promise<{
  readonly kernel: string;
  readonly workspace: string;
  readonly pid: number;
}> {
  const kernel = realpathSync(await mkdtemp(join(tmpdir(), "harness-eval-crash-k-")));
  const workspace = realpathSync(await mkdtemp(join(tmpdir(), "harness-eval-crash-p-")));
  await writeFile(join(kernel, "config.json"), JSON.stringify({ connections: {} }));
  await ensure(kernel);
  const pids = socketPids(daemonSocketPath(kernel));
  const pid = pids[0];
  if (pid == null) throw new Error(`no daemon pid on ${daemonSocketPath(kernel)}`);
  onTestFinished(async () => {
    await stop(kernel).catch(() => undefined);
  });
  return { kernel, workspace, pid };
}

async function reconstruct(kernel: string, workspace: string, sessionId: string) {
  const host = new KernelDaemon(kernel);
  await host.ready;
  const project = new ProjectDaemon(host, workspace);
  await project.ready;
  const session = await project.session(sessionId);
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    host[Symbol.dispose]();
  });
  return session;
}

describe.skipIf(!existsSync(bin))("eval crash recovery", () => {
  it(
    "kill -9: request-scoped cancel; acknowledged cancel; unpersisted external effect does not repeat",
    async () => {
      const scoped = await openWorld();
      const scopedClient = await Client.start(scoped.kernel, scoped.workspace);
      const scopedSessionId = scopedClient.sessionId;
      await scopedClient.request("turn/cancel", { requestId: "req-never" });
      await scopedClient[Symbol.asyncDispose]();
      await killHard(scoped.pid);
      const scopedSession = await reconstruct(scoped.kernel, scoped.workspace, scopedSessionId);
      expect({
        cancelled: isEvalRequestCancelled(scopedSession.root, "req-never"),
        turn: findEvalTurnByRequestId(scopedSession.root, "req-never"),
      }).toEqual({ cancelled: true, turn: null });
      await expect(
        scopedSession.handleRequest("eval", {
          requestId: "req-never",
          expr: "(+ 1 2)",
          policy: "yolo",
        }),
      ).rejects.toBeInstanceOf(RpcInvalidParams);

      const acked = await openWorld();
      const ackedClient = await Client.start(acked.kernel, acked.workspace);
      const ackedSessionId = ackedClient.sessionId;
      const admitted = (await ackedClient.request("eval", {
        requestId: "req-crash-cancel",
        expr: '(shell "sleep 99999")',
        policy: "yolo",
      })) as { ok: true; turnId: string; programId: string };
      expect(admitted.ok).toBe(true);
      await ackedClient.request("turn/cancel", { requestId: "req-crash-cancel" });
      await ackedClient[Symbol.asyncDispose]();
      await killHard(acked.pid);
      const ackedSession = await reconstruct(acked.kernel, acked.workspace, ackedSessionId);
      const ackedTurn = findEvalTurnByRequestId(ackedSession.root, "req-crash-cancel");
      expect({
        cancelled: isEvalRequestCancelled(ackedSession.root, "req-crash-cancel"),
        cancelRequested: ackedTurn?.cancelRequested ?? true,
        live: ackedSession.root.isMidMotion(),
        turnId: ackedTurn == null ? admitted.turnId : ackedTurn.uuid,
      }).toEqual({
        cancelled: true,
        cancelRequested: true,
        live: false,
        turnId: admitted.turnId,
      });
      await expect(
        ackedSession.handleRequest("eval", {
          requestId: "req-crash-cancel",
          expr: "(+ 1 2)",
          policy: "yolo",
        }),
      ).rejects.toBeInstanceOf(RpcInvalidParams);

      const effect = await openWorld();
      const counter = join(effect.workspace, "effect.counter");
      const effectClient = await Client.start(effect.kernel, effect.workspace);
      const effectSessionId = effectClient.sessionId;
      await effectClient.request("eval", {
        requestId: "req-crash-effect",
        expr: '(shell "printf x >> effect.counter; sleep 99999")',
        policy: "yolo",
      });
      await waitFor(
        async () => {
          try {
            return (await readFile(counter, "utf8")) === "x";
          } catch {
            return false;
          }
        },
        15_000,
        "effect.counter",
      );
      await effectClient[Symbol.asyncDispose]();
      await killHard(effect.pid);
      const effectSession = await reconstruct(effect.kernel, effect.workspace, effectSessionId);
      const effectTurn = findEvalTurnByRequestId(effectSession.root, "req-crash-effect");
      const program = evalProgramOf(effectTurn!);
      await when(() => program?.completed === true, { timeout: 8_000 });
      const leaf = [...walkWork(effectTurn!)].find(
        (node): node is SystemToolJob => node instanceof SystemToolJob && node.name === "shell",
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect({
        effect: await readFile(counter, "utf8"),
        leaf: leaf?.outcomeSnap,
      }).toEqual({
        effect: "x",
        leaf: {
          ok: false,
          text: expect.stringMatching(/interrupted by restart; execution outcome unknown/),
        },
      });
    },
    TIMEOUT,
  );
});
