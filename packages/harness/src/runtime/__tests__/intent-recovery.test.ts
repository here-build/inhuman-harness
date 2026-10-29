/**
 * Intent gate and K1 recovery against a real on-disk DocumentService.
 * getLoaded stays memory-only. Failed write is not dispatch.
 */
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import {
  AgentCallJob,
  BotCallJob,
  CallDelivery,
  CompactJob,
  CompletionExpectation,
  CompletionJob,
  ContextNeedToolJob,
  FileMutateToolJob,
  MCPToolJob,
  McpToolExpectation,
  ProgrammaticJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  TurnPromptChunk,
  TurnSteerChunk,
} from "@inhuman.tools/harness-model";
import { joinReleased, type CallsCatalog } from "@inhuman.tools/turn/agent-calls";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { documentKey, receiptCoversCheckpoint, type DocumentKey } from "@/protocol/document";
import { KernelToolCatalog, type CatalogEntry } from "@/tool-catalog";
import { documentImagePath, DocumentService } from "@/yjs";

import { persistJobIntent, recoverSessionJobs } from "../intent-recovery.js";

const temps: string[] = [];
const modes: Array<{ path: string; mode: number }> = [];

afterEach(() => {
  for (const entry of modes.splice(0)) {
    try {
      chmodSync(entry.path, entry.mode);
    } catch {}
  }
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => resetLocalIDs());

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `k2-${label}-`));
  temps.push(root);
  return root;
}

function botCall(wireName: string): CatalogEntry {
  return {
    wireName,
    description: wireName,
    parameters: { type: "object", properties: {} },
    class: "effect",
    source: { kind: "pack", pluginName: "pack" },
    packMeta: {
      kind: "bot-call",
      pluginName: "pack",
      target: "worker",
      background: true,
      lifetime: "call",
      show: "result",
      supportsNotify: false,
    },
  };
}

function catalogOf(entries: CatalogEntry[]) {
  const table = new KernelToolCatalog();
  table.replacePack(entries);
  onTestFinished(() => table[Symbol.dispose]());
  return {
    catalogEntry: (name: string) => table.catalogEntry(name),
    botRevisions: table.botRevisions,
  };
}

function closedTurn(
  child:
    | SystemToolJob
    | FileMutateToolJob
    | MCPToolJob
    | AgentCallJob
    | BotCallJob
    | ContextNeedToolJob
    | CompactJob
    | CompletionJob,
): SessionTurn {
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    queue: [],
    reducerExited: true,
  });
  turn.pushChild(child);
  return turn;
}

async function bindSession(label: string) {
  const root = tempRoot(label);
  const service = new DocumentService({ root });
  const key = documentKey("sessions", label);
  const created = await service.create(key);
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("create failed");
  const plexus = SessionPlexus.create(label, `/tmp/${label}`, created.ref.doc);
  onTestFinished(() => {
    if (!plexus.doc.isDestroyed) plexus.destroy();
  });
  return { root, service, key, plexus };
}

/** Cold open from disk, then recover: the image the restart reads is the coverage. */
async function restore(service: DocumentService, key: DocumentKey, catalog?: CallsCatalog) {
  const opened = await service.openExisting(key);
  if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
  const plexus = SessionPlexus.connect(opened.ref.doc);
  return recoverSessionJobs(plexus.root, { catalog });
}

