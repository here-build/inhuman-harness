import type { SessionRowInsert } from "@inhuman.tools/harness-contract/schema";
import { CommitDiffShapeSource, createLocalShapeTransport, LiveShape } from "@inhuman.tools/scope-plane";
import { autorun, makeAutoObservable } from "mobx";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteKvStore } from "../sqlite-kv-store.js";

class SessionModel {
  sessionId = "";
  title = "";
  running = false;
  lastActiveAtMs = 0;

  constructor(row?: Record<string, unknown>) {
    makeAutoObservable(this);
    if (row) this.applyRow(row);
  }

  applyRow(row: Record<string, unknown>): void {
    this.sessionId = String(row["sessionId"] ?? "");
    this.title = String(row["title"] ?? "");
    this.running = row["running"] === true;
    this.lastActiveAtMs = Number(row["lastActiveAtMs"] ?? 0);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for LiveShape update");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function makeSessionRow(sessionId: string, overrides: Partial<SessionRowInsert> = {}): SessionRowInsert {
  return {
    sessionId,
    title: `Title ${sessionId}`,
    workspacePath: "/tmp/ws",
    mode: "assistant",
    permissionMode: "manual",
    running: false,
    depth: 0,
    revision: 1,
    createdAtMs: 1000,
    lastActiveAtMs: 1000,
    ...overrides,
  };
}

describe("SqliteKvStore + CommitDiffShapeSource + LiveShape", () => {
  let store: SqliteKvStore;
  let hub: CommitDiffShapeSource;

  beforeEach(() => {
    store = new SqliteKvStore(":memory:");
    hub = new CommitDiffShapeSource(store);
  });

  afterEach(async () => {
    hub.dispose();
    await store.close();
  });

  it("handles 1,000 sessions with bounded window sliding and graceMs lifecycle", async () => {
    const transport = createLocalShapeTransport(hub);
    const batch: SessionRowInsert[] = [];
    for (let i = 1; i <= 1000; i++) {
      const id = `sess-k-${String(i).padStart(4, "0")}`;
      batch.push(makeSessionRow(id, { lastActiveAtMs: i * 100 }));
    }
    await store.setMany("sessions", batch);

    const shape = new LiveShape("recent_sessions", { limit: 50 }, "sessionId", SessionModel, transport, {
      graceMs: 30,
    });
    const stop = autorun(() => {
      void shape.list;
    });
    await shape.ready();

    expect(shape.list).toHaveLength(50);
    expect(shape.rows.has("sess-k-1000")).toBe(true);
    expect(shape.rows.has("sess-k-0951")).toBe(true);
    expect(shape.rows.has("sess-k-0950")).toBe(false);

    await store.set("sessions", makeSessionRow("sess-k-1001", { lastActiveAtMs: 200_000 }));
    await waitFor(() => shape.rows.has("sess-k-1001"));
    expect(shape.rows.size).toBe(50);
    expect(shape.rows.has("sess-k-0951")).toBe(false);

    stop();
    await waitFor(() => !shape.isSubscribed && hub.subscriptionCount === 0);

    const stop2 = autorun(() => {
      void shape.list;
    });
    await shape.ready();
    expect(shape.list).toHaveLength(50);
    stop2();
    shape.dispose();
  });

  it("supports child_sessions and active_sessions combined with pending_asks", async () => {
    const transport = createLocalShapeTransport(hub);
    await store.setMany("sessions", [
      makeSessionRow("parent-1"),
      makeSessionRow("child-1", { parentSessionId: "parent-1", createdAtMs: 100 }),
      makeSessionRow("child-2", { parentSessionId: "parent-1", createdAtMs: 200 }),
    ]);

    const childShape = new LiveShape(
      "child_sessions",
      { parentSessionId: "parent-1" },
      "sessionId",
      SessionModel,
      transport,
    );
    const activeShape = new LiveShape("active_sessions", {}, "sessionId", SessionModel, transport);
    const s1 = autorun(() => {
      void childShape.list;
      void activeShape.list;
    });
    await Promise.all([childShape.ready(), activeShape.ready()]);

    expect(childShape.list.map((r) => r.sessionId)).toEqual(["child-1", "child-2"]);
    expect(activeShape.list).toHaveLength(0);

    await store.set("pending_asks", {
      jobId: "ask-1",
      sessionId: "child-1",
      turnId: "t1",
      kind: "ask",
      object: "bash",
      summary: "approve",
      createdAtMs: 500,
    });
    await waitFor(() => activeShape.rows.has("child-1"));

    await store.delete("pending_asks", "ask-1");
    await waitFor(() => !activeShape.rows.has("child-1"));

    s1();
    childShape.dispose();
    activeShape.dispose();
  });
});
