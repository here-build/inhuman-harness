import { z } from "zod";

import { argsJsonValue } from "./json-record.js";

export const agentCallBagSchema = z
  .object({
    voidLegal: z.unknown().optional(),
    readonly: z.unknown().optional(),
    oneShot: z.unknown().optional(),
    constitution: z.unknown().optional(),
    name: z.unknown().optional(),
    tools: z.unknown().optional(),
    inheritCallerTools: z.unknown().optional(),
    reasoningEffort: z.unknown().optional(),
    responseSchemaJson: z.unknown().optional(),
    responseSchema: z.unknown().optional(),
  })
  .passthrough();

export const requestIdBagSchema = z.preprocess(
  argsJsonValue,
  z
    .object({
      requestId: z.string().optional(),
    })
    .passthrough(),
);
