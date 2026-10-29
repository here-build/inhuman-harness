/** A program run leaves children a replay can fold into the same graph the feed used to serve. */
import { rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvalTrace, traceToRegions } from "@here.build/arrival-provenance";
import {
  evalProgramOf,
  findEvalTurnByRequestId,
  isWorkflowLeafMeta,
  type WorkflowLeafMeta,
} from "@inhuman.tools/harness-model";
import { replayScheme } from "@inhuman.tools/harness-scheme/replay";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { KernelDaemon } from "../../daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../daemon/project/ProjectDaemon.js";
import type { SessionDaemon } from "../../daemon/session/SessionDaemon.js";

const TIMEOUT = 8_000;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Leaf = { readonly kind: "leaf"; readonly meta?: unknown };
type Node = { readonly kind: string; readonly iterations?: readonly (readonly Node[])[] };

function leavesOf(nodes: readonly Node[]): Leaf[] {
  return nodes.flatMap((node) =>
    node.kind === "leaf" ? [node as Leaf] : node.kind === "fanout" ? leavesOf((node.iterations ?? []).flat()) : [],
  );
}

async function openSession(): Promise<SessionDaemon> {
  const system = await mkdtemp(join(tmpdir(), "harness-wf-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-wf-p-"));
  dirs.push(system, workspace);
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

async function graphOf(program: Parameters<typeof replayScheme>[0]): Promise<Node[]> {
  const trace = new EvalTrace();
  trace.withAutoBindings();
  await replayScheme(program, trace, new AbortController().signal);
  return traceToRegions(trace).roots as Node[];
}

const PROGRAM = `(define sources (map (lambda (f) (read_file f)) (list "a.txt" "b.txt")))
(shell "true")
(grep "needle" :path "a.txt")`;

describe("a replayed program", () => {
  it("names each inner job on the leaf that called it, and a map is a fanout", async () => {
    const session = await openSession();
    await writeFile(join(session.root.path, "a.txt"), "a needle\n");
    await writeFile(join(session.root.path, "b.txt"), "b\n");
    await session.handleRequest("eval", { requestId: "wf", expr: PROGRAM, policy: "yolo" });
    const turn = findEvalTurnByRequestId(session.root, "wf")!;
    const program = evalProgramOf(turn)!;
    await when(() => program.completed && turn.reducerExited, { timeout: TIMEOUT });

    const leaves = leavesOf(await graphOf(program));
    const metas = leaves.map((leaf) => leaf.meta as WorkflowLeafMeta);
    expect(metas.every(isWorkflowLeafMeta)).toBe(true);
    expect(metas.map(({ kind, verb, name, args }) => ({ kind, verb, name, args }))).toEqual([
      { kind: "tool", verb: "read_file", name: "read_file", args: { path: "a.txt" } },
      { kind: "tool", verb: "read_file", name: "read_file", args: { path: "b.txt" } },
      { kind: "tool", verb: "shell", name: "shell", args: { command: "true" } },
      { kind: "tool", verb: "grep", name: "grep", args: { pattern: "needle", path: "a.txt" } },
    ]);
    expect(metas.map((meta) => meta.jobId)).toEqual(program.toolCalls.map((inner) => inner.uuid));
    expect((await graphOf(program)).some((node) => node.kind === "fanout")).toBe(true);
  });

  it("stamps the worker, the message and the model on a mapped agent call", async () => {
    const session = await openSession();
    await session.handleRequest("eval", {
      requestId: "agents",
      expr: `(map (lambda (area) (guard (e (#t "no worker")) (agent/call "explore" (string-append "look at " area) :model "x/y"))) (list "api" "ui"))`,
      policy: "yolo",
    });
    const turn = findEvalTurnByRequestId(session.root, "agents")!;
    const program = evalProgramOf(turn)!;
    await when(() => program.completed && turn.reducerExited, { timeout: TIMEOUT });
    const leaves = leavesOf(await graphOf(program));
    expect(
      leaves.map((leaf) => {
        const { kind, verb, name, model, message, jobId } = leaf.meta as WorkflowLeafMeta;
        return { kind, verb, name, model, message, jobId };
      }),
    ).toEqual(
      ["look at api", "look at ui"].map((message, at) => ({
        kind: "agent",
        verb: "agent/call",
        name: "explore",
        model: "x/y",
        message,
        jobId: program.toolCalls[at]!.uuid,
      })),
    );
  });
});
