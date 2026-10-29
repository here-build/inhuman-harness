import { z } from "zod";

export const connectionStatusSchema = z.enum(["idle", "connecting", "ready", "needs-auth", "failed", "disabled"]);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

export const connectionListRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  driver: z.string(),
  abilityClaim: z.array(z.string()),
  enabled: z.boolean(),
  status: connectionStatusSchema,
  toolCount: z.number(),
  error: z.string(),
});
export type ConnectionListRow = z.infer<typeof connectionListRowSchema>;

export const connectionGetRowSchema = connectionListRowSchema.extend({
  settings: z.record(z.string(), z.unknown()),
});
export type ConnectionGetRow = z.infer<typeof connectionGetRowSchema>;

export const listConnectionsInput = z.object({
  abilityClaim: z.string().optional(),
});
export const listConnectionsOutput = z.object({
  connections: z.array(connectionListRowSchema),
});

export const getConnectionInput = z.object({
  id: z.string().trim().min(1, "id is required"),
});
export const getConnectionOutput = connectionGetRowSchema;

export const connectModelsInput = z.object({
  id: z.string().trim().min(1).optional(),
});
export const connectModelsRowSchema = z.object({
  id: z.string(),
  models: z.array(z.string()),
  error: z.string(),
});
export const connectModelsOutput = z.object({
  connections: z.array(connectModelsRowSchema),
});
export type ConnectModelsRow = z.infer<typeof connectModelsRowSchema>;

export const setEnabledInput = z.object({
  id: z.string().trim().min(1, "id is required"),
  enabled: z.boolean(),
});
export const setEnabledOutput = z.object({ ok: z.boolean() });

export const persistToolInput = z.object({
  id: z.string().trim().min(1, "id is required"),
  tool: z.string().trim().min(1, "tool is required"),
});
export const persistToolOutput = z.object({ ok: z.literal(true) });

export const loginInput = z.object({
  id: z.string().trim().min(1, "id is required"),
});
export const loginOutput = z.object({ ok: z.boolean() });

export const logoutInput = z.object({
  id: z.string().trim().min(1, "id is required"),
});
export const logoutOutput = z.object({ ok: z.literal(true) });
