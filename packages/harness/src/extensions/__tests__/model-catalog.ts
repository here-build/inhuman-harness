import type { Registry } from "../value.js";

/** Model-visible tools. Procedures and state methods stay out of the catalog. */
export function modelCatalog(registry: Registry): readonly {
  readonly name: string;
  readonly description: string;
  readonly class: string;
  readonly triggersReactLoop: boolean;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}[] {
  return [...registry.tools.values()]
    .filter((tool) => tool.expose === "tool" || tool.expose === "both")
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      class: tool.toolClass,
      triggersReactLoop: tool.triggersReactLoop,
      inputSchema: tool.input?.json ?? { type: "object" },
    }));
}
