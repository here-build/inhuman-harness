import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BehaviorKernel,
  CallerLedger,
  callMethod,
  Dict,
  EMPTY_PIN,
  foregroundChoices,
  NoteLog,
  parseAgentPin,
  pinJson,
  repin,
  toJS,
  type PluginPackage,
} from "../index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOAL: PluginPackage = {
  name: "inhuman-plugin-goal",
  root: join(HERE, "../../../../../plugins/inhuman-plugin-goal"),
};

async function goalAgent(kernel: BehaviorKernel, agentId: string) {
  const errors: string[] = [];
  const pin = await repin(foregroundChoices([GOAL], errors), EMPTY_PIN, errors);
  expect(errors).toEqual([]);
  const { agent, errors: attachErrors } = await kernel.attach({
    agentId,
    projectId: "/p",
    pin,
  });
  expect(attachErrors).toEqual([]);
  return agent;
}

async function setGoal(kernel: BehaviorKernel, agentId: string, loops: number): Promise<void> {
  const ownerId = kernel.directory.ownerId("inhuman-plugin-goal", "session", agentId, "state");
  await callMethod({
    directory: kernel.directory,
    caller: new CallerLedger(),
    bindings: new Map([
      [
        "goal",
        {
          alias: "goal",
          ownerId,
          methods: new Set(["set"]),
          abi: kernel.directory.get(ownerId).abi,
        },
      ],
    ]),
    receiver: "goal",
    method: "set",
    args: { text: "ship it", loops },
    callId: "set",
  });
}

describe("behavior host", () => {
  it("pins a foreground program and reuses an unchanged pin", async () => {
    const errors: string[] = [];
    const choices = foregroundChoices([GOAL], errors);
    const pin = await repin(choices, EMPTY_PIN, errors);
    const again = await repin(choices, parseAgentPin(pinJson(pin)), errors);
    expect({
      errors,
      pinned: pin.behaviors.map((row) => ({
        plugin: row.plugin,
        bot: row.bot,
        program: row.programPath,
        modules: row.modules.map((module) => module.path).sort(),
      })),
      reused: again.behaviors.map((row) => row.revision),
    }).toEqual({
      errors: [],
      pinned: [
        {
          plugin: "inhuman-plugin-goal",
          bot: "foreground",
          program: "behavior/foreground.scm",
          modules: ["behavior/foreground.scm"],
        },
      ],
      reused: pin.behaviors.map((row) => row.revision),
    });
  });

  it("round end runs the goal hook against its session state and activates the loop", async () => {
    const notes = new NoteLog();
    const kernel = new BehaviorKernel({ packages: () => [GOAL], notes });
    const agent = await goalAgent(kernel, "s1");
    await setGoal(kernel, "s1", 2);
    const round = agent.openBoundary("round", new Dict({ index: 1 }), "turn-1");
    const started = await round.started;
    const outcome = await round.finish({ ok: true, value: new Dict({}) });
    const ownerId = kernel.directory.ownerId("inhuman-plugin-goal", "session", "s1", "state");
    expect({
      entered: started.entered,
      hookFailures: outcome.hookFailures,
      notes: notes.peek("s1"),
      log: kernel.directory.get(ownerId).log.map((action) => toJS(action)),
    }).toEqual({
      entered: true,
      hookFailures: [],
      notes: [{ id: "note-0", text: "ship it" }],
      log: [{ type: "set", text: "ship it", loops: 2 }, { type: "tick" }],
    });
  });

  it("a failed round runs post-fail hooks, which block the goal", async () => {
    const kernel = new BehaviorKernel({
      packages: () => [GOAL],
      notes: new NoteLog(),
    });
    const agent = await goalAgent(kernel, "s2");
    await setGoal(kernel, "s2", 2);
    const round = agent.openBoundary("round", new Dict({}), "turn-1");
    await round.started;
    const outcome = await round.finish({ ok: false, error: "model crashed" });
    const ownerId = kernel.directory.ownerId("inhuman-plugin-goal", "session", "s2", "state");
    expect({
      failure: outcome.failure,
      last: toJS(kernel.directory.get(ownerId).log.at(-1) ?? false),
    }).toEqual({
      failure: "model crashed",
      last: { type: "block" },
    });
  });
});
