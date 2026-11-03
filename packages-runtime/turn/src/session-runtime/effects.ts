import { z } from "zod";

export type SessionEffectRequest = {
  readonly sessionId: string;
  readonly operationId: string;
  readonly incarnation: string;
  readonly method: string;
  readonly payload: string;
};

export const sessionEffectOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("success"), payload: z.string() }),
  z.object({ kind: z.literal("refused"), message: z.string() }),
  z.object({ kind: z.literal("unknown"), message: z.string() }),
]);

export type SessionEffectOutcome = z.infer<typeof sessionEffectOutcomeSchema>;

export type SessionEffectPort = {
  invoke(request: SessionEffectRequest, signal: AbortSignal): Promise<SessionEffectOutcome>;
  reconcile?(request: SessionEffectRequest, signal: AbortSignal): Promise<SessionEffectOutcome>;
};

const requestSchema = z.object({
  sessionId: z.string(),
  operationId: z.string(),
  incarnation: z.string(),
  method: z.string(),
  payload: z.string(),
});

export const effectRecordSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("intent"), request: requestSchema }),
  z.object({ phase: z.literal("result"), request: requestSchema, outcome: sessionEffectOutcomeSchema }),
]);
