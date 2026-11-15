import type { ShapeDeltaFrame } from "@inhuman.tools/harness-contract/schema";
import { MemoryKvStore, type ElectricShapeMessage } from "@inhuman.tools/scope-plane";
import { describe, expect, it } from "vitest";

import { compileElectricLaneQuery, ElectricShapeSource } from "../index.js";

describe("ElectricShapeSource", () => {
  it("compiles all canonical lane predicates for Electric /v1/shape", () => {
    const scope = compileElectricLaneQuery(
      {
        kind: "shape/subscribe",
        subscriptionId: "s1",
        lane: "scope_nodes",
        params: { kernelId: "t1", scopeId: "kernel" },
      },
      { schema: "harness" },
    );
    expect(scope).toEqual({
      table: "scope_nodes",
      where: "kernel_id = $1 AND scope_id = $2",
      params: ["t1", "kernel"],
      schema: "harness",
    });

    const recent = compileElectricLaneQuery({
      kind: "shape/subscribe",
      subscriptionId: "s2",
      lane: "recent_sessions",
      params: { kernelId: "t1", projectId: "p1", limit: 20, beforeMs: 9999 },
    });
    expect(recent).toEqual({
      table: "sessions",
      where: "kernel_id = $1 AND archived_at_ms IS NULL AND project_id = $2 AND last_active_at_ms < $3",
      params: ["t1", "p1", "9999"],
      schema: undefined,
    });
  });

  it("buffers initial snapshot until up-to-date, normalizes snake_case rows, handles incremental deltas and must-refetch", () => {
    let pushMessages: ((msgs: readonly ElectricShapeMessage<Record<string, unknown>>[]) => void) | null = null;
    let aborted = false;

    const source = new ElectricShapeSource({
      shapeUrl: "http://electric.local:3000",
      schema: "harness",
      streamFactory: ({ signal }) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          subscribe(cb) {
            pushMessages = cb;
            return () => {
              pushMessages = null;
            };
          },
        };
      },
    });

    const frames: ShapeDeltaFrame[] = [];
    const unsub = source.subscribe(
      {
        kind: "shape/subscribe",
        subscriptionId: "sub-sessions",
        lane: "recent_sessions",
        params: { kernelId: "t1", limit: 10 },
      },
      (frame) => frames.push(frame),
      "client-1",
    );

    expect(pushMessages).not.toBeNull();

    // Buffered before initial up-to-date control message.
    pushMessages!([
      {
        key: '"harness"."sessions"/"sess-1"',
        headers: { operation: "insert" },
        value: {
          session_id: "sess-1",
          kernel_id: "t1",
          project_id: "proj-1",
          title: "First chat",
          workspace_path: "",
          mode: "assistant",
          permission_mode: "manual",
          running: true,
          head_turn_id: null,
          parent_session_id: null,
          parent_call_id: null,
          depth: 0,
          revision: 1,
          created_at_ms: "1700000000000",
          last_active_at_ms: "1700000000500",
          archived_at_ms: null,
        },
      },
    ]);
    expect(frames).toHaveLength(0);

    pushMessages!([{ headers: { control: "up-to-date" } }]);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.reset).toBe(true);
    expect(frames[0]?.upserts).toEqual([
      expect.objectContaining({
        sessionId: "sess-1",
        kernelId: "t1",
        projectId: "proj-1",
        running: true,
        createdAtMs: 1_700_000_000_000,
        lastActiveAtMs: 1_700_000_000_500,
        archivedAtMs: null,
      }),
    ]);

    // Incremental update + delete after catch-up emit immediately.
    pushMessages!([
      {
        key: '"harness"."sessions"/"sess-2"',
        headers: { operation: "update" },
        value: {
          session_id: "sess-2",
          kernel_id: "t1",
          project_id: "proj-1",
          title: "Second",
          workspace_path: "",
          mode: "agentic",
          permission_mode: "manual",
          running: false,
          head_turn_id: null,
          parent_session_id: null,
          parent_call_id: null,
          depth: 0,
          revision: 2,
          created_at_ms: 100,
          last_active_at_ms: 200,
          archived_at_ms: null,
        },
      },
      {
        key: '"harness"."sessions"/"sess-1"',
        headers: { operation: "delete" },
        value: { session_id: "sess-1" },
      },
    ]);

    expect(frames).toHaveLength(2);
    expect(frames[1]?.reset).toBeUndefined();
    expect(frames[1]?.deletes).toEqual(["sess-1"]);
    expect(frames[1]?.upserts).toHaveLength(1);

    // must-refetch resets and buffers until next up-to-date.
    pushMessages!([
      { headers: { control: "must-refetch" } },
      {
        key: '"harness"."sessions"/"sess-3"',
        headers: { operation: "insert" },
        value: {
          session_id: "sess-3",
          kernel_id: "t1",
          project_id: "proj-1",
          title: "Refetched",
          workspace_path: "",
          mode: "assistant",
          permission_mode: "manual",
          running: false,
          depth: 0,
          revision: 1,
          created_at_ms: 300,
          last_active_at_ms: 300,
        },
      },
    ]);
    expect(frames).toHaveLength(2);

    pushMessages!([{ headers: { control: "up-to-date" } }]);
    expect(frames).toHaveLength(3);
    expect(frames[2]?.reset).toBe(true);
    expect(frames[2]?.upserts.map((u) => u.sessionId)).toEqual(["sess-3"]);

    unsub();
    expect(aborted).toBe(true);
    source.dispose();
  });

  it("supports evaluateLane when a backing HarnessKvStore is provided", async () => {
    const store = new MemoryKvStore();
    await store.set("session_nodes", {
      id: "s1:n1",
      kernelId: "t1",
      sessionId: "s1",
      nodeId: "n1",
      tag: "Root",
      isRoot: true,
      revision: 1,
      rowJson: "{}",
    });

    const source = new ElectricShapeSource({
      shapeUrl: "http://electric.local:3000",
      store,
    });
    const rows = await source.evaluateLane({
      kind: "shape/subscribe",
      subscriptionId: "eval-1",
      lane: "session_nodes",
      params: { kernelId: "t1", sessionId: "s1" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nodeId).toBe("n1");
    await store.close();
  });
});
