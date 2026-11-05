import { z } from "zod";

/**
 * Update Lanes (`LiveShape`) contract definitions.
 * Defines the windowed and filtered reactive query lanes that clients can
 * subscribe to for the Roster & Control Plane.
 */

export const UPDATE_LANE_NAMES = [
  "kernel_meta",
  "active_sessions",
  "recent_sessions",
  "child_sessions",
  "pending_asks",
] as const;

export const updateLaneNameSchema = z.enum(UPDATE_LANE_NAMES);
export type UpdateLaneName = z.infer<typeof updateLaneNameSchema>;

export const kernelMetaLaneParams = z.object({}).strict();
export const kernelMetaLaneParamsSchema = kernelMetaLaneParams;
export type KernelMetaLaneParams = z.infer<typeof kernelMetaLaneParams>;

export const activeSessionsLaneParams = z.object({
  workspacePath: z.string().trim().min(1).optional(),
});
export const activeSessionsLaneParamsSchema = activeSessionsLaneParams;
export type ActiveSessionsLaneParams = z.infer<typeof activeSessionsLaneParams>;

export const recentSessionsLaneParams = z.object({
  workspacePath: z.string().trim().min(1).optional(),
  limit: z.number().int().positive(),
  beforeMs: z.number().int().nonnegative().optional(),
});
export const recentSessionsLaneParamsSchema = recentSessionsLaneParams;
export type RecentSessionsLaneParams = z.infer<typeof recentSessionsLaneParams>;

export const childSessionsLaneParams = z.object({
  parentSessionId: z.string().trim().min(1, "parentSessionId is required"),
});
export const childSessionsLaneParamsSchema = childSessionsLaneParams;
export type ChildSessionsLaneParams = z.infer<typeof childSessionsLaneParams>;

export const pendingAsksLaneParams = z.object({
  sessionId: z.string().trim().min(1).optional(),
});
export const pendingAsksLaneParamsSchema = pendingAsksLaneParams;
export type PendingAsksLaneParams = z.infer<typeof pendingAsksLaneParams>;

export type UpdateLaneParamsMap = {
  kernel_meta: KernelMetaLaneParams;
  active_sessions: ActiveSessionsLaneParams;
  recent_sessions: RecentSessionsLaneParams;
  child_sessions: ChildSessionsLaneParams;
  pending_asks: PendingAsksLaneParams;
};

export const kernelMetaSubscribeFrameSchema = z.object({
  kind: z.literal("shape/subscribe"),
  subscriptionId: z.string().trim().min(1),
  lane: z.literal("kernel_meta"),
  params: kernelMetaLaneParams.default({}),
  offset: z.number().int().nonnegative().optional(),
});
export type KernelMetaSubscribeFrame = z.infer<typeof kernelMetaSubscribeFrameSchema>;

export const activeSessionsSubscribeFrameSchema = z.object({
  kind: z.literal("shape/subscribe"),
  subscriptionId: z.string().trim().min(1),
  lane: z.literal("active_sessions"),
  params: activeSessionsLaneParams.default({}),
  offset: z.number().int().nonnegative().optional(),
});
export type ActiveSessionsSubscribeFrame = z.infer<typeof activeSessionsSubscribeFrameSchema>;

export const recentSessionsSubscribeFrameSchema = z.object({
  kind: z.literal("shape/subscribe"),
  subscriptionId: z.string().trim().min(1),
  lane: z.literal("recent_sessions"),
  params: recentSessionsLaneParams,
  offset: z.number().int().nonnegative().optional(),
});
export type RecentSessionsSubscribeFrame = z.infer<typeof recentSessionsSubscribeFrameSchema>;

export const childSessionsSubscribeFrameSchema = z.object({
  kind: z.literal("shape/subscribe"),
  subscriptionId: z.string().trim().min(1),
  lane: z.literal("child_sessions"),
  params: childSessionsLaneParams,
  offset: z.number().int().nonnegative().optional(),
});
export type ChildSessionsSubscribeFrame = z.infer<typeof childSessionsSubscribeFrameSchema>;

export const pendingAsksSubscribeFrameSchema = z.object({
  kind: z.literal("shape/subscribe"),
  subscriptionId: z.string().trim().min(1),
  lane: z.literal("pending_asks"),
  params: pendingAsksLaneParams.default({}),
  offset: z.number().int().nonnegative().optional(),
});
export type PendingAsksSubscribeFrame = z.infer<typeof pendingAsksSubscribeFrameSchema>;

export const shapeSubscribeFrameSchema = z.discriminatedUnion("lane", [
  kernelMetaSubscribeFrameSchema,
  activeSessionsSubscribeFrameSchema,
  recentSessionsSubscribeFrameSchema,
  childSessionsSubscribeFrameSchema,
  pendingAsksSubscribeFrameSchema,
]);
export type ShapeSubscribeFrame = z.infer<typeof shapeSubscribeFrameSchema>;

export const shapeUnsubscribeFrameSchema = z.object({
  kind: z.literal("shape/unsubscribe"),
  subscriptionId: z.string().trim().min(1),
});
export type ShapeUnsubscribeFrame = z.infer<typeof shapeUnsubscribeFrameSchema>;

export const shapeDeltaFrameSchema = z.object({
  kind: z.literal("shape/delta"),
  subscriptionId: z.string().trim().min(1),
  offset: z.number().int().nonnegative(),
  upserts: z.array(z.record(z.string(), z.unknown())),
  deletes: z.array(z.string()),
  reset: z.boolean().optional(),
});
export type ShapeDeltaFrame = z.infer<typeof shapeDeltaFrameSchema>;

export const shapeFrameSchema = z.union([
  shapeSubscribeFrameSchema,
  shapeUnsubscribeFrameSchema,
  shapeDeltaFrameSchema,
]);
export type ShapeFrame = z.infer<typeof shapeFrameSchema>;
