import { z } from "zod";

/** Independent planes. A bound socket is not a kind and is not execution ready. */
export const readinessKindSchema = z.enum(["sync", "storage", "execution"]);
export type ReadinessKind = z.infer<typeof readinessKindSchema>;

export const healthStateSchema = z.enum([
  "starting",
  "ready",
  "unresponsive",
  "disconnected",
  "recovering",
  "degraded",
  "failed",
]);
export type HealthState = z.infer<typeof healthStateSchema>;

export const planeStatusSchema = z
  .object({
    state: healthStateSchema,
    reason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((plane, ctx) => {
    if ((plane.state === "degraded" || plane.state === "failed") && plane.reason == null) {
      ctx.addIssue({
        code: "custom",
        message: "degraded/failed health requires reason",
        path: ["reason"],
      });
    }
  });
export type PlaneStatus = z.infer<typeof planeStatusSchema>;

/** Hypervisor-aggregated snapshot. Child frames use `publishedHealthSchema`. */
export const topologyHealthSchema = z
  .object({
    sync: planeStatusSchema,
    storage: planeStatusSchema,
    execution: planeStatusSchema,
  })
  .strict();
export type TopologyHealth = z.infer<typeof topologyHealthSchema>;

/** Planes a child actually publishes. Missing keys are not asserted. */
export const publishedHealthSchema = z
  .object({
    sync: planeStatusSchema.optional(),
    storage: planeStatusSchema.optional(),
    execution: planeStatusSchema.optional(),
  })
  .strict();
export type PublishedHealth = z.infer<typeof publishedHealthSchema>;
