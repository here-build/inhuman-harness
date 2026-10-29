/**
 * Kernel caller→worker edges: snap from a tape, write onto KernelRoot,
 * retract when the Call leaves that caller.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { beforeEach, expect, test } from "vitest";

import { AgentCallJob, BotCallJob, SessionPlexus, SessionSystemPrompt, SessionTurn } from "../../session/index.js";
import { applyAgentRelations, outgoingAgentRelations } from "../agent-relations.js";
import { KernelRoot } from "../KernelRoot.js";

beforeEach(() => resetLocalIDs());

test("kernel agentCalls follow interned tape calls and retract leftovers", () => {
  const session = SessionPlexus.create("parent", "/tmp/p");
  const nested = new BotCallJob({
    toolCallId: "c-qa",
    name: "agent__send",
    argsJson: JSON.stringify({ spec: "qa", message: "check" }),
    workerSessionId: "qa",
  });
  const explore = new AgentCallJob({
    toolCallId: "c-explore",
    name: "agent__ask",
    argsJson: JSON.stringify({ spec: "explore", message: "map" }),
    workerSessionId: "explore",
  });
  session.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`go`,
    doneWork: [explore, nested],
    queue: [],
  });
  const kernel = new KernelRoot();
  applyAgentRelations(kernel, "parent", outgoingAgentRelations(session.root));
  const snap = () =>
    Object.values(kernel.agentCalls)
      .map((row) => ({
        id: row.callId,
        caller: row.callerSessionId,
        worker: row.workerSessionId,
        spec: row.spec,
        oneShot: row.oneShot,
        completed: row.completed,
      }))
      .sort((a, b) => a.worker.localeCompare(b.worker));
  expect(snap()).toEqual([
    {
      id: explore.uuid,
      caller: "parent",
      worker: "explore",
      spec: "explore",
      oneShot: true,
      completed: false,
    },
    {
      id: nested.uuid,
      caller: "parent",
      worker: "qa",
      spec: "qa",
      oneShot: false,
      completed: false,
    },
  ]);

  nested.completed = true;
  applyAgentRelations(kernel, "parent", outgoingAgentRelations(session.root));
  expect(kernel.agentCalls[nested.uuid]?.completed).toBe(true);

  session.root.head = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`done`, queue: [] });
  applyAgentRelations(kernel, "other", [
    {
      id: "keep-other",
      workerSessionId: "w",
      spec: "echo",
      oneShot: false,
      completed: false,
    },
  ]);
  applyAgentRelations(kernel, "parent", outgoingAgentRelations(session.root));
  expect(snap()).toEqual([
    {
      id: "keep-other",
      caller: "other",
      worker: "w",
      spec: "echo",
      oneShot: false,
      completed: false,
    },
  ]);
});
