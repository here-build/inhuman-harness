/**
 * Glance-sized sitting-ask question. Family + optional description.
 * Not pretty-mcp interpolation — command/path stay off KernelRoot.
 */
import {
  AgentMessageJob,
  type ApprovableJob,
  BotCallJob,
  CallJob,
  clampChars,
  flattenOverviewLine,
  GLANCE_ASK_DESCRIPTION_MAX_CHARS,
  GLANCE_ASK_LINE_MAX_CHARS,
  MCPToolJob,
  ToolCallJob,
} from "@inhuman.tools/harness-model";

export function glanceAskLine(head: ApprovableJob | null): string {
  if (head == null) return "";
  if (!(head instanceof ToolCallJob)) return "";
  const args = head.args;
  const description =
    args != null && typeof args.description === "string"
      ? flattenOverviewLine(args.description, GLANCE_ASK_DESCRIPTION_MAX_CHARS)
      : "";
  if (description !== "") return clampChars(`approve ${description}?`, GLANCE_ASK_LINE_MAX_CHARS);
  if (head instanceof BotCallJob) return "confirm bot?";
  if (head instanceof CallJob || head instanceof AgentMessageJob) return "confirm agent?";
  if (head instanceof MCPToolJob) {
    const tool = head.serverToolName.trim() || head.name.trim();
    return tool === "" ? "" : clampChars(`confirm ${tool}?`, GLANCE_ASK_LINE_MAX_CHARS);
  }
  const name = head.name.trim();
  if (name === "shell") return "confirm shell command?";
  if (name === "edit_file") return "confirm edit?";
  if (name === "write_file") return "confirm write?";
  if (name === "") return "";
  return clampChars(`confirm ${name}?`, GLANCE_ASK_LINE_MAX_CHARS);
}
