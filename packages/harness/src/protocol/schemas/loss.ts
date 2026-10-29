import { z } from "zod";

export const lockKindSchema = z.enum(["root", "runtime"]);
export type LockKind = z.infer<typeof lockKindSchema>;

export const lossKindSchema = z.enum([
  "data-disconnected",
  "parent-lost",
  "process-exited",
  "heartbeat-missing",
  "lock-released",
]);
export type LossKind = z.infer<typeof lossKindSchema>;

/**
 * Accumulated facts about a previous owner. Heartbeat-missing and
 * data-disconnected are not death. Parent-lost does not release a live lock.
 */
export const ownerEvidenceSchema = z
  .object({
    exitConfirmed: z.boolean(),
    lockReleased: z.boolean(),
    parentLost: z.boolean(),
    dataDisconnected: z.boolean(),
    heartbeatMissing: z.boolean(),
  })
  .strict();
export type OwnerEvidence = z.infer<typeof ownerEvidenceSchema>;

export const shutdownCutoffSchema = z
  .object({
    admission: z.literal("refused"),
    drain: z.enum(["pending", "complete"]),
    flush: z.enum(["pending", "ok", "failed"]),
    forced: z.boolean(),
  })
  .strict();
export type ShutdownCutoff = z.infer<typeof shutdownCutoffSchema>;

export const replacementRefuseReasonSchema = z.enum([
  "heartbeat-is-not-death",
  "disconnect-is-not-death",
  "parent-loss-holds-runtime-lock",
  "exit-unconfirmed",
  "lock-held",
]);
export type ReplacementRefuseReason = z.infer<typeof replacementRefuseReasonSchema>;

export const replacementDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("replace") }).strict(),
  z
    .object({
      action: z.literal("refuse"),
      reason: replacementRefuseReasonSchema,
    })
    .strict(),
]);
export type ReplacementDecision = z.infer<typeof replacementDecisionSchema>;
