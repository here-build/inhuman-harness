/**
 * An ABI program's file ports are inner tool calls. Each one meets the
 * session's license like any other host tool; the ABI tool's own license
 * judged only its arguments.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { SessionSystemPrompt, SessionTurn, SystemToolJob } from "@inhuman.tools/harness-model";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { beforeEach, expect, it, onTestFinished } from "vitest";

import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

const TIMEOUT = 8_000;

beforeEach(() => resetLocalIDs());

/** Wrapped: a Job is thenable, so an async function would resolve it instead of returning it. */
async function run(session: SessionDaemon, name: string, args: object): Promise<{ readonly job: SystemToolJob }> {
  const job = new SystemToolJob({ toolCallId: name, name, argsJson: JSON.stringify(args), humanApprove: true });
  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], reducerExited: true });
  turn.pushChild(job);
  session.root.head = turn;
  await when(() => job.completed || job.children.length > 0, { timeout: TIMEOUT });
  return { job };
}

it("a task exam's shell port waits on the session license, then runs once approved", async () => {
  const system = await mkdtemp(join(tmpdir(), "harness-abi-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-abi-p-"));
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
  const marker = join(workspace, "marker");
  const { job: created } = await run(session, "task__create", {
    taskId: "t1",
    subject: "probe",
    description: "probe",
    validationProgram: `(begin (shell "touch ${marker}") (tasks/write-completion-verdict #t "ok"))`,
  });
  await run(session, "task__start", { taskId: "t1" });
  const { job: validate } = await run(session, "task__validate", { taskId: "t1" });
  const inner = validate.children.find(
    (node): node is SystemToolJob => node instanceof SystemToolJob && node.name === "shell",
  );
  expect({
    created: JSON.parse(created.receiptJson ?? "null")?.ok,
    marker: existsSync(marker),
    validate: validate.receiptJson,
    inner: inner == null ? null : { license: inner.licenseDecision, completed: inner.completed },
  }).toEqual({ created: true, marker: false, validate: null, inner: { license: null, completed: false } });

  inner!.humanApprove = true;
  await when(() => validate.completed, { timeout: TIMEOUT });
  expect({ marker: existsSync(marker), validate: JSON.parse(validate.receiptJson ?? "null") }).toEqual({
    marker: true,
    validate: { ok: true, value: [true, "ok"] },
  });
});
