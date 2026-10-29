/**
 * Plain-text projections of the tape: identity lines, work-cell faces, Scheme receipts, liveness.
 * The TUI paints from these and the headless eval client prints them. No quickdraw.
 */
export * from "./format-shell.js";
export * from "./identity.js";
export * from "./liveness.js";
export * from "./mcp-identity.js";
export * from "./pretty-identity.js";
export * from "./sugarcoat.js";
export * from "./unwrap-program.js";
export * from "./work-text.js";

// `identity.ts` widens the agent-cover context under the same name, so agent-cover is exported by name.
export {
  agentAskStackedBody,
  agentCoverPrompt,
  agentCoverVerb,
  agentExpandBlock,
  agentRecipeDescription,
  agentSpecKey,
  formatAgentCoverAnnotation,
  formatAskAgentWho,
  formatWaitingForAgents,
  STDLIB_AGENT_DESCRIPTIONS,
  titleAgentSpec,
  type AgentCoverVerb,
  type CoverAskContext as AgentCoverAskContext,
} from "./agent-cover.js";
