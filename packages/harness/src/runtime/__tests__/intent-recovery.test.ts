/**
 * Intent gate and K1 recovery against real on-disk HarnessDatabase SQLite storage.
 * Cold opens read only committed SQLite rows. Failed write is not dispatch.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  SessionDocument,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  TurnPromptChunk,
  TurnSteerChunk,
} from "@inhuman.tools/harness-model";
import {
  commitSessionNodesInBatch,
  loadSessionNodesFromKv,
  loadSessionRuntimeMetaFromKv,
} from "@inhuman.tools/scope-plane";
import { SqliteKvStore } from "@inhuman.tools/scope-plane-sqlite";
import { joinReleased, type CallsCatalog } from "@inhuman.tools/turn/agent-calls";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { KernelToolCatalog, type CatalogEntry } from "@/tool-catalog";

import { persistJobIntent, recoverSessionJobs } from "../intent-recovery.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
  const dbPath = join(root, "harness.db");
  const db = new SqliteKvStore(dbPath);
  const doc = SessionDocument.create(label, `/tmp/${label}`);
  let closed = false;
  onTestFinished(async () => {
    if (!doc.isDestroyed) doc.destroy();
    if (!closed) {
      closed = true;
      await db.close();
    }
  });
  await db.set("sessions", {
    sessionId: label,
    workspacePath: doc.root.path,
    createdAtMs: Date.now(),
    lastActiveAtMs: Date.now(),
  });
  const flush = async (): Promise<void> => {
    const delta = doc.peekNodeDelta();
    await db.batch((tx) => {
      commitSessionNodesInBatch(tx, label, {
        rootId: doc.root.uuid,
        revision: delta.revision,
        upserts: delta.upserts,
        deletes: delta.deletes,
      });
    });
    doc.commitNodeDelta(delta);
  };
  await flush();
  return { root, dbPath, db, sessionId: label, doc, flush };
}

/** Cold open from SQLite on disk, then recover: the rows a restart reads are the coverage. */
async function restore(dbPath: string, sessionId: string, catalog?: CallsCatalog) {
  const cold = new SqliteKvStore(dbPath);
  onTestFinished(() => cold.close());
  const loaded = await loadSessionNodesFromKv(cold, sessionId);
  if (loaded === undefined) throw new Error(`open failed: not-found (${sessionId})`);
  const doc = SessionDocument.fromNodeRows(loaded.rows, {
    rootId: loaded.rootId,
    sessionId,
    revision: loaded.revision,
    meta: await loadSessionRuntimeMetaFromKv(cold, sessionId),
  });
  onTestFinished(() => {
    if (!doc.isDestroyed) doc.destroy();
  });
  return recoverSessionJobs(doc.root, { catalog });
}

describe("intent gate on real SQLite storage", () => {
  it("intent/checkpoint roundtrip covers the flushed prefix", async () => {
    const { db, sessionId, doc, flush } = await bindSession("roundtrip");
    const job = new SystemToolJob({
      toolCallId: "c1",
      name: "read_file",
      argsJson: "{}",
      orchestrationResult: true,
    });
    doc.root.head = closedTurn(job);
    const beforeRows = (await loadSessionNodesFromKv(db, sessionId))?.rows ?? [];
    expect(beforeRows.some((row) => row.uuid === job.uuid)).toBe(false);
    const gate = await persistJobIntent(flush, job);
    const afterRows = (await loadSessionNodesFromKv(db, sessionId))?.rows ?? [];
    expect({
      ok: gate.ok,
      required: gate.ok ? gate.required : false,
      covers: afterRows.some((row) => row.uuid === job.uuid),
      dispatch: gate.ok,
    }).toEqual({
      ok: true,
      required: true,
      covers: true,
      dispatch: true,
    });
  });

  it("failed write is not success and does not admit dispatch", async () => {
    const { db, sessionId, doc, flush } = await bindSession("fail-write");
    const job = new SystemToolJob({
      toolCallId: "c1",
      name: "read_file",
      argsJson: "{}",
      orchestrationResult: true,
    });
    doc.root.head = closedTurn(job);
    db.setReadOnly(true);
    const gate = await persistJobIntent(flush, job);
    db.setReadOnly(false);
    const stored = (await loadSessionNodesFromKv(db, sessionId))?.rows ?? [];
    expect({
      gate,
      dispatch: gate.ok,
      persisted: stored.some((row) => row.uuid === job.uuid),
      outcome: job.receiptJson,
      completed: job.completed,
    }).toEqual({
      gate: { ok: false, reason: "storage-failed" },
      dispatch: false,
      persisted: false,
      outcome: null,
      completed: false,
    });
  });

  it("a cold database handle sees the durable intent flush", async () => {
    const { dbPath, sessionId, doc, flush } = await bindSession("loaded");
    const job = new SystemToolJob({
      toolCallId: "c1",
      name: "read_file",
      argsJson: "{}",
      orchestrationResult: true,
    });
    doc.root.head = closedTurn(job);
    const gate = await persistJobIntent(flush, job);
    expect(gate.ok).toBe(true);
    const cold = new SqliteKvStore(dbPath);
    try {
      const loaded = await loadSessionNodesFromKv(cold, sessionId);
      expect({
        opened: loaded !== undefined,
        hasJob: loaded?.rows.some((row) => row.uuid === job.uuid) ?? false,
      }).toEqual({ opened: true, hasJob: true });
    } finally {
      await cold.close();
    }
  });
});

