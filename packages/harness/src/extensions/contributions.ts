import type { CatalogEntry } from "@/tool-catalog";

import { toolResultOf, type AgentBehavior } from "./host.js";

/**
 * Declared model tools of a pinned behavior, as catalog contributions.
 * The catalog does not import this package; composition registers the rows.
 */
export function declaredToolEntries(
  agent: AgentBehavior,
  occupied: (wireName: string) => boolean,
  errors: string[],
  turnId: () => string,
): CatalogEntry[] {
  return agent.tools(errors).flatMap(({ plugin, decl }): CatalogEntry[] => {
    if (occupied(decl.name)) {
      errors.push(`${plugin}: tool ${decl.name} collides with a host tool`);
      return [];
    }
    return [
      {
        wireName: decl.name,
        description: decl.description,
        parameters: { ...(decl.input?.json ?? { type: "object" }) },
        class: decl.toolClass,
        source: { kind: "pack", pluginName: plugin },
        triggersReactLoop: decl.triggersReactLoop,
        isSideChannel: decl.isSideChannel,
        representation: decl.representation,
        execute: async (raw) => toolResultOf(await agent.callTool(decl.name, raw, turnId())),
      },
    ];
  });
}
