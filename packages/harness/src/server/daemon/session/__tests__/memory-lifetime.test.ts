/**
 * Step 3 call-lifetime matrix (not lease×spine projection).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resetLocalIDs } from "@here.build/plexus";
import {
  BotCallJob,
  AgentCallbackJob,
  FailureOutcome,
  SessionSystemPrompt,
  SessionTurn,
  SuccessfulOutcome,
} from "@inhuman.tools/harness-model";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { applyPackPlugins } from "../../../toolkit/actor.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import { completeCallExceptionally } from "../agent-runtime.js";

const FIXTURE_PLUGIN = fileURLToPath(
  new URL("../../../toolkit/__tests__/fixtures/plugin-abi-fixture/plugin.js", import.meta.url),
);
const TIMEOUT = 8_000;

async function openHarness() {
  const system = await mkdtemp(join(tmpdir(), "harness-life-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-life-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const fixture = await import(FIXTURE_PLUGIN);
  await applyPackPlugins(kernel.catalog, [{ pluginName: "abi-fixture", module: fixture }]);
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("caller");
  session.root.kvs.connection = "dummy";
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return { kernel, project, session };
}

describe("memory lifetime step 3", () => {
  beforeEach(() => resetLocalIDs());

  it("call_and_turn_lifetime_transition_matrix", async () => {
    const { kernel, project, session } = await openHarness();

    const offload = new BotCallJob({
      toolCallId: "off1",
      name: "fixture_offload",
      argsJson: JSON.stringify({ guidance: "x" }),
      humanApprove: true,
      background: true,
      walkBoundary: true,
    });
    const tingle = new BotCallJob({
      toolCallId: "ting1",
      name: "fixture_tingle",
      argsJson: JSON.stringify({ prompt: "q" }),
      humanApprove: true,
      background: true,
      walkBoundary: true,
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [offload],
      reducerExited: false,
    });
    turn.pushChild(tingle);
    session.root.head = turn;
    await when(
      () =>
        offload.workerSessionId !== "" &&
        tingle.workerSessionId !== "" &&
        kernel.sessionPlexus(offload.workerSessionId)?.root.findTurnByAgentRequestId(offload.uuid) != null &&
        kernel.sessionPlexus(tingle.workerSessionId)?.root.findTurnByAgentRequestId(tingle.uuid) != null,
      { timeout: TIMEOUT },
    );

    completeCallExceptionally(tingle, { kernel, project, caller: session.root }, "cancelled");
    const afterTingle = { tingle: tingle.completed, offload: offload.completed };
    completeCallExceptionally(offload, { kernel, project, caller: session.root }, "cancelled");
    const offload2 = new BotCallJob({
      toolCallId: "off2",
      name: "fixture_offload",
      argsJson: JSON.stringify({ guidance: "y" }),
      humanApprove: true,
      background: true,
      walkBoundary: true,
    });
    const turn2 = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [offload2], reducerExited: false });
    session.root.head = turn2;
    await when(
      () =>
        offload2.workerSessionId !== "" &&
        kernel.sessionPlexus(offload2.workerSessionId)?.root.findTurnByAgentRequestId(offload2.uuid) != null,
      { timeout: TIMEOUT },
    );
    await session.park();
    const parked = offload2.completed;
    const resumed = await project.session("caller");
    await when(() => offload2.workerSessionId !== "" && !offload2.completed, { timeout: TIMEOUT });
    const worker = project.sessions[offload2.workerSessionId]!;
    worker.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: true,
    });
    worker.root.head.pushChild(
      new AgentCallbackJob({
        name: "agent__respond",
        argsJson: JSON.stringify({ requestId: offload2.uuid, response: "kept" }),
        humanApprove: true,
      }),
    );
    await when(() => offload2.completed, { timeout: TIMEOUT });
    expect({
      afterTingle,
      offload: {
        completed: offload.completed,
        outcome:
          offload.outcome instanceof FailureOutcome
            ? { code: offload.outcome.code, message: offload.outcome.message }
            : offload.outcome,
      },
      park: parked,
      resume: offload2.outcome instanceof SuccessfulOutcome ? offload2.outcome.value : offload2.outcome,
    }).toEqual({
      afterTingle: { tingle: true, offload: false },
      offload: { completed: true, outcome: { code: "cancelled", message: "" } },
      park: false,
      resume: "kept",
    });
    resumed[Symbol.dispose]();
  });
});
