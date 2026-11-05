import {
  pendingAsksTable,
  sessionsTable,
  type PendingAskRow,
  type SessionRow,
} from "@inhuman.tools/harness-contract/schema";
import { column, Model, model, resetModelRegistry } from "@inhuman.tools/model";
import { autorun, reaction } from "mobx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UpdateLaneHub } from "../lane-server.js";
import { createLocalShapeTransport, LiveShape } from "../live-shape.js";
import { HarnessDatabase } from "../sqlite-database.js";

@model("test:live-shape:session", sessionsTable)
class SessionModel extends Model<SessionRow> {
  @column(sessionsTable.sessionId) accessor sessionId!: string;
  @column(sessionsTable.title) accessor title!: string;
  @column(sessionsTable.workspacePath) accessor workspacePath!: string;
  @column(sessionsTable.mode) accessor mode!: "assistant" | "agentic";
  @column(sessionsTable.permissionMode) accessor permissionMode!: string;
  @column(sessionsTable.running) accessor running!: boolean;
  @column(sessionsTable.headTurnId) accessor headTurnId!: string | null;
  @column(sessionsTable.parentSessionId) accessor parentSessionId!: string | null;
  @column(sessionsTable.parentCallId) accessor parentCallId!: string | null;
  @column(sessionsTable.depth) accessor depth!: number;
  @column(sessionsTable.revision) accessor revision!: number;
  @column(sessionsTable.createdAtMs) accessor createdAtMs!: number;
  @column(sessionsTable.lastActiveAtMs) accessor lastActiveAtMs!: number;
  @column(sessionsTable.archivedAtMs) accessor archivedAtMs!: number | null;
}

@model("test:live-shape:pending_ask", pendingAsksTable)
class PendingAskModel extends Model<PendingAskRow> {
  @column(pendingAsksTable.jobId) accessor jobId!: string;
  @column(pendingAsksTable.sessionId) accessor sessionId!: string;
  @column(pendingAsksTable.turnId) accessor turnId!: string;
  @column(pendingAsksTable.kind) accessor kind!: "ask" | "ack";
  @column(pendingAsksTable.object) accessor object!: string;
  @column(pendingAsksTable.summary) accessor summary!: string;
  @column(pendingAsksTable.createdAtMs) accessor createdAtMs!: number;
}

function makeSessionRow(id: string, overrides: Partial<SessionRow> = {}): SessionRow {
  const index = Number(id.replaceAll(/\D/g, "")) || 1;
  return {
    sessionId: id,
    title: `Session ${id}`,
    workspacePath: "/test/workspace",
    mode: "assistant",
    permissionMode: "ask",
    running: false,
    headTurnId: null,
    parentSessionId: null,
    parentCallId: null,
    depth: 0,
    revision: 0,
    createdAtMs: 1_000_000 + index * 10,
    lastActiveAtMs: 1_000_000 + index * 10,
    archivedAtMs: null,
    ...overrides,
  };
}