describe("intent gate on real document storage", () => {
  it("intent/checkpoint roundtrip covers the flushed prefix", async () => {
    const { service, key, plexus } = await bindSession("roundtrip");
    const job = new SystemToolJob({
      toolCallId: "c1",
      name: "read_file",
      argsJson: "{}",
      orchestrationResult: true,
    });
    plexus.root.head = closedTurn(job);
    const checkpoint = service.checkpoint(key)!;
    const gate = await persistJobIntent(service, key, job);
    expect({
      ok: gate.ok,
      required: gate.ok ? gate.required : false,
      covers: gate.ok && gate.required && receiptCoversCheckpoint(gate.receipt, checkpoint),
      dispatch: gate.ok,
    }).toEqual({
      ok: true,
      required: true,
      covers: true,
      dispatch: true,
    });
  });

  it("failed write is not success and does not admit dispatch", async () => {
    const { root, service, key, plexus } = await bindSession("fail-write");
    const job = new SystemToolJob({
      toolCallId: "c1",
      name: "read_file",
      argsJson: "{}",
      orchestrationResult: true,
    });
    plexus.root.head = closedTurn(job);
    const image = documentImagePath(root, key.kind, key.id);
    const dir = dirname(image);
    modes.push({ path: dir, mode: 0o755 }, { path: image, mode: 0o600 });
    chmodSync(dir, 0o555);
    chmodSync(image, 0o444);
    const gate = await persistJobIntent(service, key, job);
    chmodSync(image, 0o600);
    chmodSync(dir, 0o755);
    expect({
      gate,
      dispatch: gate.ok,
      outcome: job.receiptJson,
      completed: job.completed,
    }).toEqual({
      gate: { ok: false, reason: "storage-failed" },
      dispatch: false,
      outcome: null,
      completed: false,
    });
  });

  it("getLoaded stays memory-only after a durable intent flush", async () => {
    const { root, service, key, plexus } = await bindSession("loaded");
    const job = new SystemToolJob({
      toolCallId: "c1",
      name: "read_file",
      argsJson: "{}",
      orchestrationResult: true,
    });
    plexus.root.head = closedTurn(job);
    const gate = await persistJobIntent(service, key, job);
    expect(gate.ok).toBe(true);
    const cold = new DocumentService({ root });
    expect(cold.getLoaded(key)).toBeUndefined();
    const opened = await cold.openExisting(key);
    expect({
      opened: opened.ok,
      loaded: cold.getLoaded(key) != null,
    }).toEqual({ opened: true, loaded: true });
    if (opened.ok) cold.release(key);
  });
});

