/**
 * Toolkit wire projection over a kernel tool catalog.
 * Catalog class is `read` | `write` | `effect` | `meta`. Approval is the orchestrator
 * hook, not this file.
 */
import type { KernelToolCatalog } from "./tool-table.js";

/** Wire name. Catalog class is `effect`. */
export const SHELL_TOOL_NAME = "shell";

export interface OpenAiTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export function openAiTools(catalog: KernelToolCatalog): readonly OpenAiTool[] {
  return catalog
    .catalogEntries()
    .filter((entry) => entry.representation === "tool" || entry.representation === "both")
    .map((e) => ({
      type: "function" as const,
      function: {
        name: e.wireName,
        description: e.description,
        parameters: e.parameters,
      },
    }));
}
