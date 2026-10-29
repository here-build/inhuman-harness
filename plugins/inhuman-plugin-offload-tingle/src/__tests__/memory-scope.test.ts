/**
 * Workspace isolation and session core revision rules.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { digestJson, retentionCandidateFromPrepared } from "../prepare.js";
import type { WorkerInput } from "../schemas/memory.js";
import { MemoryStore } from "../store.js";

function preparedFor(workspaceId: string, requestId: string, text: string): WorkerInput {
  return {
    version: 1,
    requestId,
    tool: "offload",
    source: {
      version: 1,
      workspaceId,
      callerSessionId: "session-a",
      originTurnId: "turn",
      originCompletionId: "comp",
      invocationId: requestId,
      callIndex: 0,
      slices: [
        {
          ref: {
            sessionId: "session-a",
            turnId: "turn",
            completionId: "comp",
            entityId: requestId,
            field: "tool-result",
            start: 0,
            end: text.length,
          },
          text,
          digest: digestJson(text),
        },
      ],
      marker: { wireName: "offload", argsJson: "{}" },
      truncated: false,
      digest: digestJson(text),
    },
    task: { guidance: text },
  };
}

describe("memory scope", () => {
  it("two_sessions_two_workspaces_and_stale_core_revision", () => {
    const wsA = mkdtempSync(join(tmpdir(), "ot-a-"));
    const wsB = mkdtempSync(join(tmpdir(), "ot-b-"));
    const storeA = new MemoryStore(wsA);
    const storeB = new MemoryStore(wsB);
    expect(storeA.workspaceId).not.toBe(storeB.workspaceId);

    const preparedA = preparedFor(storeA.workspaceId, "req-a", "alpha");
    storeA.commit("req-a", digestJson(preparedA), "rev", retentionCandidateFromPrepared(preparedA, "req-a"));
    const preparedB = preparedFor(storeB.workspaceId, "req-b", "beta");
    storeB.commit("req-b", digestJson(preparedB), "rev", retentionCandidateFromPrepared(preparedB, "req-b"));

    expect(storeA.readCommit("req-b")).toBeNull();
    expect(storeB.readCommit("req-a")).toBeNull();

    const sessionA2 = new MemoryStore(wsA);
    expect(sessionA2.readCommit("req-a")?.requestId).toBe("req-a");
    sessionA2.close();

    storeA.commit(`core-${"1"}`, digestJson({ core: 1 }), "rev", {
      episode: null,
      facts: [],
      core: {
        expectedRevision: 0,
        next: {
          scopeSessionId: "session-a",
          body: "core v1",
          sourceRequestId: "req-a",
          citations: [],
        },
      },
      emptyReason: null,
    });
    expect(storeA.getCore("session-a")?.revision).toBe(1);
    expect(() =>
      storeA.commit("core-2", digestJson({}), "rev", {
        episode: null,
        facts: [],
        core: {
          expectedRevision: 0,
          next: {
            scopeSessionId: "session-a",
            body: "stale",
            sourceRequestId: "req-a",
            citations: [],
          },
        },
        emptyReason: null,
      }),
    ).toThrow(/stale core revision/);

    storeA.close();
    storeB.close();
    rmSync(wsA, { recursive: true, force: true });
    rmSync(wsB, { recursive: true, force: true });
  });
});
