/**
 * job_stop on a live session. The scan lives in the system-tool executor.
 * A manual-mode shell sits at the license and is not spawned.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import {
  ProgrammaticJob,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  type SessionRoot,
} from "@inhuman.tools/harness-model";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";

const TIMEOUT = 8_000;

function stop(id: string, jobId: string): SystemToolJob {
  return new SystemToolJob({
    toolCallId: id,
    name: "job_stop",
    argsJson: JSON.stringify(jobId === "" ? {} : { job_id: jobId }),
  });
}

async function openSession(): Promise<{ root: SessionRoot }> {
  const system = await mkdtemp(join(tmpdir(), "harness-job-stop-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-job-stop-p-"));
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
  return { root: session.root };
}

describe("job_stop", () => {
  beforeEach(() => resetLocalIDs());

  it("lists live work, cancels a sitting shell, and leaves a foreground call alone", async () => {
    const { root } = await openSession();
    const shell = new SystemToolJob({
      toolCallId: "job-shell",
      name: "shell",
      argsJson: JSON.stringify({ command: "curl x" }),
      background: true,
    });
    const done = new ProgrammaticJob({
      toolCallId: "job-done",
      argsJson: JSON.stringify({ expr: "#t" }),
      background: true,
      completed: true,
    });
    const foreground = new ProgrammaticJob({
      toolCallId: "fg",
      argsJson: JSON.stringify({ expr: "#t" }),
    });
    const listed = stop("stop-list", "");
    const cancelled = stop("stop-shell", "job-shell");
    const completed = stop("stop-done", "job-done");
    const absent = stop("stop-fg", "fg");
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
    });
    for (const job of [shell, done, foreground, listed, cancelled, completed, absent]) turn.pushChild(job);
    root.head = turn;

    await when(() => listed.completed && cancelled.completed && completed.completed && absent.completed, {
      timeout: TIMEOUT,
    });

    expect({
      listed: JSON.parse(listed.receiptJson ?? "null"),
      cancelled: JSON.parse(cancelled.receiptJson ?? "null"),
      completed: JSON.parse(completed.receiptJson ?? "null"),
      absent: JSON.parse(absent.receiptJson ?? "null"),
      shell: { cancelled: shell.cancelled, completed: shell.completed },
      foreground: { cancelled: foreground.cancelled },
    }).toEqual({
      listed: {
        ok: true,
        value: { jobs: [{ jobId: "job-shell", kind: "command", object: "curl x" }] },
      },
      cancelled: { ok: true, value: { job_id: "job-shell", status: "cancelled" } },
      completed: { ok: true, value: { job_id: "job-done", status: "completed" } },
      absent: { ok: true, value: { job_id: "fg", status: "absent" } },
      shell: { cancelled: false, completed: false },
      foreground: { cancelled: false },
    });
  });
});
