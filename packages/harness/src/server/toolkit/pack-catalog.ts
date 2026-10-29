/**
 * Pack fill of the one tool table (enabled plugins).
 * Types + set; storage is tool-table.ts.
 */
import type { ExamAdmit, ToolDefinition } from "@inhuman.tools/plugin-sdk";

import type { CatalogEntry, PackToolMeta } from "@/tool-catalog";

import { type KernelToolCatalog } from "./tool-table.js";

export type PackToolHandle = {
  readonly pluginName: string;
  readonly name: string;
  readonly description: string;
  /** Catalog class: `read` | `write` | `effect`. */
  readonly class: string;
  readonly representation?: "tool" | "symbol" | "both";
  /** JSON Schema for model tools[] parameters. */
  readonly parameters: Record<string, unknown>;
  readonly meta: PackToolMeta;
  readonly tool: ToolDefinition;
  readonly execute?: (
    raw: unknown,
    ctx: {
      root?: string;
      signal?: AbortSignal;
      sessionId?: string;
      turn?: unknown;
      completion?: unknown | null;
      invocation?: unknown;
    },
  ) => Promise<unknown>;
  readonly triggersReactLoop?: boolean;
  readonly isSideChannel?: boolean;
  readonly tapeHidden?: boolean;
  readonly exam?: ExamAdmit;
};

/** Replace the user-pack half of the unified catalog. Host plugins re-seed. */
export function setPackToolCatalog(catalog: KernelToolCatalog, handles: readonly PackToolHandle[]): void {
  const entries: CatalogEntry[] = handles.map((h) => ({
    wireName: h.name,
    description: h.description,
    parameters: h.parameters,
    class: h.class,
    representation: h.representation,
    source: { kind: "pack" as const, pluginName: h.pluginName },
    execute: h.execute,
    packMeta: h.meta,
    triggersReactLoop: h.triggersReactLoop,
    isSideChannel: h.isSideChannel,
    tapeHidden: h.tapeHidden,
    exam: h.exam,
  }));
  catalog.replacePack(entries);
}
