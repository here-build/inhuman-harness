/** Missing catalog seals a fail receipt instead of leaving outcomeJson empty. */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { SessionPlexus, SessionSystemPrompt, SessionTurn, SystemToolJob } from "@inhuman.tools/harness-model";
import { beforeEach, expect, it, onTestFinished } from "vitest";
import * as Y from "yjs";

import { SessionRuntime } from "../../session-runtime/index.js";
import { bindBehaviorEntries, bindSessionCatalog, KernelToolCatalog } from "../../tool-catalog/index.js";
import { runWithExtraRoot } from "../extra-root.js";
import { extraRootAllowed, executeSystemTool, sealToolCall } from "../index.js";

beforeEach(() => resetLocalIDs());

it("drops a late tool receipt and stream after another runtime binds the same document", async () => {
  const plexus = SessionPlexus.create("late-tool", "/tmp/late-tool");
  const runtime = new SessionRuntime(plexus, { kind: "memory" });
  const catalog = new KernelToolCatalog();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  catalog.replacePack([
    {
      wireName: "shell",
      description: "deferred shell",
      parameters: { type: "object", properties: {} },
      class: "read",
      source: { kind: "pack", pluginName: "toolkit" },
      async execute(_args, context) {
        entered.resolve();
        await release.promise;
        context.onTail?.({ text: "late stream", totalBytes: 11 });
        return { ok: true, text: "late result" };
      },
    },
  ]);
  bindSessionCatalog(plexus.root, catalog);
  const job = new SystemToolJob({ toolCallId: "late-shell", name: "shell", argsJson: "{}" });
  plexus.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`run`,
    doneWork: [job],
  });
  plexus.root.head.pushChild(job);
  const running = executeSystemTool(job, new AbortController().signal, { canApplyResults: () => runtime.isCurrent });
  await entered.promise;
  const replacement = new SessionRuntime(plexus, { kind: "memory" });
  onTestFinished(async () => {
    await replacement[Symbol.asyncDispose]();
    await runtime[Symbol.asyncDispose]();
    catalog[Symbol.dispose]();
    plexus.destroy();
  });
  const before = Y.encodeStateAsUpdate(plexus.doc);
  release.resolve();
  await running;
  expect({ state: Y.encodeStateAsUpdate(plexus.doc), receipt: job.receiptJson }).toEqual({
    state: before,
    receipt: null,
  });
});

it("executeSystemTool seals { ok: false } when the session catalog is missing", async () => {
  const plexus = SessionPlexus.create("exec-miss-catalog", "/tmp/exec-miss-catalog");
  onTestFinished(() => plexus.destroy());
  const job = new SystemToolJob({
    toolCallId: "c1",
    name: "read_file",
    argsJson: "{}",
    approvalComment: "keep the export",
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: [job],
    queue: [],
  });
  turn.pushChild(job);
  plexus.root.head = turn;
  await executeSystemTool(job, new AbortController().signal);
  expect(JSON.parse(job.receiptJson ?? "null")).toEqual({
    ok: false,
    text: "error: read_file: kernel tool catalog is missing",
  });
});

it("a background tool keeps the release ack and records the real result", () => {
  const plexus = SessionPlexus.create("exec-bg-result", "/tmp/exec-bg-result");
  onTestFinished(() => plexus.destroy());
  const job = new SystemToolJob({
    toolCallId: "job-shell",
    name: "shell",
    argsJson: "{}",
    background: true,
    outcomeJson: JSON.stringify({
      ok: true,
      value: { job_id: "job-shell", background: true },
    }),
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: [job],
    queue: [],
  });
  turn.pushChild(job);
  plexus.root.head = turn;
  sealToolCall(job, { ok: true, value: { stdout: "ready" } });
  sealToolCall(job, { ok: false, text: "late" });
  expect({
    outcome: JSON.parse(job.receiptJson ?? "null"),
    note: job.resultNote?.message,
    result: job.resultNote?.result,
  }).toEqual({
    outcome: { ok: true, value: { job_id: "job-shell", background: true } },
    note: 'job job-shell finished: {"stdout":"ready"}',
    result: true,
  });
});

it("job_stop lists and stops through the host callback", async () => {
  const plexus = SessionPlexus.create("exec-job-stop", "/tmp/exec-job-stop");
  onTestFinished(() => plexus.destroy());
  bindSessionCatalog(plexus.root, new KernelToolCatalog());
  const job = new SystemToolJob({
    toolCallId: "stop-1",
    name: "job_stop",
    argsJson: JSON.stringify({ job_id: "job-scheme" }),
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: [job],
    queue: [],
  });
  turn.pushChild(job);
  plexus.root.head = turn;
  await executeSystemTool(job, new AbortController().signal, {
    stopJob: (jobId) => ({
      ok: true,
      value: { job_id: jobId, status: "cancelled" },
    }),
  });
  expect(JSON.parse(job.receiptJson ?? "null")).toEqual({
    ok: true,
    value: { job_id: "job-scheme", status: "cancelled" },
  });
});

