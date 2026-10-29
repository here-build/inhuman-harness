/**
 * Citation validation, fact revision, and bounded pack eligibility tests.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { refKey, retainedRefKeys } from "../extraction.js";
import { digestJson } from "../prepare.js";
import type { RetentionCandidate, SourceSlice, WorkerInput } from "../schemas/memory.js";
import { MemoryStore } from "../store.js";

function slice(text: string, entityId = "ent-1"): SourceSlice {
  return {
    ref: {
      sessionId: "session-a",
      turnId: "turn-1",
      completionId: "comp-1",
      entityId,
      field: "prompt",
      start: 0,
      end: text.length,
    },
    text,
    digest: digestJson(text),
  };
}

function prepared(requestId: string, sourceText: string): WorkerInput {
  const slices = [slice(sourceText)];
  return {
    version: 1,
    requestId,
    tool: "offload",
    source: {
      version: 1,
      workspaceId: "ws",
      callerSessionId: "session-a",
      originTurnId: "turn-1",
      originCompletionId: "comp-1",
      invocationId: requestId,
      callIndex: 0,
      slices,
      marker: { wireName: "offload", argsJson: "{}" },
      truncated: false,
      digest: digestJson(slices),
    },
    task: { guidance: sourceText },
  };
}

describe("extraction validation", () => {
  it("unsupported_claims_and_corrupt_packs_do_not_promote", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ot-extract-"));
    const store = new MemoryStore(workspace);
    const source = "alpha fact in source";
    const prep = prepared("req-1", source);
    prep.source.workspaceId = store.workspaceId;

    const goodRef = prep.source.slices[0]!.ref;
    const badRef = { ...goodRef, entityId: "missing-entity" };

    const retained = store.commit(`req-${"1"}`, digestJson(prep), "rev", {
      episode: {
        requestId: "req-1",
        workspaceId: store.workspaceId,
        sourceDigest: prep.source.digest,
        slices: prep.source.slices,
      },
      facts: [
        {
          body: "supported fact",
          validAt: Date.now(),
          invalidAt: null,
          supersedesId: null,
          confidence: 1,
          citations: [goodRef],
          tags: [],
        },
        {
          body: "unsupported fact",
          validAt: Date.now(),
          invalidAt: null,
          supersedesId: null,
          confidence: 1,
          citations: [badRef],
          tags: [],
        },
      ],
      core: null,
      emptyReason: null,
    });
    expect(retained.factIds).toHaveLength(1);

    const firstFactId = retained.factIds[0]!;
    store.commit("req-2", digestJson({ n: 2 }), "rev", {
      episode: {
        requestId: "req-2",
        workspaceId: store.workspaceId,
        sourceDigest: prep.source.digest,
        slices: prep.source.slices,
      },
      facts: [
        {
          body: "contradicts supported",
          validAt: Date.now(),
          invalidAt: null,
          supersedesId: firstFactId,
          confidence: 1,
          citations: [goodRef],
          tags: [],
        },
      ],
      core: null,
      emptyReason: null,
    });
    const pack = store.find("contradicts", 10);
    expect(pack.items.some((item) => item.factId === firstFactId)).toBe(false);

    const corruptPackCandidate: RetentionCandidate = {
      episode: {
        requestId: "req-3",
        workspaceId: store.workspaceId,
        sourceDigest: prep.source.digest,
        slices: prep.source.slices,
      },
      facts: [
        {
          body: "x".repeat(10_000),
          validAt: Date.now(),
          invalidAt: null,
          supersedesId: null,
          confidence: 1,
          citations: [goodRef],
          tags: [],
        },
      ],
      core: null,
      emptyReason: null,
    };
    store.commit("req-3", digestJson({ n: 3 }), "rev", corruptPackCandidate);
    expect(store.find("x", 10).items).toHaveLength(0);

    store.commit("core-1", digestJson({ core: 1 }), "rev", {
      episode: null,
      facts: [],
      core: {
        expectedRevision: 0,
        next: {
          scopeSessionId: "session-a",
          body: "core v1",
          sourceRequestId: "req-1",
          citations: [],
        },
      },
      emptyReason: null,
    });
    expect(() =>
      store.commit("core-2", digestJson({}), "rev", {
        episode: null,
        facts: [],
        core: {
          expectedRevision: 0,
          next: {
            scopeSessionId: "session-a",
            body: "stale core",
            sourceRequestId: "req-1",
            citations: [],
          },
        },
        emptyReason: null,
      }),
    ).toThrow(/stale core revision/);

    expect(retainedRefKeys(prep.source.slices).has(refKey(goodRef))).toBe(true);

    store.close();
    rmSync(workspace, { recursive: true, force: true });
  });
});
