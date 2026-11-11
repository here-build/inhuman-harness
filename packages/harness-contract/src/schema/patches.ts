import { z } from "zod";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Object.values(value).every(isJsonValue)
  );
}

/** Validate JSON values without rewriting object keys or Unicode escape sequences. */
export const jsonValueSchema = z.custom<JsonValue>(isJsonValue);

function recordOf<T>(entry: z.ZodType<T>): z.ZodType<Record<string, T>> {
  return z.custom<Record<string, T>>(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every((item: unknown) => entry.safeParse(item).success),
  );
}

/** Self-contained `@inhuman.tools/model` `SerializedModelRow` stored in `session_nodes.row_json` and `scope_nodes.row_json`. */
export const storedModelRowSchema = z.object({
  uuid: z.string(),
  tag: z.string(),
  columns: recordOf(jsonValueSchema),
  state: recordOf(jsonValueSchema),
  refs: recordOf(z.string().nullable()),
  refLists: recordOf(z.array(z.string())),
  children: recordOf(z.string().nullable()),
  childLists: recordOf(z.array(z.string())),
  childRecords: recordOf(recordOf(z.string())),
});
export type StoredModelRow = z.infer<typeof storedModelRowSchema>;

/**
 * Session Trajectory Patch & Snapshot protocol contract definitions.
 */

export type SerializedNode = {
  readonly id: string;
  readonly tag: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children?: Readonly<Record<string, readonly SerializedNode[] | SerializedNode | null>>;
};

export const serializedNodeSchema: z.ZodType<SerializedNode> = z.lazy(() =>
  z.object({
    id: z.string().trim().min(1),
    tag: z.string().trim().min(1),
    props: z.record(z.string(), z.unknown()).default({}),
    children: z
      .record(
        z.string(),
        z.union([z.lazy(() => serializedNodeSchema), z.array(z.lazy(() => serializedNodeSchema)), z.null()]),
      )
      .optional(),
  }),
);

export const serializedSessionDocumentSchema = z.object({
  sessionId: z.string().trim().min(1),
  revision: z.number().int().nonnegative(),
  root: serializedNodeSchema,
  createdAtMs: z.number().int().optional(),
});
export type SerializedSessionDocument = z.infer<typeof serializedSessionDocumentSchema>;

export const modelPatchSetSchema = z.object({
  op: z.literal("set"),
  encoding: z.literal("rows-v1").optional(),
  nodeId: z.string().trim().min(1),
  field: z.string().trim().min(1),
  key: z.string().optional(),
  value: z.unknown(),
});
export type ModelPatchSet = z.infer<typeof modelPatchSetSchema>;

export const modelPatchSpliceSchema = z.object({
  op: z.literal("splice"),
  encoding: z.literal("rows-v1").optional(),
  nodeId: z.string().trim().min(1),
  field: z.string().trim().min(1),
  index: z.number().int().nonnegative(),
  deleteCount: z.number().int().nonnegative(),
  items: z.array(z.unknown()).default([]),
});
export type ModelPatchSplice = z.infer<typeof modelPatchSpliceSchema>;

export const modelPatchDelSchema = z.object({
  op: z.literal("del"),
  nodeId: z.string().trim().min(1),
  field: z.string().trim().min(1),
  key: z.string().optional(),
});
export type ModelPatchDel = z.infer<typeof modelPatchDelSchema>;

export const modelPatchChildInsertSchema = z.object({
  op: z.literal("child-insert"),
  nodeId: z.string().trim().min(1),
  field: z.string().trim().min(1),
  index: z.number().int().nonnegative().optional(),
  child: z.lazy(() => serializedNodeSchema),
});
export type ModelPatchChildInsert = z.infer<typeof modelPatchChildInsertSchema>;

export const modelPatchChildRemoveSchema = z.object({
  op: z.literal("child-remove"),
  nodeId: z.string().trim().min(1),
  field: z.string().trim().min(1),
  childId: z.string().trim().min(1),
  index: z.number().int().nonnegative().optional(),
});
export type ModelPatchChildRemove = z.infer<typeof modelPatchChildRemoveSchema>;

export const modelPatchSchema = z.discriminatedUnion("op", [
  modelPatchSetSchema,
  modelPatchSpliceSchema,
  modelPatchDelSchema,
  modelPatchChildInsertSchema,
  modelPatchChildRemoveSchema,
]);
export type ModelPatch = z.infer<typeof modelPatchSchema>;

export const sessionPatchBatchSchema = z.object({
  sessionId: z.string().trim().min(1),
  fromRevision: z.number().int().nonnegative(),
  toRevision: z.number().int().nonnegative(),
  patches: z.array(modelPatchSchema),
  incarnation: z.string().optional(),
  createdAtMs: z.number().int().optional(),
});
export type SessionPatchBatch = z.infer<typeof sessionPatchBatchSchema>;

export const sessionAttachFrameSchema = z.object({
  kind: z.literal("session/attach"),
  sessionId: z.string().trim().min(1),
  sinceRevision: z.number().int().nonnegative().optional(),
});
export type SessionAttachFrame = z.infer<typeof sessionAttachFrameSchema>;

export const sessionDetachFrameSchema = z.object({
  kind: z.literal("session/detach"),
  sessionId: z.string().trim().min(1),
});
export type SessionDetachFrame = z.infer<typeof sessionDetachFrameSchema>;

export const sessionSnapshotFrameSchema = z.object({
  kind: z.literal("session/snapshot"),
  sessionId: z.string().trim().min(1),
  revision: z.number().int().nonnegative(),
  snapshot: serializedSessionDocumentSchema,
});
export type SessionSnapshotFrame = z.infer<typeof sessionSnapshotFrameSchema>;

export const sessionPatchFrameSchema = z.object({
  kind: z.literal("session/patch"),
  sessionId: z.string().trim().min(1),
  fromRevision: z.number().int().nonnegative(),
  toRevision: z.number().int().nonnegative(),
  patches: z.array(modelPatchSchema),
});
export type SessionPatchFrame = z.infer<typeof sessionPatchFrameSchema>;

export const sessionSyncFrameSchema = z.discriminatedUnion("kind", [
  sessionSnapshotFrameSchema,
  sessionPatchFrameSchema,
]);
export type SessionSyncFrame = z.infer<typeof sessionSyncFrameSchema>;

export const sessionFrameSchema = z.discriminatedUnion("kind", [
  sessionAttachFrameSchema,
  sessionDetachFrameSchema,
  sessionSnapshotFrameSchema,
  sessionPatchFrameSchema,
]);
export type SessionFrame = z.infer<typeof sessionFrameSchema>;
