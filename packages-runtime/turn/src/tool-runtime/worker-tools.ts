/**
 * Worker tool ceiling. The one implementation: the session view and admit/execute both call it.
 * Bot-granted MCP and private plugin MCP are answered by the catalog's `workerHost`.
 */
import {
  AGENT_ASK,
  AGENT_MESSAGE,
  AGENT_NOTIFY,
  AGENT_RESPOND,
  AGENT_SEND,
  AGENT_VOID,
  AskAgentSpec,
  SCHEME_REPL_TOOL_NAME,
  SCHEME_WATCH_TOOL_NAME,
  SessionRoot,
} from "@inhuman.tools/harness-model";

import { behaviorEntriesOf, catalogTriggersReactLoop, type KernelToolCatalog } from "../tool-catalog/index.js";

function isAgentComms(wire: string): boolean {
  return (
    wire === AGENT_RESPOND ||
    wire === AGENT_VOID ||
    wire === AGENT_NOTIFY ||
    wire === AGENT_MESSAGE ||
    wire === AGENT_SEND ||
    wire === AGENT_ASK
  );
}

function askWorkerToolAllowed(catalog: KernelToolCatalog, wire: string): boolean {
  if (wire === AGENT_VOID) return false;
  return (
    wire === SCHEME_REPL_TOOL_NAME ||
    wire === SCHEME_WATCH_TOOL_NAME ||
    catalog.catalogEntry(wire)?.isSideChannel === true ||
    isAgentComms(wire)
  );
}

export function workerToolAllowed(
  catalog: KernelToolCatalog,
  recipeName: string,
  wire: string,
  sessionRoot?: SessionRoot,
): boolean {
  const spec = sessionRoot?.agent.spec;
  if (spec instanceof AskAgentSpec) {
    if (wire === AGENT_VOID) return spec.voidLegal === true;
    if (behaviorEntriesOf(sessionRoot).some((entry) => entry.wireName === wire)) return true;
    if (spec.inheritCallerTools) return true;
    if (askWorkerToolAllowed(catalog, wire)) return true;
    if (spec.tools?.includes(wire) === true) return true;
    if (spec.name === "" || spec.toolsOnly) return false;
    const named = catalog.recipe(spec.name);
    if (named == null) return false;
    return catalog.workerHost.recipeGrantsWire(catalog, named.spec, wire, sessionRoot?.path ?? "");
  }
  if (wire === AGENT_VOID && spec?.voidLegal === false) return false;
  if (recipeName === "") return true;
  if (behaviorEntriesOf(sessionRoot).some((entry) => entry.wireName === wire)) return true;
  const recipe = catalog.recipe(recipeName);
  if (recipe == null) return false;
  if (catalog.privateWorkerEntries.some((row) => row.wireName === wire)) return true;
  const entry = catalog.catalogEntry(wire);
  if (entry == null) return catalog.workerHost.privateWireAllowed(recipeName, wire, sessionRoot);
  if (
    wire === SCHEME_REPL_TOOL_NAME ||
    wire === SCHEME_WATCH_TOOL_NAME ||
    !catalogTriggersReactLoop(catalog, wire) ||
    isAgentComms(wire)
  ) {
    return true;
  }
  return catalog.workerHost.recipeGrantsWire(catalog, recipe.spec, wire, sessionRoot?.path ?? "");
}