it("dispatches a registered catalog execute and never runs it when the job is already sealed", async () => {
  let cores = 0;
  const catalog = new KernelToolCatalog();
  catalog.replacePack([
    {
      wireName: "echo",
      description: "echo",
      parameters: { type: "object", properties: {} },
      class: "read",
      source: { kind: "pack", pluginName: "toolkit" },
      execute: async (raw) => {
        cores += 1;
        return { ok: true, value: raw };
      },
    },
  ]);
  const plexus = SessionPlexus.create("exec-echo", "/tmp/exec-echo");
  onTestFinished(() => plexus.destroy());
  bindSessionCatalog(plexus.root, catalog);
  const job = new SystemToolJob({
    toolCallId: "e1",
    name: "echo",
    argsJson: JSON.stringify({ text: "hi" }),
  });
  plexus.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: [job],
    queue: [],
  });
  plexus.root.head.pushChild(job);
  await executeSystemTool(job, new AbortController().signal);
  expect({
    cores,
    outcome: JSON.parse(job.receiptJson ?? "null"),
    regenerateable: job.regenerateable,
  }).toEqual({
    cores: 1,
    outcome: { ok: true, value: { text: "hi" } },
    regenerateable: true,
  });
});

it("declared behavior tools execute from the session WeakMap, not the kernel catalog field", async () => {
  let cores = 0;
  const catalog = new KernelToolCatalog();
  const plexus = SessionPlexus.create("exec-declared", "/tmp/exec-declared");
  onTestFinished(() => plexus.destroy());
  bindSessionCatalog(plexus.root, catalog);
  bindBehaviorEntries(plexus.root, [
    {
      wireName: "echo",
      description: "echo",
      parameters: { type: "object", properties: {} },
      class: "effect",
      source: { kind: "pack", pluginName: "behavior" },
      execute: async () => {
        cores += 1;
        return { ok: true, text: "hi!" };
      },
    },
  ]);
  const job = new SystemToolJob({
    toolCallId: "d1",
    name: "echo",
    argsJson: "{}",
  });
  plexus.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: [job],
    queue: [],
  });
  plexus.root.head.pushChild(job);
  await executeSystemTool(job, new AbortController().signal);
  expect({
    cores,
    outcome: JSON.parse(job.receiptJson ?? "null"),
  }).toEqual({
    cores: 1,
    outcome: { ok: true, text: "hi!" },
  });
});

it("a non-boolean ok is wrapped as a value, not a tool result", async () => {
  const catalog = new KernelToolCatalog();
  catalog.replacePack([
    {
      wireName: "odd",
      description: "odd",
      parameters: { type: "object", properties: {} },
      class: "effect",
      source: { kind: "pack", pluginName: "toolkit" },
      execute: async () => ({ ok: "yes", text: "nope" }),
    },
  ]);
  const plexus = SessionPlexus.create("exec-odd", "/tmp/exec-odd");
  onTestFinished(() => plexus.destroy());
  bindSessionCatalog(plexus.root, catalog);
  const job = new SystemToolJob({
    toolCallId: "o1",
    name: "odd",
    argsJson: "{}",
  });
  plexus.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: [job],
    queue: [],
  });
  plexus.root.head.pushChild(job);
  await executeSystemTool(job, new AbortController().signal);
  expect(JSON.parse(job.receiptJson ?? "null")).toEqual({
    ok: true,
    value: { ok: "yes", text: "nope" },
  });
});

it("extra-root isolation is per-run, not process-global", () => {
  expect({
    outside: extraRootAllowed(),
    inner: runWithExtraRoot(true, extraRootAllowed),
    after: extraRootAllowed(),
  }).toEqual({ outside: false, inner: true, after: false });
});

it.each(["success", "failure", "throw", "abort", "abort-failure", "stale"] as const)(
  "commits proposed metadata only after a successful current execution: %s",
  async (mode) => {
    const plexus = SessionPlexus.create(`proposal-${mode}`, "/tmp/proposal");
    const catalog = new KernelToolCatalog();
    onTestFinished(() => {
      catalog[Symbol.dispose]();
      plexus.destroy();
    });
    const controller = new AbortController();
    let current = true;
    catalog.replacePack([
      {
        wireName: "propose",
        class: "meta",
        description: "propose",
        parameters: {},
        source: { kind: "pack", pluginName: "proposal" },
        async execute(_args, ctx) {
          ctx.storage?.propose({ changed: true });
          if (mode === "throw") throw new Error("failed after proposal");
          if (mode === "abort") controller.abort("cancel");
          if (mode === "abort-failure") {
            controller.abort("cancel");
            return { ok: false, text: "cancelled", value: { stdout: "TAIL" } };
          }
          if (mode === "stale") current = false;
          return { ok: mode !== "failure" };
        },
      },
    ]);
    bindSessionCatalog(plexus.root, catalog);
    const job = new SystemToolJob({ toolCallId: "proposal", name: "propose", argsJson: "{}" });
    plexus.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`p`,
      doneWork: [job],
      queue: [],
    });
    plexus.root.head.pushChild(job);
    await executeSystemTool(job, controller.signal, { canApplyResults: () => current });
    expect(job.pluginMeta).toEqual(
      mode === "success" ? { proposal: JSON.stringify({ action: { changed: true } }) } : {},
    );
    if (mode === "abort-failure")
      expect(job.outcomeSnap).toEqual({ ok: false, text: "cancelled", value: { stdout: "TAIL" } });
    if (mode === "success") {
      await executeSystemTool(job, controller.signal);
      expect(job.outcomeSnap).toEqual({ ok: true });
    }
  },
);
