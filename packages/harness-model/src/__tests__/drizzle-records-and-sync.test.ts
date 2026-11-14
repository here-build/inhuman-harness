import { prompt } from "@inhuman.tools/harness-commons";
import {
  type KernelStateRow,
  type PendingAskRow,
  type PluginStateLogRow,
  type ProjectRow,
  type ScmResourceRow,
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
  PluginStateLogRecord,
  ProjectRecord,
  ScmResourceRecord,
  SessionDocument,
  SessionSummaryRecord,
  SessionSystemPrompt,
  SessionTurn,
  SessionTurnRecord,
  SuccessfulOutcome,
} from "../index.js";

describe("Drizzle row models & live DocumentContainer synchronization", () => {
  describe("Node 1 Drizzle Schema Audit & Row Round-trip", () => {
    it("KernelRecord, ProjectRecord, SessionSummaryRecord, PendingAskRecord, SessionTurnRecord, ScmResourceRecord, and PluginStateLogRecord pass Drizzle schema audit and round-trip toRow / applyRow", () => {
      const initialKernel: KernelStateRow = {
        id: "local",
        kernelId: "local",
        defaultModel: "anthropic/claude-3-7-sonnet",
        permissionMode: "auto",
        enabledPluginsJson: JSON.stringify(["todos"]),
        kvsJson: JSON.stringify({ theme: "dark" }),
        updatedAtMs: 1700000000000,
      };
      const kernelRec = new KernelRecord(initialKernel);
      expect(kernelRec.id).toBe("local");
      expect(kernelRec.kernelId).toBe("local");
      expect(kernelRec.defaultModel).toBe("anthropic/claude-3-7-sonnet");
      expect(kernelRec.toRow()).toEqual(initialKernel);
      kernelRec.applyRow({ permissionMode: "yolo", updatedAtMs: 1700000001000 });
      expect(kernelRec.permissionMode).toBe("yolo");
      expect(kernelRec.toRow()).toEqual({
        ...initialKernel,
        permissionMode: "yolo",
        updatedAtMs: 1700000001000,
      });

      const initialProject: ProjectRow = {
        projectId: "proj-1",
        kernelId: "local",
        title: "Demo Workspace",
        kind: "local",
        workspacePath: "/repo/workspace",
        defaultPermissionMode: "manual",
        authorizationJson: JSON.stringify({ allow: ["read"] }),
        kvsJson: JSON.stringify({}),
        lastUsedModelJson: JSON.stringify({ provider: "anthropic" }),
        enabledPluginsJson: JSON.stringify(["fs-shell"]),
        pluginConfigsJson: JSON.stringify({ "fs-shell": { root: "/repo/workspace" } }),
        botsRosterJson: JSON.stringify({}),
        trusted: true,
        contentHash: "sha256-abc",
        revision: 1,
        updatedAtMs: 1700000000000,
      };
      const projectRec = new ProjectRecord(initialProject);
      expect(projectRec.projectId).toBe("proj-1");
      expect(projectRec.kind).toBe("local");
      expect(projectRec.toRow()).toEqual(initialProject);
      projectRec.applyRow({ trusted: false, revision: 2 });
      expect(projectRec.toRow()).toEqual({
        ...initialProject,
        trusted: false,
        revision: 2,
      });

      const initialSession: SessionRow = {
        sessionId: "s-123",
        kernelId: "local",
        projectId: "proj-1",
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

      const initialAsk: PendingAskRow = {
        jobId: "job-ask-1",
        kernelId: "local",
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

      const initialTurn: SessionTurnRow = {
        turnId: "turn-1",
        kernelId: "local",
        sessionId: "s-123",
        ordinal: 0,
        prompt: "Refactor database models",
        status: "running",
        cancelRequested: false,
        reducerExited: false,
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

      const initialScm: ScmResourceRow = {
        id: "kernel:local:policy:default",
        kernelId: "local",
        scope: "kernel",
        scopeId: "local",
        kind: "policy",
        name: "default",
        source: "(policy (allow read))",
        sha256: "deadbeef",
        updatedAtMs: 1700000000000,
      };
      const scmRec = new ScmResourceRecord(initialScm);
      expect(scmRec.toRow()).toEqual(initialScm);
      scmRec.applyRow({ sha256: "cafebabe" });
      expect(scmRec.toRow()).toEqual({ ...initialScm, sha256: "cafebabe" });

      const initialPluginLog: PluginStateLogRow = {
        id: "local:todos:global:local:default",
        kernelId: "local",
        plugin: "todos",
        scope: "global",
        scopeId: "local",
        namespace: "default",
        logJson: JSON.stringify([{ op: "add", text: "verify wave 1" }]),
        updatedAtMs: 1700000000000,
      };
      const pluginLogRec = new PluginStateLogRecord(initialPluginLog);
      expect(pluginLogRec.toRow()).toEqual(initialPluginLog);
      pluginLogRec.applyRow({ namespace: "notes" });
      expect(pluginLogRec.toRow()).toEqual({ ...initialPluginLog, namespace: "notes" });
    });
  });

  describe("SessionDocument Mutation, Patch Emission & Replica Convergence", () => {
    it("mutating SessionRoot, SessionTurn, and AgentCallJob inside an action emits node deltas that converge an independent replica", () => {
      const server = SessionDocument.create("session-sync-test", "/tmp/sync-test");
      const initialDelta = server.takeNodeDelta();
      const replica = SessionDocument.fromNodeRows(initialDelta.upserts, {
        rootId: initialDelta.rootId,
        sessionId: server.root.sessionId,
        revision: initialDelta.revision,
      });

      expect(replica).not.toBe(server);
      expect(replica.root).not.toBe(server.root);
      expect(replica.root.sessionId).toBe(server.root.sessionId);
      expect(replica.root.path).toBe(server.root.path);

      const batches: ModelPatchBatch[] = [];
      server.onPatch((batch) => {
        batches.push(batch);
        const delta = server.takeNodeDelta();
        replica.applyNodeRows(delta);
      });

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
