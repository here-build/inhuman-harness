import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompactJob,
  ProgrammaticJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { beforeEach, expect, it, onTestFinished } from "vitest";

import { asToolResult, contextRecallTool } from "@/builtin-tools";
import { bindSessionCatalog } from "@/tool-catalog";
import { executeSystemTool } from "@/tool-runtime";

import { KernelToolCatalog } from "../tool-table.js";

beforeEach(() => resetLocalIDs());

function fixture() {
  const plexus = SessionPlexus.create("exec-meta", "/tmp/exec-meta");
  const catalog = new KernelToolCatalog();
  onTestFinished(() => {
    catalog[Symbol.dispose]();
    plexus.destroy();
  });
  bindSessionCatalog(plexus.root, catalog);
  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`p`, queue: [] });
  plexus.root.head = turn;
  function call(name: string, args: Record<string, unknown>, home = turn) {
    const job = new SystemToolJob({
      triggersReactLoop: catalog.catalogEntry(name)?.triggersReactLoop ?? true,
      isSideChannel: catalog.catalogEntry(name)?.isSideChannel === true,
      tapeHidden: catalog.catalogEntry(name)?.tapeHidden === true,
      toolCallId: `${name}-${home.children.length}`,
      name,
      argsJson: JSON.stringify(args),
    });
    home.pushChild(job);
    home.doneWork.push(job);
    return job;
  }
  async function execute(job: SystemToolJob) {
    await executeSystemTool(job, new AbortController().signal);
    job.markComplete();
    return job.outcomeSnap;
  }
  return { plexus, turn, call, execute };
}

it("metadata applies only after execution, clamps, preserves arguments, and rewinds", async () => {
  const { plexus, turn, call, execute } = fixture();
  const title = `Fix ${"x".repeat(100)}`;
  const first = call("update_metadata", { current_turn_title: title, current_turn_description: " patched " });
  expect(plexus.root.title).toBe("p");
  expect(await execute(first)).toEqual({
    ok: true,
    value: { current_turn_title: title.slice(0, 80), current_turn_description: "patched" },
  });
  expect({
    title: plexus.root.title,
    description: plexus.root.turnDescription,
    args: first.args?.current_turn_title,
  }).toEqual({ title: title.slice(0, 80), description: "patched", args: title });

  const next = new SessionTurn({ turnTail: turn, prompt: prompt.user`next`, queue: [] });
  plexus.root.head = next;
  await execute(call("update_metadata", { current_turn_title: "Later" }, next));
  expect(plexus.root.title).toBe("Later");
  plexus.root.head = turn;
  expect(plexus.root.title).toBe(title.slice(0, 80));
});

it("failed, blank, and cancelled metadata calls cannot change session state", async () => {
  const { plexus, turn, call, execute } = fixture();
  await execute(call("update_metadata", { current_turn_title: "Kept" }));
  const invalid = call("update_metadata", { current_turn_title: 42 });
  const blank = call("update_metadata", { current_turn_title: "   " });
  const cancelled = call("update_metadata", { current_turn_title: "Never" });
  const unexecuted = call("update_metadata", { current_turn_title: "Acknowledged only" });
  unexecuted.outcomeSnap = { ok: true };
  expect(await execute(invalid)).toMatchObject({ ok: false });
  expect(await execute(blank)).toMatchObject({ ok: false });
  const abort = new AbortController();
  abort.abort("cancel");
  await executeSystemTool(cancelled, abort.signal);
  expect({
    title: plexus.root.title,
    need: turn.contextNeed,
    metas: [invalid.pluginMeta, blank.pluginMeta, cancelled.pluginMeta],
  }).toEqual({ title: "Kept", need: null, metas: [{}, {}, {}] });
});

it("context requests execute inside Scheme programs, normalize, and expire at successful cutoffs", async () => {
  const { turn, call, execute } = fixture();
  const need = call("context_need", { min_remaining_tokens: 100, preserve: { rounds: 3 }, focus: " keep tests " });
  // Reparent it under the program so projection must read inner calls.
  turn.doneWork.splice(turn.doneWork.indexOf(need), 1);
  const program = new ProgrammaticJob({ toolCallId: "program", argsJson: "{}" });
  program.pushInvocation(need);
  turn.pushChild(program);
  turn.doneWork.push(program);
  expect(turn.contextNeed).toBeNull();
  await execute(need);
  expect(turn.contextNeed).toEqual({ min_remaining_tokens: 100, preserve: { rounds: 3 }, focus: "keep tests" });
  const invalid = call("context_need", { preserve: { rounds: 100 } });
  const unexecuted = call("update_metadata", { current_turn_title: "Acknowledged only" });
  unexecuted.outcomeSnap = { ok: true };
  expect(await execute(invalid)).toMatchObject({ ok: false });
  expect(turn.contextNeed?.min_remaining_tokens).toBe(100);
  turn.doneWork.push(new CompactJob({ completed: true, failed: true, reason: "overflow" }));
  expect(turn.contextNeed?.min_remaining_tokens).toBe(100);
  turn.doneWork.push(new CompactJob({ completed: true, standIn: "summary" }));
  expect(turn.contextNeed).toBeNull();
  await execute(call("context_need", { current_phase_settled: true }));
  expect(turn.contextNeed).toEqual({ current_phase_settled: true });
});

it("recall executes through its catalog body, pages results, and preserves image metadata", async () => {
  const { plexus, turn, call, execute } = fixture();
  plexus.root.path = "";
  const source = call("read_file", { path: "note.txt" });
  source.outcomeSnap = { ok: true, value: "abcdefghij" };
  source.markComplete();
  const ref = `job:${source.uuid.slice(0, 8)}`;
  const page = await execute(call("context_recall", { ref, offset: 3, length: 4 }));
  expect(page?.value).toEqual(expect.stringContaining("\ndefg"));
  expect(await execute(call("context_recall", { ref: "job:deadbeef" }))).toMatchObject({ ok: false });
  turn.visuals = [{ id: "picture", mime: "image/png", width: 1, height: 1, resizedFrom: null, sourcePath: null }];
  const visual = call("context_recall", { ref: "visual:picture" });
  const direct = await contextRecallTool.execute(visual.args, { root: process.cwd(), invocation: visual });
  expect(asToolResult(direct)).toMatchObject({ ok: true, json: { visualId: "picture" } });
  expect(await execute(visual)).toMatchObject({ ok: true, json: { visualId: "picture" } });
  const branch = new SessionTurn({ turnTail: turn, prompt: prompt.user`branch`, queue: [] });
  plexus.root.head = branch;
  const abandoned = call("read_file", { path: "other.txt" }, branch);
  abandoned.outcomeSnap = { ok: true, value: "other" };
  abandoned.markComplete();
  const abandonedRef = `job:${abandoned.uuid.slice(0, 8)}`;
  plexus.root.head = turn;
  expect(await execute(call("context_recall", { ref: abandonedRef }))).toMatchObject({ ok: false });
});
