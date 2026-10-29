/**
 * Source cut from plugin context, and the deterministic retention candidate builder.
 */
import { createHash } from "node:crypto";

import type { PluginCallContext } from "@inhuman.tools/plugin-sdk";

import { type RetentionCandidate, type SourceCut, sourceCutSchema, type WorkerInput } from "./schemas/memory.js";
import { workspaceId } from "./workspace.js";

export function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function readUuid(value: unknown): string {
  if (value != null && typeof value === "object" && "uuid" in value) {
    const id = (value as { uuid?: unknown }).uuid;
    return typeof id === "string" ? id : "";
  }
  return "";
}

export function sourceFromContext(ctx: PluginCallContext, markerWireName: string, argsJson: string): SourceCut {
  const pinned = sourceCutSchema.safeParse(ctx.source);
  if (pinned.success) return pinned.data;
  return buildSourceCut(ctx, markerWireName, argsJson);
}

export function buildSourceCut(ctx: PluginCallContext, markerWireName: string, argsJson: string): SourceCut {
  const callerSessionId = typeof ctx.callerSessionId === "string" ? ctx.callerSessionId : readUuid(ctx.invocation);
  const slices = [
    {
      ref: {
        sessionId: callerSessionId,
        turnId: readUuid(ctx.turn),
        completionId: readUuid(ctx.completion),
        entityId: readUuid(ctx.invocation),
        field: "tool-result" as const,
        start: 0,
        end: argsJson.length,
      },
      text: argsJson,
      digest: digestJson(argsJson),
    },
  ];
  const root = typeof ctx.root === "string" && ctx.root.trim() !== "" ? ctx.root : process.cwd();
  return {
    version: 1,
    workspaceId: workspaceId(root),
    callerSessionId,
    originTurnId: readUuid(ctx.turn),
    originCompletionId: readUuid(ctx.completion),
    invocationId: readUuid(ctx.invocation),
    callIndex: 0,
    slices,
    marker: { wireName: markerWireName, argsJson },
    truncated: false,
    digest: digestJson(slices),
  };
}

/** Deterministic writer path: one episode from prepared input without an LLM. */
export function retentionCandidateFromPrepared(prepared: WorkerInput, requestId: string): RetentionCandidate {
  if (prepared.tool !== "offload") {
    return { episode: null, facts: [], core: null, emptyReason: "not_offload" };
  }
  const text = prepared.source.slices
    .map((slice) => slice.text)
    .join("\n")
    .trim();
  if (text === "") {
    return { episode: null, facts: [], core: null, emptyReason: "empty_source" };
  }
  return {
    episode: {
      requestId,
      workspaceId: prepared.source.workspaceId,
      sourceDigest: prepared.source.digest,
      slices: prepared.source.slices,
    },
    facts: [
      {
        body: text.slice(0, 500),
        validAt: Date.now(),
        invalidAt: null,
        supersedesId: null,
        confidence: 1,
        citations: prepared.source.slices.map((slice) => slice.ref),
        tags: ["deterministic"],
      },
    ],
    core: null,
    emptyReason: null,
  };
}
