/**
 * What a workflow's crossing tells its graph card. A program verb (`agent/*`,
 * `bot/*`, a tool) sets it as the trace invocation's metadata when it starts, so
 * the card reads its inputs while the call is still out.
 */
export type WorkflowLeafMeta = {
  readonly kind: "agent" | "bot" | "tool";
  /** The verb the program called: `agent/call`, `bot/ask`, `mcp/call`, `read_file`, a pack tool. */
  readonly verb: string;
  /** The worker spec, the bot, or the tool's wire name. */
  readonly name: string;
  readonly model?: string;
  readonly message?: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly background?: boolean;
  /** The inner job that carries the call's outcome on the session document. */
  readonly jobId?: string;
};

export function isWorkflowLeafMeta(meta: unknown): meta is WorkflowLeafMeta {
  if (typeof meta !== "object" || meta === null) return false;
  const { kind, verb, name } = meta as Record<string, unknown>;
  return (
    (kind === "agent" || kind === "bot" || kind === "tool") && typeof verb === "string" && typeof name === "string"
  );
}
