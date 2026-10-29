/**
 * Tool/constitution snapshot and closed vs running.
 */
import { mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  emitSystemPrompt,
  HARNESS_CONSTITUTION,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  systemPartsOf,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { ConnectionSpec } from "@inhuman.tools/plexus-expectations";
import { mkdtemp, writeJson } from "fs-extra";
import { beforeEach, describe, expect, it } from "vitest";

import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../daemon/project/ProjectDaemon.js";

const DEMO_PACK = fileURLToPath(new URL("../toolkit/__tests__/fixtures/demo-pack", import.meta.url));

const NEW_CONSTITUTION = "constitution: harness/new\nYou are a newer agent.";

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() >= deadline) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function seedDemoPackKernel(): Promise<string> {
  const system = await mkdtemp(join(tmpdir(), "harness-pack-"));
  await writeJson(join(system, "package.json"), {
    name: "harness-kernel",
    private: true,
    dependencies: { "demo-pack": "0.0.0" },
  });
  await writeJson(join(system, "config.json"), { connections: {} });
  mkdirSync(join(system, "node_modules"), { recursive: true });
  symlinkSync(DEMO_PACK, join(system, "node_modules", "demo-pack"));
  return system;
}

describe("SessionUnit", () => {
  beforeEach(() => resetLocalIDs());

  it("tool/constitution snapshot", async () => {
    const genesis = new SessionSystemPrompt({
      constitution: HARNESS_CONSTITUTION,
      env: { cwd: "/tmp/demo", date: "2026-08-01", branch: "main" },
    });
    const envTurn = new SessionTurn({ turnTail: genesis, prompt: prompt.user`env` });
    const overlay = emitSystemPrompt(envTurn, {
      reason: "branch changed",
      env: { branch: null },
    });
    const env = {
      overlay: overlay.env,
      turn: systemPartsOf(envTurn).env,
      genesis: genesis.env,
    };

    const system = await seedDemoPackKernel();
    const workspace = await mkdtemp(join(tmpdir(), "harness-pack-p-"));
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    try {
      const session = await project.session("s1");
      await session.handleRequest("kv/set", { key: "connection", value: "c1" });
      await session.handleRequest("turn", { prompt: "hello" });

      const admitted = session.root.head!;
      admitted.reducerExited = true;
      session.root.agent.spec.instructions = prompt.system`${NEW_CONSTITUTION}`;
      await session.handleRequest("turn", { prompt: "again" });
      const inherited = session.root.head!;

      await writeJson(join(system, "config.json"), {
        connections: {},
        plugins: { "demo-pack": { enabled: false } },
      });
      await waitFor(() => kernel.plexus.root.plugins["demo-pack"]?.enabled === false);

      inherited.reducerExited = true;
      await session.handleRequest("turn", { prompt: "after drop" });
      const afterDrop = session.root.head!;

      const completion = new CompletionExpectation({
        connectionId: "c1",
        promptText: prompt.user`after drop`,
      });
      completion.outcome = "successful";
      afterDrop.doneWork.push(new CompletionJob({ expectation: completion }));
      afterDrop.queue.splice(0);
      afterDrop.reducerExited = true;

      const compactResult = await session.handleRequest("compact", {});
      const compactTurn = session.root.head!;

      compactTurn.reducerExited = true;
      await session.handleRequest("turn", { prompt: "after compact" });
      const afterCompact = session.root.head!;

      const mcpDriver = kernel.plexus.root.drivers["mcp-stdio"];
      kernel.plexus.root.connections = {
        ...kernel.plexus.root.connections,
        github: new ConnectionSpec({ driver: mcpDriver!, name: "github" }),
      };
      afterCompact.reducerExited = true;
      await session.handleRequest("turn", { prompt: "after mcp" });
      const afterMcp = session.root.head!;

      expect({
        env,
        admitted: {
          toolsDefinition: admitted.toolsDefinition !== null,
          reloadTools: admitted.reloadTools,
          tools: admitted.tools.entries.map((tool) => tool.name),
          mcpConnections: admitted.tools.mcpConnections,
        },
        inherited: {
          toolsDefinition: inherited.toolsDefinition,
          sameTools: inherited.tools === admitted.tools,
        },
        constitution: {
          reason: inherited.derivation?.reason ?? null,
          constitution: inherited.derivation?.constitution ?? null,
          genesis: admitted.turnTail instanceof SessionSystemPrompt ? admitted.turnTail.constitution : null,
          admittedDerivation: admitted.derivation,
        },
        afterDrop: {
          toolsDefinition: afterDrop.toolsDefinition,
          sameTools: afterDrop.tools === admitted.tools,
          stillHasDemoPing: afterDrop.tools.entries.some((tool) => tool.name === "demo_ping"),
          hasGrep: afterDrop.tools.entries.some((tool) => tool.name === "grep"),
        },
        compactTurn: {
          result: compactResult,
          toolsDefinition: compactTurn.toolsDefinition,
          reloadTools: compactTurn.reloadTools,
          sameTools: compactTurn.tools === admitted.tools,
          stillHasDemoPing: compactTurn.tools.entries.some((tool) => tool.name === "demo_ping"),
        },
        afterCompact: {
          toolsDefinition: afterCompact.toolsDefinition !== null,
          tools: afterCompact.tools.entries.map((tool) => tool.name),
          admittedStillHasDemoPing: admitted.tools.entries.some((tool) => tool.name === "demo_ping"),
        },
        afterMcp: {
          toolsDefinition: afterMcp.toolsDefinition !== null,
          newSet: afterMcp.tools !== afterCompact.tools,
          mcpConnections: afterMcp.tools.mcpConnections,
          previousMcp: afterCompact.tools.mcpConnections,
        },
      }).toEqual({
        env: {
          overlay: { branch: null },
          turn: { cwd: "/tmp/demo", date: "2026-08-01" },
          genesis: { cwd: "/tmp/demo", date: "2026-08-01", branch: "main" },
        },
        admitted: {
          toolsDefinition: true,
          reloadTools: false,
          tools: expect.arrayContaining(["write_file", "scheme_repl", "shell"]),
          mcpConnections: [],
        },
        inherited: {
          toolsDefinition: null,
          sameTools: true,
        },
        constitution: {
          reason: "constitution changed",
          constitution: NEW_CONSTITUTION,
          genesis: HARNESS_CONSTITUTION,
          admittedDerivation: null,
        },
        afterDrop: {
          toolsDefinition: null,
          sameTools: true,
          stillHasDemoPing: false,
          hasGrep: false,
        },
        compactTurn: {
          result: { ok: true, compacted: false },
          toolsDefinition: null,
          reloadTools: true,
          sameTools: true,
          stillHasDemoPing: false,
        },
        afterCompact: {
          toolsDefinition: true,
          tools: expect.not.arrayContaining(["demo_ping"]),
          admittedStillHasDemoPing: false,
        },
        afterMcp: {
          toolsDefinition: true,
          newSet: true,
          mcpConnections: ["github"],
          previousMcp: [],
        },
      });
    } finally {
      project[Symbol.dispose]();
      kernel[Symbol.dispose]();
    }
  }, 20_000);

  it("closed vs running; background does not close the turn", () => {
    const session = new SessionRoot({ sessionId: "s-closed", path: "/tmp/demo" });
    const round = new CompletionExpectation({ connectionId: "c1" });
    round.outcome = "successful";
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hi`,
      doneWork: [new CompletionJob({ expectation: round })],
      queue: [],
    });
    session.head = turn;

    const before = {
      reducerExited: turn.reducerExited,
      running: session.findRunningTurn(),
    };

    const background = new SystemToolJob({
      toolCallId: "bg",
      name: "echo",
      argsJson: "{}",
      background: true,
    });
    turn.pushChild(background);

    const afterBackground = {
      reducerExited: turn.reducerExited,
      running: session.findRunningTurn(),
      backgroundOpen: !background.completed,
    };

    turn.reducerExited = true;
    expect({
      before,
      afterBackground,
      afterClosed: {
        reducerExited: turn.reducerExited,
        running: session.findRunningTurn(),
        backgroundOpen: !background.completed,
      },
    }).toEqual({
      before: { reducerExited: false, running: turn },
      afterBackground: {
        reducerExited: false,
        running: turn,
        backgroundOpen: true,
      },
      afterClosed: {
        reducerExited: true,
        running: null,
        backgroundOpen: true,
      },
    });
  });
});
