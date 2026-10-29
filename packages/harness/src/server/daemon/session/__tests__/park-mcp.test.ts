/**
 * Park × MCP wire: intern is not the effect. `tools/call` is.
 * Expectation stays on the Job; pewCount is started intern, not presence.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  DEFAULT_COMPACT_STRATEGY,
  DEFAULT_COMPACT_TRIGGERS,
  McpToolExpectation,
  type McpToolResult,
  MCPToolJob,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { parseProviderRegistration, PROVIDER_SDK_CONTRACT } from "@inhuman.tools/harness-provider-sdk";
import { mkdir, mkdtemp, writeJson } from "fs-extra";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { openDriverRegistry } from "@/connections";
import { McpToolActor, McpDriverConnection } from "@/providers/mcp";

import { PRODUCT_PROVIDERS } from "../../../composition.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

const TIMEOUT = 4_000;

type ParkMcpGate = {
  requests: number;
  allowDispatch: Deferred<void>;
  settle: Deferred<McpToolResult>;
};

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}

function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

let gate: ParkMcpGate;

class ParkMcpConnection extends McpDriverConnection {
  protected override createToolActor(expectation: McpToolExpectation): McpToolActor {
    return new McpToolActor(expectation, this);
  }

  override async bootstrap(): Promise<void> {
    this.readyState = "ready";
    this.bootstrapDone = true;
  }

  override async callTool(req: {
    readonly serverToolName: string;
    readonly args: Record<string, unknown>;
    readonly signal?: AbortSignal;
    readonly onDispatch?: () => void;
  }): Promise<McpToolResult> {
    const signal = req.signal ?? new AbortController().signal;
    await Promise.race([gate.allowDispatch.promise, whenAborted(signal)]);
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    req.onDispatch?.();
    gate.requests += 1;
    const result = await Promise.race([gate.settle.promise, whenAborted(signal).then(() => null)]);
    if (signal.aborted || result == null) throw new DOMException("aborted", "AbortError");
    return result;
  }
}

async function openParkMcp(): Promise<SessionDaemon> {
  const system = await mkdtemp(join(tmpdir(), "harness-park-mcp-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-park-mcp-p-"));
  const plug = join(system, "node_modules", "park-mcp-plug");
  await mkdir(plug, { recursive: true });
  await writeJson(join(plug, "package.json"), { name: "park-mcp-plug", version: "0.0.0" });
  await writeJson(join(plug, "plugin.json"), {
    name: "park-mcp-plug",
    extensions: {
      "tools.inhuman": {
        drivers: [
          {
            name: "park-mcp",
            description: "park-mcp",
            importPath: "park-mcp-plug/park-mcp-driver.mjs",
            abilityClaim: ["mcp"],
            multiplicity: "add-as-secondary",
          },
        ],
      },
    },
  });
  await writeJson(join(system, "package.json"), {
    name: "harness-kernel",
    private: true,
    dependencies: { "park-mcp-plug": "0.0.0" },
  });
  await writeJson(join(system, "config.json"), {
    connections: { mail: { driver: "park-mcp", name: "mail" } },
    compact: DEFAULT_COMPACT_STRATEGY,
    compactTriggers: { ...DEFAULT_COMPACT_TRIGGERS },
  });
  gate = {
    requests: 0,
    allowDispatch: deferred(),
    settle: deferred(),
  };
  const kernel = new KernelDaemon(
    system,
    openDriverRegistry([
      ...PRODUCT_PROVIDERS,
      parseProviderRegistration({
        id: "park-mcp",
        name: "park-mcp",
        contract: PROVIDER_SDK_CONTRACT,
        drivers: [
          {
            name: "park-mcp",
            description: "park-mcp",
            abilityClaim: ["mcp"],
            multiplicity: "add-as-secondary",
            connection: ParkMcpConnection,
          },
        ],
      }),
    ]),
  );
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("s1");
  onTestFinished(() => {
    void session.park();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  await session.handleRequest("kv/set", { key: "connection", value: "c1" });
  return session;
}

function admitMcp(session: SessionDaemon): MCPToolJob {
  const job = new MCPToolJob({
    toolCallId: "m1",
    name: "mcp__mail__ping",
    argsJson: "{}",
    connectionKey: "mail",
    serverToolName: "ping",
    humanApprove: true,
    expectation: new McpToolExpectation({
      connectionId: "mail",
      serverToolName: "ping",
      argsJson: "{}",
    }),
  });
  session.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    queue: [job],
  });
  return job;
}

function pewCount(job: MCPToolJob): number {
  return job.expectation.startedAtMs != null ? 1 : 0;
}

describe("Park MCP", () => {
  beforeEach(() => resetLocalIDs());

  it("park before tools/call does not send and does not write a cancel receipt; after waits for real settlement", async () => {
    const beforeSession = await openParkMcp();
    const beforeJob = admitMcp(beforeSession);
    await when(() => beforeJob.orchestrated, { timeout: TIMEOUT });
    await beforeSession.park();
    const before = {
      requests: gate.requests,
      live: beforeSession.interpreting,
      pew: pewCount(beforeJob),
      job: {
        dispatched: beforeJob.dispatched,
        outcome: beforeJob.receiptJson,
        completed: beforeJob.completed,
        cancelled: beforeJob.cancelled,
      },
    };

    const afterSession = await openParkMcp();
    const afterJob = admitMcp(afterSession);
    gate.allowDispatch.resolve();
    await when(() => afterJob.dispatched, { timeout: TIMEOUT });
    let parked = false;
    const parking = afterSession.park().then(() => {
      parked = true;
      return undefined;
    });
    await Promise.resolve();
    const holding = {
      parked,
      live: afterSession.interpreting,
      holding: afterSession.orchestrator.holding,
      outcome: afterJob.receiptJson,
      pew: pewCount(afterJob),
    };
    gate.settle.resolve({ ok: true, value: "pong" });
    await parking;
    const after = {
      requests: gate.requests,
      parked: true,
      holding: afterSession.orchestrator.holding,
      pew: pewCount(afterJob),
      job: { dispatched: true, outcome: afterJob.receiptJson, completed: afterJob.completed },
    };

    expect({ before, holding, after }).toEqual({
      before: {
        requests: 0,
        live: false,
        pew: 0,
        job: { dispatched: false, outcome: null, completed: false, cancelled: false },
      },
      holding: { parked: false, live: false, holding: true, outcome: null, pew: 0 },
      after: {
        requests: 1,
        parked: true,
        holding: false,
        pew: 0,
        job: { dispatched: true, outcome: JSON.stringify({ ok: true, value: "pong" }), completed: true },
      },
    });
  });
});