describe("job recovery from a real on-disk image", () => {
  it("recovers an unsettled system tool as unknown-no-replay", async () => {
    const { root, service, key, plexus } = await bindSession("unknown-sys");
    const job = new SystemToolJob({
      toolCallId: "c1",
      name: "read_file",
      argsJson: "{}",
      orchestrationResult: true,
    });
    plexus.root.head = closedTurn(job);
    const gate = await persistJobIntent(service, key, job);
    expect(gate.ok).toBe(true);

    const restored = new DocumentService({ root });
    expect(restored.getLoaded(key)).toBeUndefined();
    const recovered = await restore(restored, key);
    const row = recovered.find((item) => item.kind === "harness:job:system-tool");
    expect({
      action: row?.action,
      completed: row?.job.completed,
      outcome: JSON.parse(row?.job instanceof SystemToolJob ? (row.job.receiptJson ?? "null") : "null"),
    }).toEqual({
      action: "unknown",
      completed: true,
      outcome: {
        ok: false,
        text: "interrupted by restart; execution outcome unknown",
      },
    });
    restored.release(key);
  });

  it("does not replay an unsettled file mutate from disk", async () => {
    const { root, service, key, plexus } = await bindSession("unknown-write");
    const job = new FileMutateToolJob({
      toolCallId: "w1",
      name: "write_file",
      argsJson: JSON.stringify({ path: "a.txt", content: "x" }),
      orchestrationResult: true,
    });
    plexus.root.head = closedTurn(job);
    const gated = await persistJobIntent(service, key, job);
    expect(gated.ok).toBe(true);

    const restored = new DocumentService({ root });
    const recovered = await restore(restored, key);
    const row = recovered.find((item) => item.kind === "harness:job:file-mutate");
    expect({
      action: row?.action,
      completed: row?.job.completed,
      kind: row?.kind,
    }).toEqual({
      action: "unknown",
      completed: true,
      kind: "harness:job:file-mutate",
    });
    restored.release(key);
  });

  it("treats dispatched MCP without a result as unknown", async () => {
    const { root, service, key, plexus } = await bindSession("unknown-mcp");
    const job = new MCPToolJob({
      toolCallId: "m1",
      name: "mcp__x__t",
      argsJson: "{}",
      orchestrationResult: true,
      expectation: new McpToolExpectation({
        connectionId: "c",
        serverToolName: "t",
      }),
    });
    job.dispatched = true;
    plexus.root.head = closedTurn(job);
    const gated = await persistJobIntent(service, key, job);
    expect(gated.ok).toBe(true);

    const restored = new DocumentService({ root });
    const recovered = await restore(restored, key);
    const row = recovered.find((item) => item.kind === "harness:job:mcp-tool");
    const mcp = row?.job instanceof MCPToolJob ? row.job : undefined;
    expect({
      action: row?.action,
      completed: row?.job.completed,
      pew: mcp?.expectation.isDone,
    }).toEqual({ action: "unknown", completed: true, pew: true });
    restored.release(key);
  });

  it("settles cancelRequested on a restored turn", async () => {
    const { root, service, key, plexus } = await bindSession("cancel");
    const job = new SystemToolJob({
      toolCallId: "c1",
      name: "read_file",
      argsJson: "{}",
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: false,
      cancelRequested: true,
    });
    turn.pushChild(job);
    plexus.root.head = turn;
    const checkpoint = service.checkpoint(key);
    expect(checkpoint).not.toBeUndefined();
    const gated = await persistJobIntent(service, key, job);
    expect(gated.ok).toBe(true);

    const restored = new DocumentService({ root });
    const recovered = await restore(restored, key);
    const turnRow = recovered.find((item) => item.kind === "harness:session:turn");
    const leaf = recovered.find((item) => item.kind === "harness:job:system-tool");
    expect({
      turn: turnRow?.action,
      reducerExited: turnRow?.job instanceof SessionTurn && turnRow.job.reducerExited,
      leafCompleted: leaf?.job.completed,
      leafCancelled: leaf?.job.cancelled,
    }).toEqual({
      turn: "cancel",
      reducerExited: true,
      leafCompleted: true,
      leafCancelled: true,
    });
    restored.release(key);
  });

  it("resume-queued context-need is not completed as unknown", async () => {
    const { root, service, key, plexus } = await bindSession("need");
    const job = new ContextNeedToolJob({
      triggersReactLoop: false,
      tapeHidden: true,
      toolCallId: "n1",
      name: "context_need",
      argsJson: "{}",
    });
    plexus.root.head = closedTurn(job);
    const gated = await persistJobIntent(service, key, job);
    expect(gated.ok).toBe(true);
    const flushed = await service.flush(key, service.checkpoint(key)!);
    expect(flushed.ok).toBe(true);

    const restored = new DocumentService({ root });
    const recovered = await restore(restored, key);
    const row = recovered.find((item) => item.kind === "harness:job:context-need");
    expect({
      action: row?.action,
      completed: row?.job.completed,
      outcome: row?.job instanceof ContextNeedToolJob ? row.job.receiptJson : "missing",
    }).toEqual({
      action: "dispatch",
      completed: false,
      outcome: null,
    });
    restored.release(key);
  });

  it.each([{ name: "child", CallType: AgentCallJob }])(
    "rejoins an owned $name invocation without adopting bot acceptance",
    async ({ name, CallType }) => {
      const { root, service, key, plexus } = await bindSession(`${name}-rejoin`);
      const call = new CallType({
        name: "agent__ask",
        orchestrationResult: true,
        workerSessionId: "existing-child",
      });
      plexus.root.head = closedTurn(call);
      const gate = await persistJobIntent(service, key, call);
      expect(gate.ok).toBe(true);
      const flushed = await service.flush(key, service.checkpoint(key)!);
      expect(flushed.ok).toBe(true);

      const restored = new DocumentService({ root });
      const recovered = await restore(restored, key);
      const row = recovered.find((item) => item.kind === "harness:job:child-agent-call");
      const child = row?.job instanceof AgentCallJob ? row.job : undefined;
      expect({ action: row?.action, worker: child?.workerSessionId, completed: child?.completed }).toEqual({
        action: "resume-inner",
        worker: "existing-child",
        completed: false,
      });
      restored.release(key);
    },
  );

  it("a recovered BotCall resumes; its join waits on the re-run delivery, not on caller fields", async () => {
    const catalog = catalogOf([botCall("offload")]);
    const { root, service, key, plexus } = await bindSession("accept");
    const call = new BotCallJob({
      name: "offload",
      background: true,
      orchestrationResult: true,
      acceptedAt: 1,
      preparedInputJson: JSON.stringify({ prepared: true }),
      workerSessionId: "worker",
    });
    plexus.root.head = closedTurn(call);
    const gated = await persistJobIntent(service, key, call);
    expect(gated.ok).toBe(true);

    const restored = new DocumentService({ root });
    const recovered = await restore(restored, key, catalog);
    const row = recovered.find((item) => item.kind === "harness:job:bot-call");
    const resumed = row?.job instanceof BotCallJob ? row.job : undefined;
    expect({
      action: row?.action,
      join: resumed != null && joinReleased(resumed, catalog),
    }).toEqual({ action: "resume-inner", join: false });
    restored.release(key);
  });

  it("cancelRequested without catalog skips call-lifetime Calls", async () => {
    const { root, service, key, plexus } = await bindSession("cancel-work");
    const call = new BotCallJob({
      name: "offload",
      background: true,
      delivery: new CallDelivery({ lifetime: "call" }),
      workerSessionId: "worker",
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      reducerExited: false,
      cancelRequested: true,
    });
    turn.pushChild(call);
    plexus.root.head = turn;
    const flushed = await service.flush(key, service.checkpoint(key)!);
    expect(flushed.ok).toBe(true);

    const restored = new DocumentService({ root });
    const recovered = await restore(restored, key);
    const callRow = recovered.find((item) => item.kind === "harness:job:bot-call");
    expect({
      completed: callRow?.job.completed,
      cancelled: callRow?.job.cancelled,
    }).toEqual({ completed: false, cancelled: false });
    restored.release(key);
  });

  it("queued completion without intent is not auto-replayed after owner death once intended", async () => {
    const { root, service, key, plexus } = await bindSession("completion");
    const job = new CompletionJob({
      expectation: new CompletionExpectation({ connectionId: "c" }),
      orchestrationResult: true,
    });
    plexus.root.head = closedTurn(job);
    const gated = await persistJobIntent(service, key, job);
    expect(gated.ok).toBe(true);

    const restored = new DocumentService({ root });
    const recovered = await restore(restored, key);
    const row = recovered.find((item) => item.kind === "harness:job:completion");
    const completion = row?.job instanceof CompletionJob ? row.job : undefined;
    expect({
      action: row?.action,
      completed: row?.job.completed,
      pew: completion?.expectation.isDone,
    }).toEqual({ action: "unknown", completed: true, pew: true });
    restored.release(key);
  });
});

