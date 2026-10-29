import { z } from "zod";

/** `ui/resolve` payload minus `pending`. Closed union — extra keys fail. */
export const uiAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accept") }).strict(),
  z.object({ kind: z.literal("cancel") }).strict(),
  z.object({ kind: z.literal("text"), input: z.string() }).strict(),
  z.object({ kind: z.literal("opened"), url: z.string() }).strict(),
  z.object({ kind: z.literal("dismiss") }).strict(),
]);
export type UiAnswer = z.infer<typeof uiAnswerSchema>;

/** Parked `harness/open-url` result. `pending` may be absent on the contract park. */
export const uiParkSchema = z
  .object({
    form: z.literal("ui"),
    body: z.string().min(1),
  })
  .passthrough();

export const uiFormSchema = z
  .object({
    form: z.literal("ui"),
    body: z.string().min(1),
    pending: z.string().min(1),
  })
  .passthrough();

export type UiForm = {
  readonly form: "ui";
  readonly body: string;
  readonly pending: string;
};

export const jsonRpcId = z.union([z.string(), z.number(), z.null()]);
export type JsonRpcId = z.infer<typeof jsonRpcId>;

export const jsonRpcError = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcError = z.infer<typeof jsonRpcError>;

export const jsonRpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional(),
  id: jsonRpcId.optional(),
});
export type JsonRpcRequest = z.infer<typeof jsonRpcRequest>;

export const jsonRpcResponse = z.union([
  z.object({
    jsonrpc: z.literal("2.0"),
    id: jsonRpcId,
    error: jsonRpcError,
  }),
  z.object({
    jsonrpc: z.literal("2.0"),
    id: jsonRpcId,
    result: z.unknown(),
  }),
]);
export type JsonRpcResponse = z.infer<typeof jsonRpcResponse>;

export function isUiForm(value: unknown): value is UiForm {
  return uiFormSchema.safeParse(value).success;
}

/** `ui/resolve` envelope: the park id. The answer fields ride beside it (see {@link uiResolveInput}). */
export const uiResolvePending = z
  .object({
    pending: z.string().trim().min(1, "pending is required"),
  })
  .passthrough();

const pendingId = z.string().trim().min(1, "pending is required");

/** Full `ui/resolve` params: {@link uiAnswerSchema} plus the `pending` id. */
export const uiResolveInput = z.discriminatedUnion("kind", [
  z.object({ pending: pendingId, kind: z.literal("accept") }).strict(),
  z.object({ pending: pendingId, kind: z.literal("cancel") }).strict(),
  z.object({ pending: pendingId, kind: z.literal("text"), input: z.string() }).strict(),
  z.object({ pending: pendingId, kind: z.literal("opened"), url: z.string() }).strict(),
  z.object({ pending: pendingId, kind: z.literal("dismiss") }).strict(),
]);
export type UiResolveInput = z.infer<typeof uiResolveInput>;
