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

export type UiChoiceDef = {
  readonly kind: "choice";
  readonly name?: string;
  readonly description?: string;
  readonly annotation?: string;
  readonly alias?: readonly string[];
  readonly healthStatus?: "ok" | "degraded" | "failed";
  readonly healthAnnotation?: string;
  readonly hotkey?: string;
  readonly action?: readonly UiDefinition[];
  readonly alternateActions?: readonly UiDefinition[];
  readonly choices?: readonly UiDefinition[];
  readonly secret?: boolean;
  readonly context?: "connect" | "model" | "mcp" | "goal" | "plan";
};

export type UiActionDef = {
  readonly kind: "action";
  readonly op: string;
  readonly name?: string;
  readonly description?: string;
  readonly hotkey?: string;
  readonly alias?: readonly string[];
  readonly params?: Readonly<Record<string, unknown>>;
};

export type UiConfirmDef = {
  readonly kind: "confirm";
  readonly title?: string;
  readonly name?: string;
  readonly description?: string;
};

export type UiInputDef = {
  readonly kind: "input";
  readonly name?: string;
  readonly description?: string;
  readonly secret?: boolean;
};

export type UiOpenUrlDef = {
  readonly kind: "open-url";
  readonly url: string;
  readonly name?: string;
  readonly description?: string;
  readonly input?: "text" | "password";
};

export type UiNoticeDef = {
  readonly kind: "notice";
  readonly message?: string;
  readonly name?: string;
  readonly description?: string;
};

export type UiDefinition =
  | UiChoiceDef
  | UiActionDef
  | UiConfirmDef
  | UiInputDef
  | UiOpenUrlDef
  | UiNoticeDef;

export const uiDefinitionSchema: z.ZodType<UiDefinition> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("choice"),
      name: z.string().optional(),
      description: z.string().optional(),
      annotation: z.string().optional(),
      alias: z.array(z.string()).optional(),
      healthStatus: z.enum(["ok", "degraded", "failed"]).optional(),
      healthAnnotation: z.string().optional(),
      hotkey: z.string().optional(),
      action: z.array(uiDefinitionSchema).optional(),
      alternateActions: z.array(uiDefinitionSchema).optional(),
      choices: z.array(uiDefinitionSchema).optional(),
      secret: z.boolean().optional(),
      context: z.enum(["connect", "model", "mcp", "goal", "plan"]).optional(),
    }),
    z.object({
      kind: z.literal("action"),
      op: z.string().min(1),
      name: z.string().optional(),
      description: z.string().optional(),
      hotkey: z.string().optional(),
      alias: z.array(z.string()).optional(),
      params: z.record(z.string(), z.unknown()).optional(),
    }),
    z.object({
      kind: z.literal("confirm"),
      title: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
    }),
    z.object({
      kind: z.literal("input"),
      name: z.string().optional(),
      description: z.string().optional(),
      secret: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("open-url"),
      url: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      input: z.enum(["text", "password"]).optional(),
    }),
    z.object({
      kind: z.literal("notice"),
      message: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
    }),
  ]),
);

export function encodeUiDefinition(def: UiDefinition): string {
  return JSON.stringify(def);
}

export function parseUiDefinition(raw: string): UiDefinition | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = uiDefinitionSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
