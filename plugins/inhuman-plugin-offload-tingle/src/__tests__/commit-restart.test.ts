/**
 * Commit-before-callback and terminal-before-cleanup reconciliation.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { digestJson, retentionCandidateFromPrepared } from "../prepare.js";
import type { WorkerInput } from "../schemas/memory.js";
import { MemoryStore } from "../store.js";

describe("commit restart reconciliation", () => {
  it("commit_idempotent_across_store_reopen", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ot-commit-"));
    const store = new MemoryStore(workspace);
    const prepared: WorkerInput = {
      version: 1,
      requestId: "call-1",
      tool: "offload",
      source: {
        version: 1,
        workspaceId: store.workspaceId,
        callerSessionId: "caller",
        originTurnId: "turn-1",
        originCompletionId: "comp-1",
        invocationId: "call-1",
        callIndex: 0,
        slices: [
          {
            ref: {
              sessionId: "caller",
              turnId: "turn-1",
              completionId: "comp-1",
              entityId: "call-1",
              field: "tool-result",
              start: 0,
              end: 4,
            },
            text: "note",
            digest: digestJson("note"),
          },
        ],
        marker: { wireName: "offload", argsJson: "{}" },
        truncated: false,
        digest: digestJson("note"),
      },
      task: { guidance: "note" },
    };
    const digest = digestJson(prepared);
    const candidate = retentionCandidateFromPrepared(prepared, "call-1");
    const first = store.commit("call-1", digest, "rev-1", candidate);
    expect(first.kind).toBe("retained");

    const replay = store.commit("call-1", digest, "rev-1", candidate);
    expect(replay).toEqual(first);

    expect(() => store.commit("call-1", "other-digest", "rev-1", candidate)).toThrow(/digest conflict/);

    const evidence = store.readCommit("call-1");
    expect(evidence?.requestId).toBe("call-1");
    expect(evidence?.episodeIds.length).toBeGreaterThan(0);

    store.close();
    const store2 = new MemoryStore(workspace);
    expect(store2.readCommit("call-1")?.requestId).toBe("call-1");
    store2.close();
    rmSync(workspace, { recursive: true, force: true });
  });
});
