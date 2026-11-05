import { prompt } from "@inhuman.tools/harness-commons";
import {
  type KernelStateRow,
  type PendingAskRow,
  type SessionRow,
  type SessionTurnRow,
} from "@inhuman.tools/harness-contract/schema";
import { type ModelPatchBatch } from "@inhuman.tools/model";
import { describe, expect, it } from "vitest";

import {
  AgentCallJob,
  AgentCallNotification,
  KernelRecord,
  PendingAskRecord,
  SessionDocument,
  SessionSummaryRecord,
  SessionSystemPrompt,
  SessionTurn,
  SessionTurnRecord,
  SuccessfulOutcome,
} from "../index.js";

describe("Drizzle row models & live DocumentContainer synchronization", () => {
  describe("Node 1 Drizzle Schema Audit & Row Round-trip", () => {
    it("KernelRecord passes Drizzle schema audit and round-trips toRow / applyRow", () => {
      const initialKernel: KernelStateRow = {
        id: "singleton",
        defaultModel: "anthropic/claude-3-7-sonnet",
        permissionMode: "auto",
        kvsJson: JSON.stringify({ theme: "dark" }),
        updatedAtMs: 1700000000000,
      };

      const kernelRec = new KernelRecord(initialKernel);
      expect(kernelRec.id).toBe("singleton");
      expect(kernelRec.defaultModel).toBe("anthropic/claude-3-7-sonnet");
      expect(kernelRec.toRow()).toEqual(initialKernel);

      kernelRec.applyRow({ permissionMode: "yolo", updatedAtMs: 1700000001000 });
      expect(kernelRec.permissionMode).toBe("yolo");
      expect(kernelRec.toRow()).toEqual({
        ...initialKernel,
        permissionMode: "yolo",
        updatedAtMs: 1700000001000,
      });
    });

    it("SessionSummaryRecord passes Drizzle schema audit and round-trips toRow / applyRow", () => {
      const initialSession: SessionRow = {
        sessionId: "s-123",
        title: "Rebuild Session",
        workspacePath: "/repo/workspace",
        mode: "agentic",
        permissionMode: "auto",
        running: true,
        headTurnId: "turn-1",
        parentSessionId: null,
        parentCallId: null,
        depth: 0,
        revision: 1,
        createdAtMs: 1700000000000,
        lastActiveAtMs: 1700000002000,
        archivedAtMs: null,
      };

      const sessionRec = new SessionSummaryRecord(initialSession);
      expect(sessionRec.sessionId).toBe("s-123");
      expect(sessionRec.title).toBe("Rebuild Session");
      expect(sessionRec.toRow()).toEqual(initialSession);

      sessionRec.applyRow({ running: false, archivedAtMs: 1700000005000 });
      expect(sessionRec.running).toBe(false);
      expect(sessionRec.archivedAtMs).toBe(1700000005000);
      expect(sessionRec.toRow()).toEqual({
        ...initialSession,
        running: false,
        archivedAtMs: 1700000005000,
      });
    });

    it("PendingAskRecord passes Drizzle schema audit and round-trips toRow / applyRow", () => {
      const initialAsk: PendingAskRow = {
        jobId: "job-ask-1",
        sessionId: "s-123",
        turnId: "turn-1",
        kind: "ask",
        object: JSON.stringify({ tool: "shell", command: "rm -rf /tmp/test" }),
        summary: "Run destructive shell command",
        createdAtMs: 1700000003000,
      };

      const askRec = new PendingAskRecord(initialAsk);
      expect(askRec.jobId).toBe("job-ask-1");
      expect(askRec.toRow()).toEqual(initialAsk);

      askRec.applyRow({ summary: "Updated summary" });
      expect(askRec.summary).toBe("Updated summary");
      expect(askRec.toRow()).toEqual({ ...initialAsk, summary: "Updated summary" });
    });

    it("SessionTurnRecord passes Drizzle schema audit and round-trips toRow / applyRow", () => {
      const initialTurn: SessionTurnRow = {
        turnId: "turn-1",
        sessionId: "s-123",
        ordinal: 0,
        prompt: "Refactor database models",
        status: "running",
        cancelRequested: false,
        reducerExited: false,
        snapshotJson: JSON.stringify({ state: "in-progress" }),
        startedAtMs: 1700000000000,
        endedAtMs: null,
      };

      const turnRec = new SessionTurnRecord(initialTurn);
      expect(turnRec.turnId).toBe("turn-1");
      expect(turnRec.toRow()).toEqual(initialTurn);

      turnRec.applyRow({ status: "completed", reducerExited: true, endedAtMs: 1700000010000 });
      expect(turnRec.status).toBe("completed");
      expect(turnRec.reducerExited).toBe(true);
      expect(turnRec.endedAtMs).toBe(1700000010000);
      expect(turnRec.toRow()).toEqual({
        ...initialTurn,
        status: "completed",
        reducerExited: true,
        endedAtMs: 1700000010000,
      });
    });
  });

  describe("SessionDocument Mutation, Patch Emission & Replica Convergence", () => {
    it("mutating SessionRoot, SessionTurn, and AgentCallJob inside an action emits patch batches that converge a replica", () => {
      const server = SessionDocument.create("session-sync-test", "/tmp/sync-test");
      const replica = SessionDocument.connect(server);

      expect(replica.root.sessionId).toBe(server.root.sessionId);
      expect(replica.root.path).toBe(server.root.path);

      const batches: ModelPatchBatch[] = [];
      server.onPatch((batch) => batches.push(batch));

      server.transact(() => {
        server.root.permissionMode = "yolo";
        server.root.manualTitle = "Synchronized Session";

        const turn = new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          prompt: prompt.user`Run migration and sync`,
          queue: [],
        });

        const callJob = new AgentCallJob({
          toolCallId: "call-1",
          name: "agent__send",
          argsJson: JSON.stringify({ target: "worker-1", message: "execute" }),
          background: true,
        });

        turn.pushChild(callJob);
        turn.doneWork.push(callJob);
        server.root.head = turn;
      });

      expect(batches.length).toBeGreaterThan(0);

      expect(replica.root.sessionId).toBe(server.root.sessionId);
      expect(replica.root.manualTitle).toBe(server.root.manualTitle);
      expect(replica.root.permissionMode).toBe(server.root.permissionMode);
      expect(replica.root.head?.uuid).toBe(server.root.head?.uuid);
      expect(replica.root.head?.prompt).toBe(server.root.head?.prompt);

      const serverCall = server.root.head?.doneWork[0] as AgentCallJob;
      const replicaCall = replica.root.head?.doneWork[0] as AgentCallJob;
      expect(replicaCall.uuid).toBe(serverCall.uuid);
      expect(replicaCall.name).toBe(serverCall.name);
      expect(replicaCall.toolCallId).toBe(serverCall.toolCallId);
      expect(replicaCall.background).toBe(serverCall.background);

      expect(replica.root.title).toBe(server.root.title);
      expect(replica.root.openTurn).toBe(server.root.openTurn);
      expect(replica.root.midMotion).toBe(server.root.midMotion);
      expect(replica.root.unfinished).toBe(server.root.unfinished);

      server.transact(() => {
        serverCall.notifications.push(new AgentCallNotification({ message: "Task 50% done" }));
        serverCall.settleResult(new SuccessfulOutcome({ valueJson: JSON.stringify({ ok: true }) }));
        server.root.head!.reducerExited = true;
      });

      expect(replicaCall.completed).toBe(true);
      expect(replicaCall.outcome instanceof SuccessfulOutcome).toBe(true);
      expect((replicaCall.outcome as SuccessfulOutcome).value).toEqual({ ok: true });
      expect(replicaCall.notifications).toHaveLength(2);
      expect(replicaCall.notifications[0].message).toBe("Task 50% done");
      expect(replicaCall.notifications[1].result).toBe(true);
      expect(replicaCall.notifications.map((n) => n.message)).toEqual(serverCall.notifications.map((n) => n.message));
      expect(replica.root.head?.reducerExited).toBe(true);

      expect(replica.root.openTurn).toBe(server.root.openTurn);
      expect(replica.root.midMotion).toBe(server.root.midMotion);
      expect(replica.root.unfinished).toBe(server.root.unfinished);

      server.destroy();
      replica.destroy();
    });
  });
});
