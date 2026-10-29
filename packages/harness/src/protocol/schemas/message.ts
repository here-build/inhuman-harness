import { z } from "zod";

import { publishedReadiness } from "./descriptor.js";
import { publishedHealthSchema, type PublishedHealth } from "./health.js";
import { supervisionIdentitySchema, type SupervisionIdentity } from "./identity.js";
import { lockKindSchema, lossKindSchema, shutdownCutoffSchema } from "./loss.js";

export const SUPERVISION_PROTOCOL_VERSION = 1 as const;

const envelope = {
  v: z.literal(SUPERVISION_PROTOCOL_VERSION),
  identity: supervisionIdentitySchema,
};

function refineChildHealth(
  message: { identity: SupervisionIdentity; health: PublishedHealth },
  ctx: z.RefinementCtx,
): void {
  const kind = message.identity.process.kind;
  const allowed = new Set(kind === "yjs" || kind === "runtime" ? publishedReadiness(kind) : []);
  const present = (["sync", "storage", "execution"] as const).filter((plane) => message.health[plane] != null);
  if (present.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "child health requires a published plane",
      path: ["health"],
    });
  }
  for (const plane of present) {
    if (!allowed.has(plane)) {
      ctx.addIssue({
        code: "custom",
        message: `${kind} must not report ${plane}`,
        path: ["health", plane],
      });
    }
  }
}

const readyMessageSchema = z
  .object({
    ...envelope,
    op: z.literal("ready"),
    health: publishedHealthSchema,
  })
  .strict()
  .superRefine(refineChildHealth);

const failedMessageSchema = z
  .object({
    ...envelope,
    op: z.literal("failed"),
    health: publishedHealthSchema,
    reason: z.string().min(1),
  })
  .strict()
  .superRefine(refineChildHealth);

const healthMessageSchema = z
  .object({
    ...envelope,
    op: z.literal("health"),
    health: publishedHealthSchema,
  })
  .strict()
  .superRefine(refineChildHealth);

const shutdownMessageSchema = z
  .object({
    ...envelope,
    op: z.literal("shutdown"),
    deadlineMs: z.number().int().positive(),
  })
  .strict();

const stoppedMessageSchema = z
  .object({
    ...envelope,
    op: z.literal("stopped"),
    cutoff: shutdownCutoffSchema,
  })
  .strict();

const lossMessageSchema = z
  .object({
    ...envelope,
    op: z.literal("loss"),
    kind: lossKindSchema,
    lock: lockKindSchema.optional(),
  })
  .strict()
  .superRefine((message, ctx) => {
    if (message.kind === "lock-released" && message.lock == null) {
      ctx.addIssue({
        code: "custom",
        message: "lock-released loss requires lock",
        path: ["lock"],
      });
    }
    if (message.kind !== "lock-released" && message.lock != null) {
      ctx.addIssue({
        code: "custom",
        message: "lock is only valid on lock-released",
        path: ["lock"],
      });
    }
  });

/** Control IPC. Unknown `op` / `v` is fatal, not a dropped frame. */
export const supervisionMessageSchema = z.discriminatedUnion("op", [
  readyMessageSchema,
  failedMessageSchema,
  healthMessageSchema,
  shutdownMessageSchema,
  stoppedMessageSchema,
  lossMessageSchema,
]);
export type SupervisionMessage = z.infer<typeof supervisionMessageSchema>;
export type SupervisionOp = SupervisionMessage["op"];