describe("job recovery on a live replica", () => {
  it("closes a cancelled program and completion a crash left open", () => {
    const plexus = SessionPlexus.create("cancel-open", "/tmp/cancel-open");
    onTestFinished(() => plexus.destroy());
    const program = new ProgrammaticJob({ toolCallId: "p1", orchestrationResult: true, cancelled: true });
    const completion = new CompletionJob({
      expectation: new CompletionExpectation({ connectionId: "c" }),
      orchestrationResult: true,
      cancelled: true,
    });
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], reducerExited: true });
    turn.pushChild(program);
    turn.pushChild(completion);
    plexus.root.head = turn;
    const rows = recoverSessionJobs(plexus.root);
    expect({
      actions: rows.filter((row) => row.job !== turn).map((row) => row.action),
      program: [program.completed, program.receiptJson != null],
      completion: [completion.completed, completion.expectation.isDone],
    }).toEqual({ actions: ["cancel", "cancel"], program: [true, true], completion: [true, true] });
  });

  it("puts back a round token a crash left behind its claim cells", () => {
    const plexus = SessionPlexus.create("token", "/tmp/token");
    onTestFinished(() => plexus.destroy());
    const token = new TurnPromptChunk();
    const steer = new TurnSteerChunk();
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      doneWork: [token, steer],
      reducerExited: false,
      orchestrationResult: true,
    });
    plexus.root.head = turn;
    recoverSessionJobs(plexus.root);
    expect({ queue: turn.queue[0] === token, done: [...turn.doneWork] }).toEqual({ queue: true, done: [steer] });
  });

  it("leaves a round token whose completion is already queued", () => {
    const plexus = SessionPlexus.create("token-owed", "/tmp/token-owed");
    onTestFinished(() => plexus.destroy());
    const token = new TurnPromptChunk();
    const completion = new CompletionJob({ expectation: new CompletionExpectation({ connectionId: "c" }) });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [completion],
      doneWork: [token],
      reducerExited: false,
      orchestrationResult: true,
    });
    plexus.root.head = turn;
    recoverSessionJobs(plexus.root);
    expect({ queue: [...turn.queue], done: [...turn.doneWork] }).toEqual({ queue: [completion], done: [token] });
  });
});
