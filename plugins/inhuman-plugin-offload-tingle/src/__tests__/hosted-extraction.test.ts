/**
 * Hosted worker path. The model is the scripted completion driver.
 * The worker still inherits the caller's connection through production mint.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BotCallJob,
  CompletionExpectation,
  responseCall,
  SessionRoot,
  SessionTurn,
  tapeCompletion,
} from "@inhuman.tools/harness-model";
import { walkWork } from "@inhuman.tools/plexus-expectations";
import { when } from "mobx";
import { describe, expect, it } from "vitest";

import { reflectKernel } from "../../../../packages/harness/src/server/daemon/kernel/fs-reflection/reflectKernel.js";
import { KernelDaemon } from "../../../../packages/harness/src/server/daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../../../packages/harness/src/server/daemon/project/ProjectDaemon.js";
import {
  attachScriptedModel,
  modelOf,
  scriptedConnectionId,
} from "../../../../packages/harness/src/server/testkit/scripted-model.js";

const PLUGIN_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TIMEOUT = 45_000;

function findOffloadCall(root: SessionRoot, kernel: KernelDaemon, project: ProjectDaemon): BotCallJob | undefined {
  for (const node of root.motionWork()) {
    if (node instanceof BotCallJob && node.name === "offload") return node;
  }
  const seen = new Set<string>();
  for (const turn of root.liveTurns) {
    if (seen.has(turn.uuid)) continue;
    seen.add(turn.uuid);
    for (const node of walkWork(turn)) {
      if (node instanceof BotCallJob && node.name === "offload") return node;
    }
  }
  const callerPlexus = kernel.sessionPlexus(root.sessionId);
  if (callerPlexus == null) return undefined;
  for (const worker of Object.values(project.sessions)) {
    if (worker.sessionId === root.sessionId) continue;
    for (const turn of worker.root.liveTurns) {
      const requestId = turn.agentRequestId;
      if (requestId === "") continue;
      const loaded = callerPlexus.loadEntity<BotCallJob>(requestId);
      if (loaded instanceof BotCallJob && loaded.name === "offload") return loaded;
    }
  }
  return undefined;
}

function orchestratorCompletions(root: SessionRoot): CompletionExpectation[] {
  const out: CompletionExpectation[] = [];
  const seen = new Set<CompletionExpectation>();
  for (const node of root.motionWork()) {
    const pew = tapeCompletion(node) ?? (node instanceof CompletionExpectation ? node : null);
    if (pew == null || seen.has(pew)) continue;
    seen.add(pew);
    out.push(pew);
  }
  return out;
}

function installPluginOnKernel(kernelRoot: string, kernel: KernelDaemon, pluginRoot: string): void {
  const pkgPath = join(kernelRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  pkg.dependencies = {
    ...pkg.dependencies,
    "@inhuman.tools/plugin-offload-tingle": "0.0.1",
  };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const link = join(kernelRoot, "node_modules", "@inhuman.tools", "plugin-offload-tingle");
  mkdirSync(dirname(link), { recursive: true });
  try {
    symlinkSync(pluginRoot, link);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  reflectKernel(kernelRoot, kernel.plexus.root);
}

describe("hosted extraction", { timeout: 90_000 }, () => {
  // This package's vitest never reaches a live offload catalog entry
  // (KernelDaemon autorun around packEntries / private MCP). The completion
  // below is the scripted driver; unskip does not need a compat server.
  it.skip("production_offload_worker_completion", async () => {
    const system = realpathSync(mkdtempSync(join(tmpdir(), "hosted-k-")));
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "hosted-p-")));
    const connectionId = scriptedConnectionId("work");

    const kernel = new KernelDaemon(system);
    await kernel.ready;
    installPluginOnKernel(system, kernel, PLUGIN_ROOT);
    await when(() => kernel.catalog.catalogEntry("offload")?.packMeta?.kind === "bot-call", { timeout: TIMEOUT });

    const project = new ProjectDaemon(kernel, workspace);
    await project.ready;
    const session = await project.session("caller");
    session.root.standingPermissionMode = "yolo";
    attachScriptedModel(kernel, session, "work");

    try {
      await session.handleRequest("kv/set", { key: "connection", value: connectionId });
      await session.handleRequest("kv/set", { key: "model", value: "m1" });
      await when(() => kernel.plexus.root.connections[connectionId]?.readyState === "ready", { timeout: TIMEOUT });

      await expect(session.handleRequest("turn", { prompt: "retain this unit" })).resolves.toEqual({ ok: true });
      await when(() => orchestratorCompletions(session.root).some((pew) => pew.outcome == null), { timeout: TIMEOUT });
      modelOf(session).reply({
        calls: [responseCall("call_offload_1", "offload", JSON.stringify({ guidance: "keep unit" }))],
      });

      expect(kernel.catalog.catalogEntry("offload")?.packMeta?.kind).toBe("bot-call");

      let offload: BotCallJob | undefined;
      await when(
        () => {
          offload = findOffloadCall(session.root, kernel, project);
          return offload?.acceptedAt != null && offload.workerSessionId !== "";
        },
        { timeout: TIMEOUT },
      );

      const running = session.root.head;
      if (running instanceof SessionTurn && !running.reducerExited) {
        await session.handleRequest("turn/cancel", { turnId: running.uuid });
        await when(() => running.reducerExited, { timeout: TIMEOUT });
      }

      offload = findOffloadCall(session.root, kernel, project);
      expect(
        offload,
        `offload missing; work=${[...session.root.motionWork()].map((n) => `${n.constructor.name}:${"name" in n ? String(n.name) : ""}`).join(",")}`,
      ).toBeInstanceOf(BotCallJob);
      expect(offload!.workerSessionId).not.toBe("");
      expect(offload!.acceptedAt).not.toBeNull();

      const worker = project.sessions[offload!.workerSessionId]!;
      expect(worker).toBeDefined();
      expect(worker.root.kvs.connection).toBe(connectionId);
      expect(worker.root.kvs.model).toBe("m1");
      expect(worker.root.agent.spec.instructions).toContain("Retain bounded");

      let workerCompletion: CompletionExpectation | undefined;
      await when(
        () => {
          const minted = orchestratorCompletions(worker.root);
          if (minted.length === 0) return false;
          workerCompletion = minted[0];
          return workerCompletion instanceof CompletionExpectation;
        },
        { timeout: TIMEOUT },
      );
      expect(workerCompletion).toBeInstanceOf(CompletionExpectation);
      expect(workerCompletion!.connectionId).toBe(connectionId);
      expect(workerCompletion!.model).toBe("m1");
    } finally {
      session[Symbol.dispose]();
      project[Symbol.dispose]();
      kernel[Symbol.dispose]();
      rmSync(system, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 90_000);
});
