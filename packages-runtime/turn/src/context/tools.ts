/**
 * Completion tools[] face: frozen turn.tools when present, else live catalog.
 * Vendor OpenAI wrapping stays in the actor. Live-catalog scheme_repl
 * description overlay is also the actor — frozen ToolSpec text is left as-is.
 */
import {
  AGENT_RESPOND,
  ApprovableJob,
  CompletionExpectation,
  owningTurn,
  SessionRoot,
} from "@inhuman.tools/harness-model";
import invariant from "tiny-invariant";

import { catalogOf, KernelToolCatalog } from "../tool-catalog/index.js";

export type ContextTool = {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
};

export function liveCatalogOf(
  expectation: CompletionExpectation,
  catalog?: KernelToolCatalog,
): KernelToolCatalog | undefined {
  return catalog ?? catalogOf(expectation.plexus?.root);
}

/** Frozen turn set wins so MCP churn cannot rewrite the prefix. */
export function selectCompletionTools(
  expectation: CompletionExpectation,
  catalog?: KernelToolCatalog,
): readonly ContextTool[] {
  const root = expectation.plexus?.root;
  invariant(root instanceof SessionRoot, "selectCompletionTools: expectation must be wired on a SessionRoot");
  if (expectation.completionMode === "isolated") return [];
  if (expectation.parent instanceof ApprovableJob) return [];
  const turn = owningTurn(expectation);
  const live = liveCatalogOf(expectation, catalog);
  const base =
    turn != null && turn.tools.entries.length > 0
      ? turn.tools.entries.map((entry) => {
          const parameters = entry.parameters ?? {};
          return {
            name: entry.name,
            description: entry.description,
            parameters,
          };
        })
      : live === undefined
        ? []
        : live
            .catalogEntries()
            .filter((entry) => entry.representation === "tool" || entry.representation === "both")
            .map((entry) => ({
              name: entry.wireName,
              description: entry.description,
              parameters: entry.parameters,
            }));
  const rest = base.filter((tool) => tool.name !== AGENT_RESPOND);
  return receivesCalls(root) ? [...rest, AGENT_RESPOND_TOOL] : rest;
}

/**
 * `agent__respond` is in tools[] for every round of a session that has taken a call, with
 * one fixed schema and text. The open request ids are not in it: tools[] is the head of the
 * cached prefix, and a tool that appears with the first open call, lists its ids and vanishes
 * with the last would rewrite the whole prefix each time. The ids reach the model in the
 * round's system note instead (`callbackRequiredNote`), after the cached part.
 */
const AGENT_RESPOND_TOOL: ContextTool = {
  name: AGENT_RESPOND,
  description:
    "Complete an open worker call. requestId must be one of the open ids listed in the system note. Not assistant text.",
  parameters: {
    type: "object",
    properties: {
      requestId: { type: "string", description: "Open call to settle" },
      response: { type: "string", description: "Reply that settles the call" },
    },
    required: ["requestId", "response"],
    additionalProperties: false,
  },
};

/** The session was ever asked: a call is open now, or an inbound call turn is on the tail. */
function receivesCalls(root: SessionRoot): boolean {
  if (root.openCallbackCount > 0) return true;
  for (const turn of root.liveTurns) if (turn.inbound || turn.agentRequestId !== "") return true;
  return false;
}
