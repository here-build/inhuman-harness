/** Closed recipe scope shared by kernel recipes and session specs. */

export type RecipeScope = "session" | "project" | "global";

/** Empty is a conversation or one-shot, not a recipe. */
export type AgentNature = "" | RecipeScope;

/** Unknown becomes empty, so a leftover conversation stays distinct from a session recipe. */
export function agentNatureOf(value: unknown): AgentNature {
  return value === "session" || value === "project" || value === "global" ? value : "";
}