describe("job recovery from real on-disk SQLite rows", () => {
  it("recovers an unsettled system tool as unknown-no-replay", async () => {
    const { dbPath, sessionId, doc, flush } = await bindSession("unknown-sys");
    const job = new SystemToolJob({
      toolCallId: "c1",
      name: "read_file",
      argsJson: "{}",
      orchestrationResult: true,
    });
    doc.root.head = closedTurn(job);
    const gate = await persistJobIntent(flush, job);
    expect(gate.ok).toBe(true);

    const recovered = await restore(dbPath, sessionId);
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
  });

  it("does not replay an unsettled file mutate from disk", async () => {
    const { dbPath, sessionId, doc, flush } = await bindSession("unknown-write");
    const job = new FileMutateToolJob({
      toolCallId: "w1",
      name: "write_file",
      argsJson: JSON.stringify({ path: "a.txt", content: "x" }),
      orchestrationResult: true,
    });
    doc.root.head = closedTurn(job);
    const gated = await persistJobIntent(flush, job);
    expect(gated.ok).toBe(true);

    const recovered = await restore(dbPath, sessionId);
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
  });

  it("treats dispatched MCP without a result as unknown", async () => {
    const { dbPath, sessionId, doc, flush } = await bindSession("unknown-mcp");
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
    doc.root.head = closedTurn(job);
    const gated = await persistJobIntent(flush, job);
    expect(gated.ok).toBe(true);

    const recovered = await restore(dbPath, sessionId);
    const row = recovered.find((item) => item.kind === "harness:job:mcp-tool");
    const mcp = row?.job instanceof MCPToolJob ? row.job : undefined;
    expect({
      action: row?.action,
      completed: row?.job.completed,
      expectation: mcp?.expectation.isDone,
    }).toEqual({ action: "unknown", completed: true, expectation: true });
  });

  it("settles cancelRequested on a restored turn", async () => {
    const { dbPath, sessionId, doc, flush } = await bindSession("cancel");
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
    doc.root.head = turn;
    const gated = await persistJobIntent(flush, job);
    expect(gated.ok).toBe(true);

    const recovered = await restore(dbPath, sessionId);
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
  });

  it("resume-queued context-need is not completed as unknown", async () => {
    const { dbPath, sessionId, doc, flush } = await bindSession("need");
    const job = new ContextNeedToolJob({
      triggersReactLoop: false,
      tapeHidden: true,
      toolCallId: "n1",
      name: "context_need",
      argsJson: "{}",
    });
    doc.root.head = closedTurn(job);
    const gated = await persistJobIntent(flush, job);
    expect(gated.ok).toBe(true);
    await flush();

    const recovered = await restore(dbPath, sessionId);
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
  });

  it.each([{ name: "child", CallType: AgentCallJob }])(
    "rejoins an owned $name invocation without adopting bot acceptance",
    async ({ name, CallType }) => {
      const { dbPath, sessionId, doc, flush } = await bindSession(`${name}-rejoin`);
      const call = new CallType({
        name: "agent__ask",
        orchestrationResult: true,
        workerSessionId: "existing-child",
      });
      doc.root.head = closedTurn(call);
      const gate = await persistJobIntent(flush, call);
      expect(gate.ok).toBe(true);
      await flush();

      const recovered = await restore(dbPath, sessionId);
      const row = recovered.find((item) => item.kind === "harness:job:child-agent-call");
      const child = row?.job instanceof AgentCallJob ? row.job : undefined;
      expect({ action: row?.action, worker: child?.workerSessionId, completed: child?.completed }).toEqual({
        action: "resume-inner",
        worker: "existing-child",
        completed: false,
      });
    },
  );

  it("a recovered BotCall resumes; its join waits on the re-run delivery, not on caller fields", async () => {
    const catalog = catalogOf([botCall("offload")]);
    const { dbPath, sessionId, doc, flush } = await bindSession("accept");
    const call = new BotCallJob({
      name: "offload",
      background: true,
      orchestrationResult: true,
      acceptedAt: 1,
      preparedInputJson: JSON.stringify({ prepared: true }),
      workerSessionId: "worker",
    });
    doc.root.head = closedTurn(call);
    const gated = await persistJobIntent(flush, call);
    expect(gated.ok).toBe(true);

    const recovered = await restore(dbPath, sessionId, catalog);
    const row = recovered.find((item) => item.kind === "harness:job:bot-call");
    const resumed = row?.job instanceof BotCallJob ? row.job : undefined;
    expect({
      action: row?.action,
      join: resumed != null && joinReleased(resumed, catalog),
    }).toEqual({ action: "resume-inner", join: false });
  });

  it("cancelRequested without catalog skips call-lifetime Calls", async () => {
    const { dbPath, sessionId, doc, flush } = await bindSession("cancel-work");
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
    doc.root.head = turn;
    await flush();

    const recovered = await restore(dbPath, sessionId);
    const callRow = recovered.find((item) => item.kind === "harness:job:bot-call");
    expect({
      completed: callRow?.job.completed,
      cancelled: callRow?.job.cancelled,
    }).toEqual({ completed: false, cancelled: false });
  });

  it("queued completion without intent is not auto-replayed after owner death once intended", async () => {
    const { dbPath, sessionId, doc, flush } = await bindSession("completion");
    const job = new CompletionJob({
      expectation: new CompletionExpectation({ connectionId: "c" }),
      orchestrationResult: true,
    });
    doc.root.head = closedTurn(job);
    const gated = await persistJobIntent(flush, job);
    expect(gated.ok).toBe(true);

    const recovered = await restore(dbPath, sessionId);
    const row = recovered.find((item) => item.kind === "harness:job:completion");
    const completion = row?.job instanceof CompletionJob ? row.job : undefined;
    expect({
      action: row?.action,
      completed: row?.job.completed,
      expectation: completion?.expectation.isDone,
    }).toEqual({ action: "unknown", completed: true, expectation: true });
  });
});

