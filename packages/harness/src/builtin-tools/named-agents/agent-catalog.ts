/**
 * Named-agent catalog: comms projections, computed invoke DAG.
 * General bots go through `bot/send` / `bot/ask` — not per-recipe wrappers.
 * No execute bodies — mint is the door.
 */
import { asSystemPrompt, type SystemPrompt } from "@inhuman.tools/harness-commons";
import {
  AGENT_ASK,
  AGENT_MESSAGE,
  AGENT_NOTIFY,
  AGENT_RESPOND,
  AGENT_SEND,
  AGENT_VOID,
  reasoningEffortOf,
  type ReasoningEffort,
} from "@inhuman.tools/harness-model";
import { parseJsonRecord } from "@inhuman.tools/harness-model/json-record";
import { agentCallBagSchema } from "@inhuman.tools/harness-model/schemas";

import type { CatalogEntry, ToolRepresentation } from "@/tool-catalog";

export const NAMED_AGENTS_PLUGIN_NAME = "named-agents";

const PACK = { kind: "pack" as const, pluginName: NAMED_AGENTS_PLUGIN_NAME };

function projection(
  wireName: string,
  description: string,
  parameters: Record<string, unknown>,
  representation: ToolRepresentation,
): CatalogEntry {
  return { wireName, description, parameters, class: "effect", source: PACK, representation };
}

export const AGENT_COMMS_ENTRIES: readonly CatalogEntry[] = [
  projection(
    AGENT_RESPOND,
    "Complete an open agent call with a response.",
    {
      type: "object",
      properties: { requestId: { type: "string" }, response: { type: "string" } },
      required: ["requestId"],
    },
    "tool",
  ),
  projection(
    AGENT_VOID,
    "Complete an open agent call with no tape message.",
    {
      type: "object",
      properties: { requestId: { type: "string" } },
      required: ["requestId"],
    },
    "symbol",
  ),
  projection(
    AGENT_NOTIFY,
    "Yield a notification on an open agent call.",
    {
      type: "object",
      properties: { requestId: { type: "string" }, message: { type: "string" } },
      required: ["requestId", "message"],
    },
    "symbol",
  ),
  projection(
    AGENT_MESSAGE,
    "Send a message to a named or id-addressed agent.",
    {
      type: "object",
      properties: {
        targetName: { type: "string" },
        targetId: { type: "string" },
        message: { type: "string" },
      },
      required: ["message"],
    },
    "symbol",
  ),
  projection(
    AGENT_SEND,
    "Address a named worker; void or respond settles.",
    {
      type: "object",
      properties: {
        spec: { type: "string" },
        message: { type: "string" },
      },
      required: ["spec", "message"],
    },
    "symbol",
  ),
  projection(
    AGENT_ASK,
    "Ask a worker and wait for a response.",
    {
      type: "object",
      properties: {
        spec: { type: "string" },
        message: { type: "string" },
        responseSchema: { type: "object" },
      },
      required: ["message"],
    },
    "symbol",
  ),
];

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

/** Drop ask flags from the message bag so dumps stay message-only. */
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
