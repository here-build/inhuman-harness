import { z } from "zod";

/**
 * Update Lanes (`LiveShape`) and Unified Plane Wire Frame definitions.
 * Covers durable reactive table shapes (`shape/*`), ephemeral seat/look
 * presence (`presence/*`), mid-round live streaming (`stream/delta`),
 * and transport keepalive (`ping` / `pong`).
 */

export const UPDATE_LANE_NAMES = [
  "kernel_meta",
  "scope_nodes",
  "session_nodes",
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

export const scopeNodesLaneParams = z.object({
  scopeId: z.string().trim().min(1, "scopeId is required"),
});
export const scopeNodesLaneParamsSchema = scopeNodesLaneParams;
export type ScopeNodesLaneParams = z.infer<typeof scopeNodesLaneParams>;

export const sessionNodesLaneParams = z.object({
  sessionId: z.string().trim().min(1, "sessionId is required"),
});
export const sessionNodesLaneParamsSchema = sessionNodesLaneParams;
export type SessionNodesLaneParams = z.infer<typeof sessionNodesLaneParams>;

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
  scope_nodes: ScopeNodesLaneParams;
  session_nodes: SessionNodesLaneParams;
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

export const scopeNodesSubscribeFrameSchema = z.object({
  kind: z.literal("shape/subscribe"),
  subscriptionId: z.string().trim().min(1),
  lane: z.literal("scope_nodes"),
  params: scopeNodesLaneParams,
  offset: z.number().int().nonnegative().optional(),
});
export type ScopeNodesSubscribeFrame = z.infer<typeof scopeNodesSubscribeFrameSchema>;

export const sessionNodesSubscribeFrameSchema = z.object({
  kind: z.literal("shape/subscribe"),
  subscriptionId: z.string().trim().min(1),
  lane: z.literal("session_nodes"),
  params: sessionNodesLaneParams,
  offset: z.number().int().nonnegative().optional(),
});
export type SessionNodesSubscribeFrame = z.infer<typeof sessionNodesSubscribeFrameSchema>;

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
  scopeNodesSubscribeFrameSchema,
  sessionNodesSubscribeFrameSchema,
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

/** Ephemeral presence entry tuple `[clientId, state | null, clock?]`. */
export const presenceEntryTupleSchema = z.union([
  z.tuple([z.number().int(), z.record(z.string(), z.unknown()).nullable()]),
  z.tuple([z.number().int(), z.record(z.string(), z.unknown()).nullable(), z.number().int().nonnegative()]),
]);
export type PresenceEntryTuple = z.infer<typeof presenceEntryTupleSchema>;

export const presenceUpdateFrameSchema = z.object({
  kind: z.literal("presence/update"),
  room: z.string().trim().min(1).optional(),
  entries: z.array(presenceEntryTupleSchema),
});
export type PresenceUpdateFrame = z.infer<typeof presenceUpdateFrameSchema>;

export const presenceStateFrameSchema = z.object({
  kind: z.literal("presence/state"),
  room: z.string().trim().min(1).optional(),
  entries: z.array(presenceEntryTupleSchema),
});
export type PresenceStateFrame = z.infer<typeof presenceStateFrameSchema>;

export const presenceQueryFrameSchema = z.object({
  kind: z.literal("presence/query"),
  room: z.string().trim().min(1).optional(),
});
export type PresenceQueryFrame = z.infer<typeof presenceQueryFrameSchema>;

export const presenceFrameSchema = z.discriminatedUnion("kind", [
  presenceUpdateFrameSchema,
  presenceStateFrameSchema,
  presenceQueryFrameSchema,
]);
export type PresenceFrame = z.infer<typeof presenceFrameSchema>;

/**
 * Ephemeral mid-round live streaming frame (assistant text/thought tokens &
 * running shell stdout/stderr tails). Avoids 60Hz SQLite WAL / ElectricSQL churn;
 * durable rows commit at round/effect/ask/turn boundaries.
 */
export const streamDeltaFrameSchema = z.object({
  kind: z.literal("stream/delta"),
  sessionId: z.string().trim().min(1),
  channel: z.enum(["assistant", "shell"]),
  targetId: z.string().trim().min(1),
  text: z.string().optional(),
  thought: z.string().optional(),
  tail: z.string().optional(),
  byteOffset: z.number().int().nonnegative().optional(),
  done: z.boolean().optional(),
});
export type StreamDeltaFrame = z.infer<typeof streamDeltaFrameSchema>;

export const pingFrameSchema = z.object({
  kind: z.literal("ping"),
  ts: z.number().optional(),
});
export type PingFrame = z.infer<typeof pingFrameSchema>;

export const pongFrameSchema = z.object({
  kind: z.literal("pong"),
  ts: z.number().optional(),
});
export type PongFrame = z.infer<typeof pongFrameSchema>;

export const planeWireFrameSchema = z.union([
  shapeFrameSchema,
  presenceFrameSchema,
  streamDeltaFrameSchema,
  pingFrameSchema,
  pongFrameSchema,
]);
export type PlaneWireFrame = z.infer<typeof planeWireFrameSchema>;
