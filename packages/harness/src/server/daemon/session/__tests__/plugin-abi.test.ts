/**
 * An ABI program's file ports are inner tool calls. Each one meets the
 * session's license like any other host tool; the ABI tool's own license
 * judged only its arguments.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionSystemPrompt, SessionTurn, SystemToolJob } from "@inhuman.tools/harness-model";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { expect, it, onTestFinished } from "vitest";

import { loadProgram } from "@/extensions";

import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

const TIMEOUT = 8_000;

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

it("task program errors teach recovery before creation and after a program has been saved", async () => {
  const system = await mkdtemp(join(tmpdir(), "harness-exam-door-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-exam-door-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("exam-doors");
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  const invoke = async (name: string, args: object) => {
    const { job } = await run(session, name, args);
    for (const child of job.children) {
      if (child instanceof SystemToolJob) child.humanApprove = true;
    }
    await when(() => job.completed, { timeout: TIMEOUT });
    return job.receiptJson ?? "";
  };
  const create = (taskId: string, validationProgram: string) =>
    invoke("task__create", {
      taskId,
      subject: "Check status",
      description: "status.txt must contain exactly ready",
      validationProgram,
    });
  const toolsPath = new URL("../../../../../../../plugins/inhuman-plugin-tasks/behavior/tools.scm", import.meta.url);
  const registry = await loadProgram({
    agentId: "tasks",
    source: readFileSync(toolsPath, "utf8"),
    filename: toolsPath.pathname,
    revision: "test",
    root: workspace,
    read: () => "",
    kind: "behavior",
  });
  const documented =
    '(tasks/write-completion-verdict (equal? (read_file "status.txt") "ready") "status.txt must contain exactly ready")';
  expect(JSON.stringify(registry.tools.get("task__create")?.input?.json)).toContain(
    JSON.stringify(documented).slice(1, -1),
  );

  const first = await create("syntax", "for (const f of files) { const t = read_file(f); }");
  expect(first).toContain("unterminated dict literal");
  expect(first).toContain("No task was created");
  expect(first).toContain("1. ");
  expect(first).toContain("Retry task__create");
  expect(first).toContain("read_file");
  expect(first).not.toContain("exam/program-syntax");
  const repeated = await create("regex", "const hasPicker = /agent-trigger|Agent \\/ none|chooseAgent/.test(t);");
  expect(repeated).toContain("unterminated |...| symbol");
  expect(repeated).toContain("Retry task__create");
  expect(repeated).not.toContain("1. ");

  // Reusing the rejected ID proves the failing capture did not save a page.
  expect(await create("syntax", documented)).toContain('"ok":true');
  writeFileSync(join(workspace, "status.txt"), "waiting");
  await invoke("task__start", { taskId: "syntax" });
  expect(await invoke("task__validate", { taskId: "syntax" })).toContain('"value":[false,');
  writeFileSync(join(workspace, "status.txt"), "ready");
  await invoke("task__start", { taskId: "syntax" });
  expect(await invoke("task__validate", { taskId: "syntax" })).toContain('"value":[true,');

  expect(await create("saved-js", 'const t = read_file("status.txt");')).toContain('"ok":true');
  await invoke("task__start", { taskId: "saved-js" });
  const savedError = await invoke("task__validate", { taskId: "saved-js" });
  expect(savedError).toContain("Unbound variable");
  expect(savedError).toContain("task__drop");
  expect(savedError).toContain("new taskId");
  expect(savedError).toContain("read_file");
  expect(savedError).not.toContain("No task was created");
  await invoke("task__drop", { taskId: "saved-js", reason: "Replace the validation program" });
  expect(await create("replacement", documented)).toContain('"ok":true');
  await invoke("task__start", { taskId: "replacement" });
  expect(await invoke("task__validate", { taskId: "replacement" })).toContain('"value":[true,');
});
