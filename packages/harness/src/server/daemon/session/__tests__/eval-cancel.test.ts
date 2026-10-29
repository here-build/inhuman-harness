/**
 * Request-scoped cancel wins before admission. An admitted turn records
 * cancelRequested before work is reclaimed.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  ProgrammaticJob,
  SessionSystemPrompt,
  SessionTurn,
  SessionTurnEvalSpec,
  evalProgramOf,
  findEvalTurnByRequestId,
  isEvalRequestCancelled,
} from "@inhuman.tools/harness-model";
import { mkdtemp, writeJson } from "fs-extra";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { recoverSessionJobs } from "@/runtime";

import { RpcInvalidParams } from "../../../contract.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

const TIMEOUT = 8_000;

async function openSession(): Promise<SessionDaemon> {
  const system = await mkdtemp(join(tmpdir(), "harness-cancel-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-cancel-p-"));
  await writeJson(join(system, "config.json"), { connections: {} });
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("s1");
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return session;
}

describe("eval cancellation", () => {
  beforeEach(() => resetLocalIDs());

  it("cancel machine: outstanding request blocks delayed admission; admitted programmatic cancel survives reclaim; request-scoped cancel persists across reopen", async () => {
    const session = await openSession();
    await expect(session.handleRequest("turn/cancel", { requestId: "req-late" })).resolves.toEqual({
      ok: true,
    });
    await expect(session.handleRequest("turn/cancel", { requestId: "req-late" })).resolves.toEqual({
      ok: true,
    });
    expect({ late: isEvalRequestCancelled(session.root, "req-late") }).toEqual({ late: true });
    await expect(
      session.handleRequest("eval", { requestId: "req-late", expr: "(+ 1 2)", policy: "auto" }),
    ).rejects.toBeInstanceOf(RpcInvalidParams);
    expect({ lateTurn: findEvalTurnByRequestId(session.root, "req-late") }).toEqual({ lateTurn: null });

    const program = new ProgrammaticJob({
      toolCallId: "program",
      argsJson: JSON.stringify({ expr: "(+ 1 2)", description: "add one and two" }),
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user``,
      evalSpec: new SessionTurnEvalSpec({ requestId: "req-pure", permissionMode: "auto" }),
      queue: [program],
    });
    session.root.head = turn;
    await expect(session.handleRequest("turn/cancel", { turnId: turn.uuid })).resolves.toEqual({
      ok: true,
    });
    await expect(session.handleRequest("turn/cancel", { turnId: turn.uuid })).resolves.toEqual({
      ok: true,
    });
    expect({
      cancelRequested: turn.cancelRequested,
      request: isEvalRequestCancelled(session.root, "req-pure"),
    }).toEqual({ cancelRequested: true, request: true });
    await when(() => program.completed || turn.reducerExited, { timeout: TIMEOUT });
    program.completed = false;
    program.orchestrationResult = true;
    turn.reducerExited = false;
    turn.completed = false;
    recoverSessionJobs(session.root);
    expect({
      reducerExited: turn.reducerExited,
      program: program.completed,
      outcome: program.receiptJson,
      identity: evalProgramOf(turn) === program,
    }).toEqual({
      reducerExited: true,
      program: true,
      outcome: expect.stringMatching(/cancelled/),
      identity: true,
    });

    const system = await mkdtemp(join(tmpdir(), "harness-cancel-persist-k-"));
    const workspace = await mkdtemp(join(tmpdir(), "harness-cancel-persist-p-"));
    await writeJson(join(system, "config.json"), { connections: {} });
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const persist = await project.session("persist");
    await persist.handleRequest("turn/cancel", { requestId: "req-persist" });
    expect({ persist: isEvalRequestCancelled(persist.root, "req-persist") }).toEqual({ persist: true });
    persist[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();

    const again = new KernelDaemon(system);
    await again.ready;
    const projectAgain = new ProjectDaemon(again, workspace);
    await projectAgain.ready;
    const sessionAgain = await projectAgain.session("persist");
    onTestFinished(() => {
      sessionAgain[Symbol.dispose]();
      projectAgain[Symbol.dispose]();
      again[Symbol.dispose]();
    });
    expect({ reopen: isEvalRequestCancelled(sessionAgain.root, "req-persist") }).toEqual({ reopen: true });
    await expect(
      sessionAgain.handleRequest("eval", { requestId: "req-persist", expr: "(+ 1 2)", policy: "auto" }),
    ).rejects.toBeInstanceOf(RpcInvalidParams);
    expect({ reopenTurn: findEvalTurnByRequestId(sessionAgain.root, "req-persist") }).toEqual({ reopenTurn: null });
  });
});
