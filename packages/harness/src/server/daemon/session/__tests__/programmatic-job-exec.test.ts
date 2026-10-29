/**
 * ProgrammaticJob executor on a live session. A program seals once —
 * including on error and with unresolved children.
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

function pendingCall(id: string): SystemToolJob {
  return new SystemToolJob({
    toolCallId: id,
    name: "echo",
    argsJson: "{}",
  });
}

async function openSession(): Promise<{ root: SessionRoot }> {
  const system = await mkdtemp(join(tmpdir(), "harness-prog-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-prog-p-"));
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

describe("ProgrammaticJob executor", () => {
  beforeEach(() => resetLocalIDs());

  it("a program seals once including on error and with unresolved children", async () => {
    const { root } = await openSession();

    const pending = pendingCall("pending");
    const sealing = new ProgrammaticJob({
      toolCallId: "ok",
      argsJson: JSON.stringify({ expr: "#t" }),
    });
    sealing.children.push(pending);
    const failing = new ProgrammaticJob({
      toolCallId: "fail",
      argsJson: JSON.stringify({ expr: "(not-a-bound-verb)" }),
    });

    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
    });
    turn.pushChild(sealing);
    turn.pushChild(failing);
    root.head = turn;

    await when(() => sealing.completed && failing.completed, { timeout: TIMEOUT });

    const late = pendingCall("late");
    sealing.children.push(late);
    await Promise.resolve();

    expect({
      sealing: {
        completed: sealing.completed,
        pending: pending.completed,
        late: late.completed,
      },
      failing: { completed: failing.completed },
    }).toEqual({
      sealing: { completed: true, pending: false, late: false },
      failing: { completed: true },
    });
  });
});
