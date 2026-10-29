/**
 * Drop ask flags from the message bag so dumps stay message-only.
 */
import { asSystemPrompt, type SystemPrompt } from "@inhuman.tools/harness-commons";
import { parseJsonRecord } from "@inhuman.tools/harness-model/json-record";
import { agentCallBagSchema, requestIdBagSchema } from "@inhuman.tools/harness-model/schemas";
import { reasoningEffortOf, type ReasoningEffort } from "@inhuman.tools/harness-model/session";

const EMPTY_PEEL = {
  voidLegal: true,
  readonly: false,
  responseSchema: null,
  oneShot: false,
  constitution: asSystemPrompt(""),
  faceName: "",
  tools: [] as const,
  inheritCallerTools: false,
  reasoningEffort: null,
};

const PEELED_KEYS = [
  "voidLegal",
  "readonly",
  "responseSchema",
  "responseSchemaJson",
  "oneShot",
  "constitution",
  "name",
  "tools",
  "inheritCallerTools",
  "reasoningEffort",
] as const;

function responseSchemaOf(rec: {
  readonly responseSchemaJson?: unknown;
  readonly responseSchema?: unknown;
}): Record<string, unknown> | null {
  const text =
    typeof rec.responseSchemaJson === "string"
      ? rec.responseSchemaJson
      : typeof rec.responseSchema === "string"
        ? rec.responseSchema
        : null;
  if (text != null) {
    const trimmed = text.trim();
    return trimmed === "" ? null : parseJsonRecord(trimmed);
  }
  if (rec.responseSchema == null || typeof rec.responseSchema !== "object" || Array.isArray(rec.responseSchema)) {
    return null;
  }
  return parseJsonRecord(JSON.stringify(rec.responseSchema));
}

export function peelAgentCallArgs(argsJson: string): {
  readonly argsJson: string;
  readonly voidLegal: boolean;
  readonly readonly: boolean;
  readonly responseSchema: Record<string, unknown> | null;
  readonly oneShot: boolean;
  readonly constitution: SystemPrompt;
  readonly faceName: string;
  readonly tools: readonly string[];
  readonly inheritCallerTools: boolean;
  readonly reasoningEffort: ReasoningEffort | null;
} {
  const parsed = agentCallBagSchema.safeParse(parseJsonRecord(argsJson === "" ? "{}" : argsJson));
  if (!parsed.success) return { argsJson, ...EMPTY_PEEL };
  const rec = parsed.data;
  const rest: Record<string, unknown> = { ...rec };
  for (const key of PEELED_KEYS) delete rest[key];
  const tools = Array.isArray(rec.tools)
    ? rec.tools.filter((row): row is string => typeof row === "string" && row.trim() !== "").map((row) => row.trim())
    : [];
  return {
    argsJson: JSON.stringify(rest),
    voidLegal: rec.voidLegal !== false,
    readonly: rec.readonly === true,
    responseSchema: responseSchemaOf(rec),
    oneShot: rec.oneShot === true,
    constitution: asSystemPrompt(typeof rec.constitution === "string" ? rec.constitution : ""),
    faceName: typeof rec.name === "string" ? rec.name.trim() : "",
    tools,
    inheritCallerTools: rec.inheritCallerTools === true,
    reasoningEffort: reasoningEffortOf(rec.reasoningEffort),
  };
}

export function requestIdOf(argsJson: unknown): string {
  const parsed = requestIdBagSchema.safeParse(argsJson);
  return parsed.success ? (parsed.data.requestId ?? "") : "";
}
