/**
 * Named-agent catalog: comms projections.
 * The roster lives on the builtin tools. This file keeps the worker prompt.
 * No execute bodies — mint is the door.
 */
import { asUserPrompt, type UserPrompt } from "@inhuman.tools/harness-commons";

export { AGENT_COMMS_ENTRIES, NAMED_AGENTS_PLUGIN_NAME } from "@/builtin-tools";

export function renderBotCallWorkerPrompt(capability: string, prepared: unknown, requestId: string): UserPrompt {
  const body = typeof prepared === "string" ? prepared : prepared === undefined ? "" : JSON.stringify(prepared);
  return asUserPrompt(
    `Another agent is requesting *${capability}* with input ${body}; when done, respond with callback ${requestId}`,
  );
}