describe("SQLite Storage Engine & LiveShape Reactive Lanes", () => {
  let db: HarnessDatabase;
  let hub: UpdateLaneHub;

  beforeEach(() => {
    resetModelRegistry();
    db = new HarnessDatabase(":memory:");
    hub = new UpdateLaneHub(db);
  });

  afterEach(() => {
    hub.dispose();
    db.close();
  });

  it("subscribing to recent_sessions (limit: 25) after inserting 200 sessions loads exactly 25 instances", () => {
    const transport = createLocalShapeTransport(hub);

    // Insert 200 sessions in a single write transaction
    db.writeTransaction(["sessions"], (tx) => {
      for (let i = 1; i <= 200; i++) {
        const id = `sess-${String(i).padStart(3, "0")}`;
        tx.insert(sessionsTable)
          .values(makeSessionRow(id, { lastActiveAtMs: i * 1000 }))
          .run();
      }
    });

    const recentShape = new LiveShape("recent_sessions", { limit: 25 }, "sessionId", SessionModel, transport);

    let observedCount = -1;
    const stopObserving = autorun(() => {
      if (recentShape.synced) {
        observedCount = recentShape.list.length;
      }
    });

    expect(recentShape.synced).toBe(true);
    expect(observedCount).toBe(25);
    expect(recentShape.list).toHaveLength(25);

    // The top 25 should be sess-200 down to sess-176 (descending lastActiveAtMs)
    expect(recentShape.list[0]?.sessionId).toBe("sess-200");
    expect(recentShape.list[24]?.sessionId).toBe("sess-176");
    expect(recentShape.list[0]).toBeInstanceOf(SessionModel);

    stopObserving();
    recentShape.dispose();
  });

  it("updating a session (running: false -> true) updates @column in-place across active and recent lanes", () => {
    const transport = createLocalShapeTransport(hub);

    // Insert 10 sessions
    db.writeTransaction(["sessions"], (tx) => {
      for (let i = 1; i <= 10; i++) {
        const id = `sess-${String(i).padStart(2, "0")}`;
        tx.insert(sessionsTable)
          .values(makeSessionRow(id, { running: false, lastActiveAtMs: i * 1000 }))
          .run();
      }
    });

    const recentShape = new LiveShape("recent_sessions", { limit: 10 }, "sessionId", SessionModel, transport);
    const activeShape = new LiveShape("active_sessions", {}, "sessionId", SessionModel, transport);

    const stopRecent = autorun(() => {
      void recentShape.list;
    });
    const stopActive = autorun(() => {
      void activeShape.list;
    });

    expect(recentShape.list).toHaveLength(10);
    expect(activeShape.list).toHaveLength(0);

    const session10 = recentShape.rows.get("sess-10");
    expect(session10).toBeDefined();
    expect(session10!.running).toBe(false);

    let columnReactionFired = 0;
    const stopReaction = reaction(
      () => session10!.running,
      (isRunning) => {
        if (isRunning) columnReactionFired += 1;
      },
    );

    // Update sess-10 to running = true
    db.updateSession("sess-10", { running: true });

    // Active sessions should now include sess-10 immediately
    expect(activeShape.list).toHaveLength(1);
    expect(activeShape.rows.has("sess-10")).toBe(true);

    // The recent_sessions shape must preserve the exact same SessionModel reference
    const session10After = recentShape.rows.get("sess-10");
    expect(session10After).toBe(session10);
    expect(session10After!.running).toBe(true);
    expect(columnReactionFired).toBe(1);

    // Unmutated session objects must retain their references
    const session9 = recentShape.rows.get("sess-09");
    expect(recentShape.rows.get("sess-09")).toBe(session9);

    stopReaction();
    stopRecent();
    stopActive();
    recentShape.dispose();
    activeShape.dispose();
  });

  it("inserting and deleting in pending_asks dynamically adds and removes parent session from active_sessions", () => {
    const transport = createLocalShapeTransport(hub);

    // Insert 5 idle sessions (running = false)
    db.writeTransaction(["sessions"], (tx) => {
      for (let i = 1; i <= 5; i++) {
        const id = `sess-idle-${i}`;
        tx.insert(sessionsTable)
          .values(makeSessionRow(id, { running: false }))
          .run();
      }
    });

    const activeShape = new LiveShape("active_sessions", {}, "sessionId", SessionModel, transport);
    const asksShape = new LiveShape("pending_asks", {}, "jobId", PendingAskModel, transport);

    const stopActive = autorun(() => {
      void activeShape.list;
    });
    const stopAsks = autorun(() => {
      void asksShape.list;
    });

    expect(activeShape.list).toHaveLength(0);
    expect(asksShape.list).toHaveLength(0);

    // Insert pending ask for sess-idle-3
    db.insertPendingAsk({
      jobId: "ask-101",
      sessionId: "sess-idle-3",
      turnId: "turn-1",
      kind: "ask",
      object: "terminal",
      summary: "Run terminal command",
      createdAtMs: Date.now(),
    });

    expect(asksShape.list).toHaveLength(1);
    expect(asksShape.rows.has("ask-101")).toBe(true);
    expect(activeShape.list).toHaveLength(1);
    expect(activeShape.rows.has("sess-idle-3")).toBe(true);

    // Delete pending ask
    db.deletePendingAsk("ask-101");

    expect(asksShape.list).toHaveLength(0);
    expect(asksShape.rows.has("ask-101")).toBe(false);
    expect(activeShape.list).toHaveLength(0);
    expect(activeShape.rows.has("sess-idle-3")).toBe(false);

    stopActive();
    stopAsks();
    activeShape.dispose();
    asksShape.dispose();
  });

  it("unobserving LiveShape disposes subscription after graceMs and re-observing resumes cleanly from offset", async () => {
    const transport = createLocalShapeTransport(hub);

    // Insert 10 sessions
    db.writeTransaction(["sessions"], (tx) => {
      for (let i = 1; i <= 10; i++) {
        const id = `sess-grace-${i}`;
        tx.insert(sessionsTable)
          .values(makeSessionRow(id, { lastActiveAtMs: i * 1000 }))
          .run();
      }
    });

    const shape = new LiveShape("recent_sessions", { limit: 5 }, "sessionId", SessionModel, transport, { graceMs: 50 });

    let stopObservation = autorun(() => {
      void shape.list;
    });

    expect(shape.isSubscribed).toBe(true);
    expect(shape.list).toHaveLength(5);
    const initialOffset = shape.offset;
    expect(initialOffset).toBeGreaterThan(0);

    // Stop observation to trigger grace period
    stopObservation();

    // Still connected immediately (grace period active)
    expect(shape.isSubscribed).toBe(true);

    // Wait past graceMs (50ms + margin)
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Subscription should now be disposed
    expect(shape.isSubscribed).toBe(false);
    expect(hub.subscriptionCount).toBe(0);

    // Re-observe: should resume cleanly
    stopObservation = autorun(() => {
      void shape.list;
    });

    expect(shape.isSubscribed).toBe(true);
    expect(shape.offset).toBe(initialOffset);
    expect(shape.list).toHaveLength(5);

    stopObservation();
    shape.dispose();
  });

  it("bounds memory by loading only 50 models when 1,000 sessions exist and evicting on window slide", () => {
    const transport = createLocalShapeTransport(hub);

    // Insert 1,000 sessions in one transaction
    db.writeTransaction(["sessions"], (tx) => {
      for (let i = 1; i <= 1000; i++) {
        const id = `sess-k-${String(i).padStart(4, "0")}`;
        tx.insert(sessionsTable)
          .values(makeSessionRow(id, { lastActiveAtMs: i * 100 }))
          .run();
      }
    });

    const shape = new LiveShape("recent_sessions", { limit: 50 }, "sessionId", SessionModel, transport);

    const stop = autorun(() => {
      void shape.list;
    });

    expect(shape.list).toHaveLength(50);
    expect(shape.rows.size).toBe(50);
    // Highest lastActiveAtMs is sess-k-1000 down to sess-k-0951
    expect(shape.rows.has("sess-k-1000")).toBe(true);
    expect(shape.rows.has("sess-k-0951")).toBe(true);
    expect(shape.rows.has("sess-k-0950")).toBe(false);

    // Insert a new session with an even higher lastActiveAtMs
    db.insertSession(makeSessionRow("sess-k-1001", { lastActiveAtMs: 200_000 }));

    // Window must shift: sess-k-1001 added, sess-k-0951 evicted, size remains 50!
    expect(shape.list).toHaveLength(50);
    expect(shape.rows.size).toBe(50);
    expect(shape.rows.has("sess-k-1001")).toBe(true);
    expect(shape.rows.has("sess-k-0951")).toBe(false);

    stop();
    shape.dispose();
  });

  it("child_sessions and kernel_meta lanes evaluate and reflect mutations correctly", () => {
    const transport = createLocalShapeTransport(hub);

    // Insert parent and child sessions
    db.writeTransaction(["sessions"], (tx) => {
      tx.insert(sessionsTable).values(makeSessionRow("parent-1")).run();
      tx.insert(sessionsTable)
        .values(makeSessionRow("child-1", { parentSessionId: "parent-1", createdAtMs: 100 }))
        .run();
      tx.insert(sessionsTable)
        .values(makeSessionRow("child-2", { parentSessionId: "parent-1", createdAtMs: 200 }))
        .run();
      tx.insert(sessionsTable)
        .values(makeSessionRow("child-other", { parentSessionId: "parent-2", createdAtMs: 150 }))
        .run();
    });

    const childShape = new LiveShape(
      "child_sessions",
      { parentSessionId: "parent-1" },
      "sessionId",
      SessionModel,
      transport,
    );

    const stopChild = autorun(() => {
      void childShape.list;
    });

    expect(childShape.list).toHaveLength(2);
    expect(childShape.list[0]?.sessionId).toBe("child-1");
    expect(childShape.list[1]?.sessionId).toBe("child-2");

    // Add child-3 to parent-1
    db.insertSession(makeSessionRow("child-3", { parentSessionId: "parent-1", createdAtMs: 300 }));
    expect(childShape.list).toHaveLength(3);
    expect(childShape.list[2]?.sessionId).toBe("child-3");

    // Kernel state upsert
    const kernelRow = db.upsertKernelState({
      defaultModel: "claude-3-7-sonnet",
      permissionMode: "auto",
      updatedAtMs: 12345,
    });
    expect(kernelRow.defaultModel).toBe("claude-3-7-sonnet");
    expect(kernelRow.permissionMode).toBe("auto");

    stopChild();
    childShape.dispose();
  });
});