describe("job recovery on a live replica", () => {
  it("stops repeated interrupted attempts at the recorded foreground limit", () => {
    const doc = SessionDocument.create("recovery-limit");
    onTestFinished(() => doc.destroy());
    const completions = Array.from({ length: 3 }, () => {
      const expectation = new CompletionExpectation({ connectionId: "c" });
      expectation.stampRetryLimits({ maxMs: 0, maxAttempts: 3, backgroundMaxAttempts: 0 });
      return new CompletionJob({ expectation, orchestrationResult: true });
    });
    for (const completion of completions.slice(0, -1)) {
      completion.expectation.fail("crash", "interrupted by restart; execution outcome unknown", "null");
      completion.markComplete();
    }
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      doneWork: completions,
      reducerExited: false,
      orchestrationResult: true,
    });
    doc.root.head = turn;
    recoverSessionJobs(doc.root);
    expect(turn.reducerExited).toBe(true);
    expect(turn.broke).toContain("3 interrupted model attempts");
    expect(turn.queue).toHaveLength(0);
  });
  it("closes a cancelled program and completion a crash left open", () => {
    const doc = SessionDocument.create("cancel-open", "/tmp/cancel-open");
    onTestFinished(() => doc.destroy());
    const program = new ProgrammaticJob({ toolCallId: "p1", orchestrationResult: true, cancelled: true });
    const completion = new CompletionJob({
      expectation: new CompletionExpectation({ connectionId: "c" }),
      orchestrationResult: true,
      cancelled: true,
    });
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], reducerExited: true });
    turn.pushChild(program);
    turn.pushChild(completion);
    doc.root.head = turn;
    const rows = recoverSessionJobs(doc.root);
    expect({
      actions: rows.filter((row) => row.job !== turn).map((row) => row.action),
      program: [program.completed, program.receiptJson != null],
      completion: [completion.completed, completion.expectation.isDone],
    }).toEqual({ actions: ["cancel", "cancel"], program: [true, true], completion: [true, true] });
  });

  it("puts back a round token a crash left behind its claim cells", () => {
    const doc = SessionDocument.create("token", "/tmp/token");
    onTestFinished(() => doc.destroy());
    const token = new TurnPromptChunk();
    const steer = new TurnSteerChunk();
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      doneWork: [token, steer],
      reducerExited: false,
      orchestrationResult: true,
    });
    doc.root.head = turn;
    recoverSessionJobs(doc.root);
    expect({ queue: turn.queue[0] === token, done: [...turn.doneWork], exited: turn.reducerExited }).toEqual({
      queue: true,
      done: [steer],
      exited: false,
    });
  });

  it("closes a turn whose tape owes no round", () => {
    const doc = SessionDocument.create("owed-none", "/tmp/owed-none");
    onTestFinished(() => doc.destroy());
    const program = new ProgrammaticJob({ toolCallId: "p", orchestrationResult: true, completed: true });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      doneWork: [program],
      reducerExited: false,
      orchestrationResult: true,
    });
    doc.root.head = turn;
    recoverSessionJobs(doc.root);
    expect({ exited: turn.reducerExited, completed: turn.completed, open: doc.root.openTurn }).toEqual({
      exited: true,
      completed: true,
      open: false,
    });
  });

  it("leaves a round token whose completion is already queued", () => {
    const doc = SessionDocument.create("token-owed", "/tmp/token-owed");
    onTestFinished(() => doc.destroy());
    const token = new TurnPromptChunk();
    const completion = new CompletionJob({ expectation: new CompletionExpectation({ connectionId: "c" }) });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [completion],
      doneWork: [token],
      reducerExited: false,
      orchestrationResult: true,
    });
    doc.root.head = turn;
    recoverSessionJobs(doc.root);
    expect({ queue: [...turn.queue], done: [...turn.doneWork], exited: turn.reducerExited }).toEqual({
      queue: [completion],
      done: [token],
      exited: false,
    });
  });
});
