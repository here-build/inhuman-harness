/**
 * Memory row and MCP tool contracts (§4.2–4.3, §7).
 */
import { z } from "zod";

export const sourceRefSchema = z.object({
  sessionId: z.string(),
  turnId: z.string(),
  completionId: z.string(),
  entityId: z.string(),
  field: z.enum(["prompt", "response", "tool-result"]),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

export const sourceSliceSchema = z.object({
  ref: sourceRefSchema,
  text: z.string(),
  digest: z.string(),
});

export const sourceCutSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string(),
  callerSessionId: z.string(),
  originTurnId: z.string(),
  originCompletionId: z.string(),
  invocationId: z.string(),
  callIndex: z.number().int().nonnegative(),
  slices: z.array(sourceSliceSchema),
  marker: z.object({ wireName: z.string(), argsJson: z.string() }),
  truncated: z.boolean(),
  digest: z.string(),
});

export const workerInputSchema = z.object({
  version: z.literal(1),
  requestId: z.string(),
  tool: z.enum(["offload", "tingle"]),
  source: sourceCutSchema,
  task: z.union([z.object({ guidance: z.string().optional() }), z.object({ prompt: z.string() })]),
});

export const memoryCommitRowSchema = z.object({
  requestId: z.string(),
  inputDigest: z.string(),
  contributionRevision: z.string(),
  kind: z.enum(["retained", "empty"]),
  episodeIds: z.array(z.string()),
  factIds: z.array(z.string()),
  coreRevision: z.number().nullable(),
  reason: z.string().nullable(),
  committedAt: z.number(),
});

export const episodeRowSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  workspaceId: z.string(),
  sourceDigest: z.string(),
  slices: z.array(sourceSliceSchema),
  createdAt: z.number(),
});

export const factRowSchema = z.object({
  id: z.string(),
  episodeId: z.string(),
  body: z.string(),
  validAt: z.number(),
  invalidAt: z.number().nullable(),
  recordedAt: z.number(),
  supersedesId: z.string().nullable(),
  confidence: z.number(),
  citations: z.array(sourceRefSchema),
  tags: z.array(z.string()),
});

export const coreRowSchema = z.object({
  scopeSessionId: z.string(),
  revision: z.number().int().nonnegative(),
  body: z.string(),
  sourceRequestId: z.string(),
  citations: z.array(sourceRefSchema),
});

export const retentionCandidateSchema = z.object({
  episode: z
    .object({
      requestId: z.string(),
      workspaceId: z.string(),
      sourceDigest: z.string(),
      slices: z.array(sourceSliceSchema),
    })
    .nullable(),
  facts: z.array(
    z.object({
      body: z.string(),
      validAt: z.number(),
      invalidAt: z.number().nullable(),
      supersedesId: z.string().nullable(),
      confidence: z.number(),
      citations: z.array(sourceRefSchema),
      tags: z.array(z.string()),
    }),
  ),
  core: z
    .object({
      expectedRevision: z.number().int().nonnegative(),
      next: z.object({
        scopeSessionId: z.string(),
        body: z.string(),
        sourceRequestId: z.string(),
        citations: z.array(sourceRefSchema),
      }),
    })
    .nullable(),
  emptyReason: z.string().nullable(),
});

export const citedPackSchema = z.object({
  snapshotRevision: z.number(),
  items: z.array(
    z.object({
      factId: z.string().optional(),
      episodeId: z.string(),
      snippet: z.string(),
      validAt: z.number(),
      invalidAt: z.number().nullable(),
      citations: z.array(sourceRefSchema),
    }),
  ),
  tokenCount: z.number(),
});

export const findInputSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().max(50).default(10),
});

export const readInputSchema = z.object({
  episodeId: z.string(),
});

export const commitInputSchema = z.object({
  requestId: z.string(),
  inputDigest: z.string(),
  contributionRevision: z.string().optional(),
  candidate: retentionCandidateSchema,
});

export const readCommitInputSchema = z.object({
  requestId: z.string(),
});

export const getCoreInputSchema = z.object({
  scopeSessionId: z.string(),
});

export type SourceRef = z.infer<typeof sourceRefSchema>;
export type SourceSlice = z.infer<typeof sourceSliceSchema>;
export type SourceCut = z.infer<typeof sourceCutSchema>;
export type WorkerInput = z.infer<typeof workerInputSchema>;
export type MemoryCommitRow = z.infer<typeof memoryCommitRowSchema>;
export type EpisodeRow = z.infer<typeof episodeRowSchema>;
export type FactRow = z.infer<typeof factRowSchema>;
export type CoreRow = z.infer<typeof coreRowSchema>;
export type RetentionCandidate = z.infer<typeof retentionCandidateSchema>;
export type CitedPack = z.infer<typeof citedPackSchema>;

export const offloadInputSchema = z.object({
  guidance: z.string().max(2000).optional(),
});

export const tingleInputSchema = z.object({
  prompt: z.string().max(2000),
});

export const retentionResultSchema = z.union([
  z.object({ kind: z.literal("retained"), commit: memoryCommitRowSchema }),
  z.object({ kind: z.literal("empty"), commit: memoryCommitRowSchema }),
]);

export const recallResultSchema = z.union([
  z.object({ kind: z.literal("hit"), pack: citedPackSchema }),
  z.object({ kind: z.literal("miss"), reason: z.string() }),
]);
